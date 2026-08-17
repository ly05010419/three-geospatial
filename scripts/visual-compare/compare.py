#!/usr/bin/env python3
"""A/B visual comparison of two screenshots (e.g. WebGL reference vs WebGPU).

Writes evidence images (diff heat map, signed diff, triptych, blink GIF) and
numeric metrics so a human or agent can judge whether two renders differ
visibly. Dependencies: Pillow + numpy only (no ImageMagick, no scipy).

Usage:
    python3 compare.py A.png B.png --out DIR [--roi x,y,w,h] [--gain 8]
                       [--label-a WebGL --label-b WebGPU] [--json]
    python3 compare.py --selftest

Exit codes: 0 success, 1 selftest failure, 2 usage error.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2

DEFAULT_GAIN = 8.0
CHANGE_THRESHOLDS = (8, 16, 32)   # max-channel |B-A| thresholds for changed_pct_*
BLOB_DIFF_THRESHOLD = 16          # pixels with max-channel |B-A| above this feed the blob mask
MAJORITY_MIN_COUNT = 5            # 3x3 window: keep a pixel only if >=5 of 9 are set
MAX_LABEL_ROUNDS = 256            # safety cap for union-find rounds (normally converges in <10)
NOISE_MAX_BLOB_PIXELS = 200       # verdict heuristic
NOISE_MAX_RMSE_HALF_PCT = 1.5     # verdict heuristic
HIST_BINS = 64
BLINK_FRAME_MS = 500
PANEL_MAX_WIDTH = 1200            # triptych panels wider than this are integer-downscaled
CAPTION_HEIGHT = 58
CAPTION_BG = (24, 24, 24)
HEAT_ORANGE = (255, 140, 0)
OUTPUT_FILES = ("diff.png", "diff_signed.png", "triptych.png", "blink.gif")


# --------------------------------------------------------------------------- CLI

class UsageError(Exception):
    """User-facing CLI mistake (missing file, bad --roi, ...). Exit code 2."""


class SelfTestFailure(Exception):
    """A --selftest assertion failed. Exit code 1."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="A/B compare two screenshots and write evidence images + metrics.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Usage:", 1)[1],
    )
    parser.add_argument("image_a", nargs="?", help="reference image A (PNG)")
    parser.add_argument("image_b", nargs="?", help="candidate image B (PNG)")
    parser.add_argument("--out", help="output directory (created if missing)")
    parser.add_argument("--roi", help="crop both images to x,y,w,h before comparing")
    parser.add_argument("--gain", type=float, default=DEFAULT_GAIN,
                        help=f"amplification for diff.png / diff_signed.png (default {DEFAULT_GAIN:g})")
    parser.add_argument("--label-a", default="A", help="caption label for image A")
    parser.add_argument("--label-b", default="B", help="caption label for image B")
    parser.add_argument("--json", action="store_true", help="also write metrics.json into --out")
    parser.add_argument("--selftest", action="store_true", help="run built-in self-test and exit")
    return parser


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def parse_roi(text: str) -> tuple[int, int, int, int]:
    parts = text.split(",")
    if len(parts) != 4:
        raise UsageError(f"--roi expects x,y,w,h (got {text!r})")
    try:
        x, y, w, h = (int(part.strip()) for part in parts)
    except ValueError:
        raise UsageError(f"--roi values must be integers (got {text!r})") from None
    if x < 0 or y < 0 or w <= 0 or h <= 0:
        raise UsageError(f"--roi needs x,y >= 0 and w,h > 0 (got {text!r})")
    return x, y, w, h


# --------------------------------------------------------------------------- loading

def load_rgb(path: str) -> np.ndarray:
    """Load an image as HxWx3 uint8 (alpha dropped)."""
    if not os.path.isfile(path):
        raise UsageError(f"input file not found: {path}")
    try:
        with Image.open(path) as img:
            return np.asarray(img.convert("RGB"))
    except (OSError, ValueError) as exc:
        raise UsageError(f"cannot read image {path}: {exc}") from None


