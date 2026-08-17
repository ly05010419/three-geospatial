#!/usr/bin/env bash
# run-ab.sh — capture the WebGL reference story and the WebGPU story back-to-back
# (sequentially: they share the GPU) and run compare.py on the two screenshots.
#
#   scripts/visual-compare/run-ab.sh <round-name> [extra capture.mjs args...]
#
# Environment overrides:
#   VC_OUT         output directory (default: <scratchpad>/captures/<round-name>)
#   VC_WEBGL_URL   WebGL reference story URL   (default: Storybook on :4402)
#   VC_WEBGPU_URL  WebGPU story URL            (default: Storybook on :4006)
#
# Exit code: non-zero if either capture failed or compare.py failed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCHPAD_DIR="/private/tmp/claude-501/-Users-yongclaw-Desktop-clouds/b79b8563-fc34-4d2d-b84d-a9f500338d2d/scratchpad"

WIDTH=1600
HEIGHT=900
DPR=1

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <round-name> [extra capture.mjs args...]" >&2
  exit 2
fi
ROUND="$1"
shift

OUT="${VC_OUT:-$SCRATCHPAD_DIR/captures/$ROUND}"
WEBGL_URL="${VC_WEBGL_URL:-http://localhost:4402/iframe.html?id=clouds-minimal-setup--minimal-setup&viewMode=story}"
WEBGPU_URL="${VC_WEBGPU_URL:-http://localhost:4006/iframe.html?id=clouds-clouds--basic&viewMode=story&args=pixelRatio:1;dithering:!false;qualityPreset:high}"

mkdir -p "$OUT"
COMMON_ARGS=(--width "$WIDTH" --height "$HEIGHT" --dpr "$DPR" "$@")

capture() {
  local name="$1" url="$2"
  shift 2
  echo "== capture $name: $url" >&2
  node "$SCRIPT_DIR/capture.mjs" --url "$url" \
    --out "$OUT/$name.png" \
    --canvas-out "$OUT/$name.canvas.png" \
    --log "$OUT/$name.log" \
    "${COMMON_ARGS[@]}" "$@"
}

STATUS=0
capture webgl "$WEBGL_URL" --press-key h || { echo "!! WebGL capture failed (exit $?)" >&2; STATUS=1; }
capture webgpu "$WEBGPU_URL" --wait-gone '.ant-progress' || { echo "!! WebGPU capture failed (exit $?)" >&2; STATUS=1; }

if [[ ! -f "$OUT/webgl.png" || ! -f "$OUT/webgpu.png" ]]; then
  echo "!! missing $OUT/webgl.png or $OUT/webgpu.png — skipping compare.py" >&2
  exit 1
fi

echo "== compare.py" >&2
python3 "$SCRIPT_DIR/compare.py" "$OUT/webgl.png" "$OUT/webgpu.png" \
  --out "$OUT" --json --label-a WebGL --label-b WebGPU || STATUS=1

echo "== outputs in $OUT" >&2
exit "$STATUS"
