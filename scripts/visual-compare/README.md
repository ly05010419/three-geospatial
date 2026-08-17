# visual-compare — 截图 A/B 对比工具

用于对比两张渲染截图（例如 WebGL 参考图 vs WebGPU 新实现），输出证据图片 + 数值指标，
帮助人或 agent 判断"肉眼是否看得出差别"。

依赖：仅 `Pillow` + `numpy`（不需要 ImageMagick / scipy）。

## 用法

```bash
python3 compare.py A.png B.png --out DIR \
    [--roi x,y,w,h] [--gain 8] [--label-a "WebGL" --label-b "WebGPU"] [--json]

python3 compare.py --selftest      # 内置自测（合成图片），通过时打印 SELFTEST PASSED
```

| 参数 | 说明 |
|---|---|
| `A.png B.png` | A 为参考图，B 为待比较图。按 RGB 读取（alpha 丢弃）。 |
| `--out DIR` | 输出目录（不存在会自动创建）。 |
| `--roi x,y,w,h` | 先把两张图裁到同一矩形（用于去掉 UI 覆盖层 / FPS 面板等）。 |
| `--gain N` | `diff.png` / `diff_signed.png` 的放大倍数，默认 8。 |
| `--label-a/--label-b` | 三联图标题里的名字。 |
| `--json` | 额外把指标写成 `DIR/metrics.json`。 |

尺寸不一致时会打印 warning，并把两张图**居中裁剪**到公共最小尺寸（`metrics.center_cropped = true`）。

退出码：`0` 成功，`1` 自测失败，`2` 用法错误（文件不存在、`--roi` 非法等）。

## 输出文件（在 `--out DIR` 内）

| 文件 | 含义 |
|---|---|
| `diff.png` | 每像素 `max_channel(|B−A|) × gain`，截断后映射为热力色：黑 → 橙 → 白。全黑 = 完全一致；散布的暗橙点 = 噪声；成片亮块 = 结构性差异。 |
| `diff_signed.png` | 每通道 `(B−A) × gain + 128`。中性灰 = 相同；整体偏某个颜色 = B 相对 A 有色偏/曝光偏差（例如整体偏红说明 B 的红通道更亮）。 |
| `triptych.png` | `A | B | diff` 三联图，顶部标题栏写有标签和关键指标。单张宽度 > 1200 px 时按整数倍缩小，保证整图 ≤ 3600 px。 |
| `blink.gif` | A/B 两帧循环切换（每帧 500 ms），最适合肉眼盯着看有没有"跳动"。 |
| `metrics.json` | 仅 `--json` 时生成，内容与终端表格一致，附带输入尺寸 / ROI / 是否裁剪等信息。 |

## 指标说明

| 指标 | 含义 | 怎么读 |
|---|---|---|
| `rmse_full_pct` | 全分辨率 RGB 的均方根误差，按 8-bit 归一化到 [0,1] 后的百分比 | 越小越接近；< 1% 基本看不出 |
| `rmse_half_pct` | 两图先 2×2 box 缩小 50% 再算 RMSE | 缩小会平均掉噪声，若明显低于 `rmse_full` 说明差异以噪声为主 |
| `psnr_db` | 峰值信噪比 | 越大越好；完全一致时为 `inf`（JSON 里为 `null`） |
| `changed_pct_8/16/32` | 通道最大绝对差 > 8/16/32（满量程 255）的像素百分比 | 三档看差异强度分布：只有 >8 有值 = 轻微噪声；>32 也有值 = 明显差异 |
| `mean_abs_diff` | 所有通道 \|B−A\| 的均值（0–255） | 整体差异大小 |
| `mean_signed_diff_rgb` | 每通道 `mean(B−A)` | 揭示全局色偏/曝光偏差；三通道同号 = 曝光偏差，异号 = 色偏 |
| `largest_blob` | 差异 > 16 的像素做 3×3 多数（腐蚀式）滤波去掉孤立噪点后，最大 8 连通块的像素数 / 外接框 (`bbox_w×bbox_h`, 位置) / 连通块数量 | 判断残差是**结构性**（大块）还是**噪声**（小碎块）。注意矩形块的 4 个角会被滤波腐蚀掉。 |
| `lum_hist_mean_abs_diff` / `lum_hist_tv` | 灰度 64-bin 归一化直方图的平均绝对差 / 总变差 (0–1) | 廉价的整体影调 / 曝光比较，对位置不敏感 |
| `verdict` | **启发式**判定：`largest_blob.pixels < 200` 且 `rmse_half < 1.5%` → `noise-only`，否则 `structural differences present` | 只是提示，最终请结合 `blink.gif` / `triptych.png` 用肉眼确认 |

## 自测内容

`--selftest` 在临时目录里生成：渐变 + 圆盘的合成图，验证

1. 完全相同 → 所有指标为 0、PSNR = inf、判定 `noise-only`；
2. 加 ±3 随机噪声 → `changed_pct_8 = 0`、无 blob、判定 `noise-only`；
3. 圆盘平移 12 px → 出现 ≥ 200 px 的 blob、判定 `structural differences present`；
4. 连通块标注器（去孤立点、稠密掩码收敛）、`--roi` 解析 / 越界、尺寸不一致居中裁剪、CLI 错误退出码 2。