def crop_roi(img: np.ndarray, roi: tuple[int, int, int, int], name: str) -> np.ndarray:
    x, y, w, h = roi
    height, width = img.shape[:2]
    if x + w > width or y + h > height:
        raise UsageError(f"--roi {roi} exceeds image {name} size {width}x{height}")
    return img[y:y + h, x:x + w]


def center_crop(img: np.ndarray, width: int, height: int) -> np.ndarray:
    y0 = (img.shape[0] - height) // 2
    x0 = (img.shape[1] - width) // 2
    return img[y0:y0 + height, x0:x0 + width]


def center_crop_common(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray, bool]:
    """Center-crop both arrays to their common minimum size. Returns (a, b, was_cropped)."""
    if a.shape == b.shape:
        return a, b, False
    height = min(a.shape[0], b.shape[0])
    width = min(a.shape[1], b.shape[1])
    return center_crop(a, width, height), center_crop(b, width, height), True


def pair_provenance(a: np.ndarray, cropped: bool) -> dict:
    return {"compared_size": [int(a.shape[1]), int(a.shape[0])], "center_cropped": cropped}


def load_pair(path_a: str, path_b: str, roi) -> tuple[np.ndarray, np.ndarray, dict]:
    """Load both images, apply the optional ROI, then center-crop to a common size."""
    a, b = load_rgb(path_a), load_rgb(path_b)
    info = {
        "input_a": path_a, "input_b": path_b,
        "size_a": [int(a.shape[1]), int(a.shape[0])],
        "size_b": [int(b.shape[1]), int(b.shape[0])],
        "roi": list(roi) if roi else None,
    }
    if roi:
        a, b = crop_roi(a, roi, "A"), crop_roi(b, roi, "B")
    a, b, cropped = center_crop_common(a, b)
    if cropped:
        warn(f"sizes differ ({info['size_a']} vs {info['size_b']}); "
             f"center-cropped both to {a.shape[1]}x{a.shape[0]}")
    return a, b, {**info, **pair_provenance(a, cropped)}


# --------------------------------------------------------------------------- metrics

def rmse_pct(a: np.ndarray, b: np.ndarray) -> float:
    diff = a.astype(np.float32) - b.astype(np.float32)
    return float(np.sqrt(np.mean(diff * diff)) / 255.0 * 100.0)


def downscale_half(img: np.ndarray) -> np.ndarray:
    """2x2 box downscale (float32). Images smaller than 2px stay as-is."""
    height, width = (img.shape[0] // 2) * 2, (img.shape[1] // 2) * 2
    if height == 0 or width == 0:
        return img.astype(np.float32)
    boxed = img[:height, :width].astype(np.float32)
    return boxed.reshape(height // 2, 2, width // 2, 2, 3).mean(axis=(1, 3))


def psnr_db(rmse_percent: float) -> float | None:
    """PSNR from RMSE in percent of 255. None means identical (infinite)."""
    if rmse_percent <= 0.0:
        return None
    return 20.0 * math.log10(100.0 / rmse_percent)


def max_channel_diff(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Per-pixel max over channels of |B-A|, uint8 HxW."""
    return np.abs(b.astype(np.int16) - a.astype(np.int16)).max(axis=2).astype(np.uint8)


def luminance(img: np.ndarray) -> np.ndarray:
    rgb = img.astype(np.float32)
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def luminance_hist_distance(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """(mean |hA-hB|, total variation) of 64-bin normalized grayscale histograms."""
    hist_a = np.histogram(luminance(a), bins=HIST_BINS, range=(0, 256))[0] / a[..., 0].size
    hist_b = np.histogram(luminance(b), bins=HIST_BINS, range=(0, 256))[0] / b[..., 0].size
    delta = np.abs(hist_a - hist_b)
    return float(delta.mean()), float(delta.sum() / 2.0)


def judge(metrics: dict) -> str:
    """Heuristic verdict: small blobs + low half-res RMSE => 'noise-only'."""
    noise_only = (metrics["largest_blob"]["pixels"] < NOISE_MAX_BLOB_PIXELS
                  and metrics["rmse_half_pct"] < NOISE_MAX_RMSE_HALF_PCT)
    return "noise-only" if noise_only else "structural differences present"


def compute_metrics(a: np.ndarray, b: np.ndarray) -> dict:
    """All numeric metrics for two same-shape HxWx3 uint8 arrays."""
    maxdiff = max_channel_diff(a, b)
    signed = b.astype(np.float32) - a.astype(np.float32)
    rmse_full = rmse_pct(a, b)
    hist_mean, hist_tv = luminance_hist_distance(a, b)
    channel_bias = signed.mean(axis=(0, 1))
    metrics = {
        "rmse_full_pct": round(rmse_full, 4),
        "rmse_half_pct": round(rmse_pct(downscale_half(a), downscale_half(b)), 4),
        "psnr_db": None if psnr_db(rmse_full) is None else round(psnr_db(rmse_full), 3),
        **{f"changed_pct_{t}": round(float((maxdiff > t).mean() * 100.0), 4)
           for t in CHANGE_THRESHOLDS},
        "mean_abs_diff": round(float(np.abs(signed).mean()), 4),
        "mean_signed_diff_rgb": {name: round(float(v), 4)
                                 for name, v in zip("rgb", channel_bias)},
        "largest_blob": analyze_largest_blob(maxdiff),
        "lum_hist_mean_abs_diff": round(hist_mean, 6),
        "lum_hist_tv": round(hist_tv, 5),
    }
    return {**metrics, "verdict": judge(metrics), "verdict_is_heuristic": True}


# --------------------------------------------------------------------------- blobs

def majority_filter_3x3(mask: np.ndarray) -> np.ndarray:
    """Erosion-like: keep set pixels whose 3x3 neighbourhood has >= MAJORITY_MIN_COUNT set."""
    height, width = mask.shape
    padded = np.pad(mask, 1).astype(np.uint8)
    count = sum(padded[dy:dy + height, dx:dx + width] for dy in range(3) for dx in range(3))
    return mask & (count >= MAJORITY_MIN_COUNT)


def build_edges(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Flat-index pairs (src, dst) of 8-connected set pixels; forward directions only."""
    height, width = mask.shape
    flat_index = np.arange(height * width).reshape(height, width)
    sources, targets = [], []
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        rows_a, rows_b = slice(0, height - dy), slice(dy, height)
        if dx >= 0:
            cols_a, cols_b = slice(0, width - dx), slice(dx, width)
        else:
            cols_a, cols_b = slice(-dx, width), slice(0, width + dx)
        both = mask[rows_a, cols_a] & mask[rows_b, cols_b]
        sources.append(flat_index[rows_a, cols_a][both])
        targets.append(flat_index[rows_b, cols_b][both])
    return np.concatenate(sources), np.concatenate(targets)


def compress_pointers(parent: np.ndarray) -> np.ndarray:
    """Pointer jumping until every entry points at a root."""
    while True:
        grand = parent[parent]
        if np.array_equal(grand, parent):
            return parent
        parent = grand


def label_components(mask: np.ndarray) -> tuple[np.ndarray, bool]:
    """8-connected labelling with a numpy union-find (min-label hooking + pointer jumping).

    Returns (root index per flat pixel, converged). Roots always point to strictly
    smaller indices, so no cycles; MAX_LABEL_ROUNDS is only a safety cap.
    """
    parent = np.arange(mask.size)
    src, dst = build_edges(mask)
    for _ in range(MAX_LABEL_ROUNDS):
        root_src, root_dst = parent[src], parent[dst]
        low, high = np.minimum(root_src, root_dst), np.maximum(root_src, root_dst)
        differs = low != high
        if not differs.any():
            return parent, True
        np.minimum.at(parent, high[differs], low[differs])
        parent = compress_pointers(parent)
    return parent, False


def analyze_largest_blob(maxdiff: np.ndarray) -> dict:
    """Largest 8-connected component of (maxdiff > threshold) after 3x3 majority filtering."""
    mask = majority_filter_3x3(maxdiff > BLOB_DIFF_THRESHOLD)
    members = np.flatnonzero(mask)
    result = {"pixels": 0, "bbox_x": 0, "bbox_y": 0, "bbox_w": 0, "bbox_h": 0,
              "components": 0, "mask_pixels": int(members.size), "converged": True}
    if members.size == 0:
        return result
    parent, converged = label_components(mask)
    _, inverse, counts = np.unique(parent[members], return_inverse=True, return_counts=True)
    biggest = int(np.argmax(counts))
    ys, xs = np.divmod(members[inverse == biggest], mask.shape[1])
    return {**result,
            "pixels": int(counts[biggest]),
            "bbox_x": int(xs.min()), "bbox_y": int(ys.min()),
            "bbox_w": int(xs.max() - xs.min() + 1), "bbox_h": int(ys.max() - ys.min() + 1),
            "components": int(counts.size), "converged": bool(converged)}


# --------------------------------------------------------------------------- rendering

def heat_ramp(t: np.ndarray) -> np.ndarray:
    """Map t in [0,1] (HxW) to RGB: black -> orange -> white."""
    black = np.zeros(3, np.float32)
    orange = np.array(HEAT_ORANGE, np.float32)
    white = np.full(3, 255.0, np.float32)
    lower = (t < 0.5)[..., None]
    s = np.where(lower, t[..., None] * 2.0, (t[..., None] - 0.5) * 2.0)
    start = np.where(lower, black, orange)
    end = np.where(lower, orange, white)
    return np.clip(start + (end - start) * s, 0, 255).astype(np.uint8)


def render_heat(maxdiff: np.ndarray, gain: float) -> Image.Image:
    t = np.clip(maxdiff.astype(np.float32) * gain / 255.0, 0.0, 1.0)
    return Image.fromarray(heat_ramp(t))


def render_signed(a: np.ndarray, b: np.ndarray, gain: float) -> Image.Image:
    """(B-A) * gain + 128 per channel: grey = equal, tint shows the bias direction."""
    signed = (b.astype(np.float32) - a.astype(np.float32)) * gain + 128.0
    return Image.fromarray(np.clip(signed, 0, 255).astype(np.uint8))


def load_font() -> ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=13)
    except TypeError:  # very old Pillow without the size argument
        return ImageFont.load_default()


def render_triptych(panels: list[Image.Image], labels: list[str],
                    summary: list[str]) -> Image.Image:
    """A | B | diff side by side under a caption bar; panels integer-downscaled if wide."""
    width = panels[0].size[0]
    factor = max(1, math.ceil(width / PANEL_MAX_WIDTH))
    scaled = [panel.reduce(factor) if factor > 1 else panel for panel in panels]
    panel_w, panel_h = scaled[0].size
    canvas = Image.new("RGB", (panel_w * len(scaled), panel_h + CAPTION_HEIGHT), CAPTION_BG)
    draw = ImageDraw.Draw(canvas)
    font = load_font()
    for i, (panel, label) in enumerate(zip(scaled, labels)):
        canvas.paste(panel, (i * panel_w, CAPTION_HEIGHT))
        draw.text((i * panel_w + 6, 4), label, fill=(255, 255, 255), font=font)
        if i > 0:
            draw.line([(i * panel_w, CAPTION_HEIGHT), (i * panel_w, canvas.size[1])],
                      fill=(255, 255, 255), width=1)
    for row, line in enumerate(summary):
        draw.text((6, 22 + row * 17), line, fill=(200, 200, 200), font=font)
    return canvas


def caption_lines(m: dict) -> tuple[list[str], list[str]]:
    blob = m["largest_blob"]
    psnr = "inf" if m["psnr_db"] is None else f"{m['psnr_db']:.2f}dB"
    labels = [f"A: {m['label_a']}", f"B: {m['label_b']}", f"|B-A| x{m['gain']:g}"]
    summary = [
        f"rmse_full {m['rmse_full_pct']:.3f}%  rmse_half {m['rmse_half_pct']:.3f}%  psnr {psnr}"
        f"  changed>16 {m['changed_pct_16']:.3f}%  mean_abs {m['mean_abs_diff']:.3f}",
        f"largest_blob {blob['pixels']}px ({blob['bbox_w']}x{blob['bbox_h']})"
        f"  hist_tv {m['lum_hist_tv']:.4f}  verdict(heuristic): {m['verdict']}",
    ]
    return labels, summary


def write_outputs(a: np.ndarray, b: np.ndarray, metrics: dict, out_dir: str) -> list[str]:
    """Write diff.png, diff_signed.png, triptych.png, blink.gif. Returns their paths."""
    gain = metrics["gain"]
    heat = render_heat(max_channel_diff(a, b), gain)
    img_a, img_b = Image.fromarray(a), Image.fromarray(b)
    labels, summary = caption_lines(metrics)
    heat.save(os.path.join(out_dir, "diff.png"))
    render_signed(a, b, gain).save(os.path.join(out_dir, "diff_signed.png"))
    render_triptych([img_a, img_b, heat], labels, summary).save(os.path.join(out_dir, "triptych.png"))
    img_a.save(os.path.join(out_dir, "blink.gif"), save_all=True, append_images=[img_b],
               duration=BLINK_FRAME_MS, loop=0)
    return [os.path.join(out_dir, name) for name in OUTPUT_FILES]


# --------------------------------------------------------------------------- reporting

def format_report(m: dict) -> str:
    blob, bias = m["largest_blob"], m["mean_signed_diff_rgb"]
    psnr = "inf" if m["psnr_db"] is None else f"{m['psnr_db']:.2f} dB"
    size = "{}x{}".format(*m["compared_size"]) + (" (center-cropped)" if m["center_cropped"] else "")
    rows = [
        ("compared size", size),
        ("rmse_full", f"{m['rmse_full_pct']:.3f} %"),
        ("rmse_half (50% box)", f"{m['rmse_half_pct']:.3f} %"),
        ("psnr", psnr),
        ("changed >8 / >16 / >32", "{:.3f} / {:.3f} / {:.3f} %".format(
            m["changed_pct_8"], m["changed_pct_16"], m["changed_pct_32"])),
        ("mean_abs_diff", f"{m['mean_abs_diff']:.3f} (0-255)"),
        ("mean signed B-A (r,g,b)", f"{bias['r']:+.3f}, {bias['g']:+.3f}, {bias['b']:+.3f}"),
        (f"largest_blob (>{BLOB_DIFF_THRESHOLD}, 3x3 majority)",
         f"{blob['pixels']} px, bbox {blob['bbox_w']}x{blob['bbox_h']} at "
         f"({blob['bbox_x']},{blob['bbox_y']}), {blob['components']} components"
         + ("" if blob["converged"] else ", NOT converged")),
        (f"lum hist ({HIST_BINS} bins)",
         f"mean|dA-dB| {m['lum_hist_mean_abs_diff']:.6f}, TV {m['lum_hist_tv']:.4f}"),
    ]
    width = max(len(key) for key, _ in rows)
    lines = [f"{key:<{width}}  {value}" for key, value in rows]
    lines.append(f"verdict [heuristic: blob<{NOISE_MAX_BLOB_PIXELS}px & "
                 f"rmse_half<{NOISE_MAX_RMSE_HALF_PCT}%]: {m['verdict']}")
    return "\n".join(lines)


def compare_and_write(a: np.ndarray, b: np.ndarray, out_dir: str, context: dict) -> dict:
    """context: label_a, label_b, gain, plus provenance keys (compared_size, ...)."""
    metrics = {**context, **compute_metrics(a, b)}
    write_outputs(a, b, metrics, out_dir)
    return metrics


def run_cli(args: argparse.Namespace) -> int:
    if not (args.image_a and args.image_b and args.out):
        raise UsageError("need A.png B.png --out DIR (or --selftest); see --help")
    if not args.gain > 0:
        raise UsageError(f"--gain must be > 0 (got {args.gain})")
    roi = parse_roi(args.roi) if args.roi else None
    a, b, provenance = load_pair(args.image_a, args.image_b, roi)
    context = {**provenance, "label_a": args.label_a, "label_b": args.label_b, "gain": args.gain}
    try:
        os.makedirs(args.out, exist_ok=True)
        metrics = compare_and_write(a, b, args.out, context)
        if args.json:
            with open(os.path.join(args.out, "metrics.json"), "w", encoding="utf-8") as fh:
                json.dump(metrics, fh, indent=2)
    except OSError as exc:
        raise UsageError(f"cannot write outputs to {args.out}: {exc}") from None
    print(format_report(metrics))
    written = list(OUTPUT_FILES) + (["metrics.json"] if args.json else [])
    print(f"outputs -> {args.out}: {', '.join(written)}")
    return EXIT_OK


# --------------------------------------------------------------------------- selftest

def check(condition: bool, message: str) -> None:
    if not condition:
        raise SelfTestFailure(message)


def make_gradient(width: int, height: int) -> np.ndarray:
    xs = np.linspace(0, 255, width, dtype=np.float32)[None, :]
    ys = np.linspace(0, 255, height, dtype=np.float32)[:, None]
    zeros = np.zeros((height, width), np.float32)
    return np.stack([xs + zeros, ys + zeros, (xs + ys) / 2.0], axis=2).astype(np.uint8)


def paint_disc(img: np.ndarray, cx: int, cy: int, radius: int, color) -> np.ndarray:
    ys, xs = np.ogrid[:img.shape[0], :img.shape[1]]
    inside = (xs - cx) ** 2 + (ys - cy) ** 2 <= radius * radius
    out = img.copy()
    out[inside] = color
    return out


def selftest_case(name: str, a: np.ndarray, b: np.ndarray, tmp: str) -> dict:
    out = os.path.join(tmp, name)
    os.makedirs(out)
    context = {**pair_provenance(a, False), "label_a": "A", "label_b": "B", "gain": DEFAULT_GAIN}
    metrics = compare_and_write(a, b, out, context)
    for filename in OUTPUT_FILES:
        check(os.path.getsize(os.path.join(out, filename)) > 0, f"{name}: {filename} missing/empty")
    blob = metrics["largest_blob"]
    print(f"[selftest:{name:>9}] rmse_full={metrics['rmse_full_pct']:.3f}% "
          f"rmse_half={metrics['rmse_half_pct']:.3f}% changed>16={metrics['changed_pct_16']:.3f}% "
          f"blob={blob['pixels']}px ({blob['bbox_w']}x{blob['bbox_h']}) verdict={metrics['verdict']}")
    return metrics


def selftest_images(tmp: str) -> None:
    base = paint_disc(make_gradient(320, 240), 160, 120, 30, (250, 40, 40))
    identical = selftest_case("identical", base, base.copy(), tmp)
    check(identical["rmse_full_pct"] == 0 and identical["rmse_half_pct"] == 0, "identical: rmse != 0")
    check(identical["psnr_db"] is None, "identical: psnr should be inf/None")
    check(all(identical[f"changed_pct_{t}"] == 0 for t in CHANGE_THRESHOLDS), "identical: changed != 0")
    check(identical["mean_abs_diff"] == 0 and identical["largest_blob"]["pixels"] == 0,
          "identical: residual diff")
    check(identical["verdict"] == "noise-only", "identical: verdict")

    rng = np.random.default_rng(42)
    noise = rng.integers(-3, 4, size=base.shape, dtype=np.int16)
    noisy = np.clip(base.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    noise_m = selftest_case("noise", base, noisy, tmp)
    check(noise_m["changed_pct_8"] == 0 and noise_m["largest_blob"]["pixels"] == 0, "noise: blob")
    check(0 < noise_m["rmse_full_pct"] < NOISE_MAX_RMSE_HALF_PCT, "noise: rmse range")
    check(noise_m["verdict"] == "noise-only", "noise: verdict")

    shifted = paint_disc(make_gradient(320, 240), 172, 120, 30, (250, 40, 40))
    shift_m = selftest_case("shifted", base, shifted, tmp)
    blob = shift_m["largest_blob"]
    check(blob["pixels"] >= NOISE_MAX_BLOB_PIXELS, "shifted: blob too small")
    check(130 <= blob["bbox_x"] and blob["bbox_x"] + blob["bbox_w"] <= 203, "shifted: blob bbox x")
    check(shift_m["changed_pct_32"] > 0 and shift_m["verdict"] == "structural differences present",
          "shifted: verdict")


def selftest_blob_labeler() -> None:
    mask = np.zeros((60, 80), dtype=bool)
    mask[5:15, 5:15] = True          # 100 px square -> 96 after majority filter (4 corners eroded)
    mask[30:35, 20:40] = True        # 100 px bar    -> 96 as well (tie; count is what matters)
    mask[50, 70] = True              # isolated pixel: majority filter must drop it
    mask[40:41, 60:75] = True        # 1-px-thin line: majority filter drops it too
    diff = np.where(mask, np.uint8(BLOB_DIFF_THRESHOLD + 1), np.uint8(0))
    blob = analyze_largest_blob(diff)
    check(blob["pixels"] == 96 and blob["components"] == 2, f"labeler: {blob}")
    check(blob["mask_pixels"] == 192, f"labeler: majority filter left {blob['mask_pixels']} px")
    check(blob["converged"], "labeler: not converged")

    dense = np.full((400, 600), np.uint8(255))
    dense_blob = analyze_largest_blob(dense)
    check(dense_blob["pixels"] == 400 * 600 - 4 and dense_blob["components"] == 1,
          f"labeler: dense {dense_blob}")  # -4: image corners eroded by the majority filter
    check(dense_blob["bbox_w"] == 600 and dense_blob["bbox_h"] == 400, "labeler: dense bbox")


def selftest_cli(tmp: str) -> None:
    for bad in ("1,2,3", "a,b,c,d", "0,0,-5,5", "0,0,0,10"):
        try:
            parse_roi(bad)
        except UsageError:
            continue
        raise SelfTestFailure(f"parse_roi accepted {bad!r}")
    small = make_gradient(64, 48)
    try:
        crop_roi(small, (10, 10, 60, 10), "A")
        raise SelfTestFailure("crop_roi accepted out-of-bounds roi")
    except UsageError:
        pass
    path_a, path_b = os.path.join(tmp, "a.png"), os.path.join(tmp, "b.png")
    Image.fromarray(small).save(path_a)
    Image.fromarray(np.pad(small, ((5, 5), (7, 7), (0, 0)))).save(path_b)
    a, b, info = load_pair(path_a, path_b, None)
    check(info["center_cropped"] and info["compared_size"] == [64, 48], "size mismatch crop")
    check(a.shape == b.shape and np.array_equal(a, b), "center crop should realign the pad")
    check(main([path_a]) == EXIT_USAGE, "missing args must exit 2")
    check(main([path_a, "missing.png", "--out", tmp]) == EXIT_USAGE, "missing file must exit 2")
    check(main([path_a, path_b, "--out", tmp, "--roi", "0,0,999,1"]) == EXIT_USAGE, "bad roi exit 2")


def run_selftest() -> int:
    try:
        with tempfile.TemporaryDirectory(prefix="visual-compare-selftest-") as tmp:
            selftest_images(tmp)
            selftest_blob_labeler()
            selftest_cli(tmp)
    except SelfTestFailure as exc:
        print(f"SELFTEST FAILED: {exc}", file=sys.stderr)
        return EXIT_FAIL
    print("SELFTEST PASSED")
    return EXIT_OK


# --------------------------------------------------------------------------- entry

def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run_selftest() if args.selftest else run_cli(args)
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
