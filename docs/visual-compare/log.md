# 视觉对比记录（WebGPU vs WebGL）

更新时间：2026-08-17

验收口径：不要求代码 1:1，只要求最终画面肉眼无法区分。判"能否看出来"以 `largest_blob`（结构性连通块）为准，RMSE 会被全局偏色主导。

## 采集条件

| 项        | 值                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 参照（A） | WebGL `clouds-minimal-setup--minimal-setup` @ **4402**，冻结位姿，`2025-01-01T07:00Z`，postprocessing AgX 曝光 10，LensFlare，无 SMAA/dithering |
| 被测（B） | WebGPU `clouds-clouds--basic` @ **4006**，`args=pixelRatio:1;dithering:!false;qualityPreset:high`                                                                  |
| 分辨率    | 1600×900，dpr 1                                                                                                                                 |
| 稳定      | `--settle-frames 240`（云层升采样 16 帧周期，BSM α=0.01 约需 100 帧）                                                                           |
| 工具      | `scripts/visual-compare/{capture.mjs,run-ab.sh,compare.py}`                                                                                     |

命令：`scripts/visual-compare/run-ab.sh <round>`；工具自检 `python3 scripts/visual-compare/compare.py --selftest`。

## 逐轮结果

`—` 表示该轮未记录该指标（各轮的 `metrics.json` 落在 session scratchpad，未随仓库保存）。

| 轮次     | 本轮改动                                                                                                            | RMSE 全图   | RMSE 半分辨率 | >8     | >16    | >32     | 最大连通块 | 判定       | 备注                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ----------- | ------------- | ------ | ------ | ------- | ---------- | ---------- | ---------------------------------------------------------------------------------- |
| baseline | 无云基线：WebGL `clouds:!false` vs WebGPU `coverage:0`                                                              | 1.98 %      | —             | —      | —      | —       | 无         | noise-only | WebGPU 整体亮 +3~+9/255 且偏暖；运行时计算 LUT vs 预计算贴图。差异在 clouds 包之外 |
| smoke    | ①历史清空 alpha 1→0 ②`shadowLength` float→vec2 ③Bayer 抖动 y 翻转 ④`maxFar` 不再硬编码 ⑦ESLint；两侧 Story 参数对齐 | 3.28 %      | —             | —      | —      | —       | 45983 px   | structural | 洋面云影暗化只有 WebGL 的一半                                                      |
| round2   | ⑥`occludeHigherOrderScattering`（阴影段内省略高阶散射）                                                             | 2.20 %      | —             | —      | —      | —       | 6855 px    | structural | 洋面亮度对上；残留一处成对正负瓣 = 平移而非强度                                    |
| round3   | ⑤`FrustumCorners` 近平面 NDC z 按 coordinateSystem 取 0 / −1                                                        | **2.16 %**  | —             | —      | 0.26 % | —       | **9 px**   | noise-only | 结构性差异消除                                                                     |
| round4   | ⑧`groundAlbedo` 预计算参数对齐：Story 默认 0.3 → **0.1**                                                            | **0.976 %** | 0.782 %       | 2.31 % | 0.30 % | 0.015 % | 88 px      | noise-only | 大气基线偏色的根因；无云基线 RMSE 1.98 % → **0.552 %**                             |

## round4 分区核对（RGB 三通道均值，0–255）

`diff = WebGPU − WebGL`，取自 `round4/webgl.png` 与 `round4/webgpu.png`。

| 区域                  |  WebGL | WebGPU |  diff |
| --------------------- | -----: | -----: | ----: |
| sky top-right         | 153.79 | 154.86 | +1.07 |
| cloud interior center | 215.38 | 214.79 | −0.59 |
| cloud interior left   | 205.87 | 205.63 | −0.23 |
| horizon band L        | 201.53 | 199.88 | −1.65 |
| horizon band R        | 172.21 | 169.32 | −2.89 |
| ocean below horizon L | 120.93 | 119.62 | −1.31 |
| ocean below horizon R |  58.40 |  58.86 | +0.46 |
| ocean shadow patch    |  67.30 |  68.82 | +1.53 |
| ocean mid-left        |  50.19 |  53.05 | +2.87 |
| ocean mid-right       |  28.91 |  30.49 | +1.58 |
| ocean bottom-right    |  13.36 |  14.87 | +1.51 |

11 个区域全部落在 ±3/255 以内，且不再是 baseline 那种"所有区域同号偏亮"：天空与洋面略偏正、地平线带略偏负，属于噪声相位与色调曲线尾部的残差，不是能量差。

## round4：大气基线偏色的根因 = groundAlbedo 预计算参数

- 现象：baseline 轮的无云对比里 WebGPU 整体亮 +3~+9/255 且偏暖（`mean signed B−A = +5.07, +5.14, +3.27`，`changed>8` 占 8.27 %），却没有任何结构块——典型的"全局预计算参数不同"，不是几何或采样问题。
- 根因：`groundAlbedo` 只被多重散射 LUT 的预计算消费（`packages/atmosphere/src/webgpu/multiscattering.ts` 的地面反弹项）。WebGL 的默认值是 **0.1**（`packages/atmosphere/src/AtmosphereParameters.ts:164`），随包发布的预计算 LUT 贴图就是按 0.1 生成的；WebGPU 上游默认值是 **0.3**（`packages/atmosphere/src/webgpu/AtmosphereParameters.ts:113`）。地面反弹回大气的能量差了 3 倍，天空与空间透视整体被抬亮。
- 处理：归到"平台/上游默认值差异"桶——**不改包默认值**（WebGPU 包仍为 0.3），只在 Clouds Basic Story 增加 `groundAlbedo` number arg（range 0–1，step 0.01），默认 **0.1**。Story 构造 `new AtmosphereContext(new AtmosphereParameters())` 时先写入该值；运行时改动走 `parameters.groundAlbedo.setScalar(v)` + `lutNode.needsUpdate = true` + `cloudsNode.resetHistory()`。`AtmosphereLUTNode.updateBefore()` 比较 `version`，每次 bump 都用新建的 LUT context 重新编译计算核，因此新值会被重新烘焙进 WGSL。
- 效果：无云基线 RMSE **1.98 % → 0.552 %**，`mean_abs_diff` 4.505 → 1.070，`changed>8` 8.27 % → 0.012 %，`largest_blob` 保持 0 px；有云全图 RMSE **2.16 % → 0.976 %**。

无云基线复核命令：

```bash
node scripts/visual-compare/capture.mjs \
  --url 'http://localhost:4006/iframe.html?id=clouds-clouds--basic&viewMode=story&args=pixelRatio:1;dithering:!false;qualityPreset:high;coverage:0' \
  --out <round>/webgpu-cov0.png --wait-gone '.ant-progress' --max-seconds 300
python3 scripts/visual-compare/compare.py <atmo>/webgl-noclouds.png <round>/webgpu-cov0.png --out <round>/cmp-atmo
```

## round3 分区核对

云致暗化（开云 − 无云）逐区域比对，两侧一致；例如地平线以下洋面 R 通道 **−41.6 vs −41.6**。

> 完整分区表未重算：各轮截图只存在于 session scratchpad，未持久化。需要时用上面的命令重跑一轮再按 `--roi` 分区统计。

## 残差构成（已知并接受）

1. 时序噪声相位差（STBN / IGN 确定性但相位不同）——round4 之后成为最大的一项，表现为云缘 1 px 级散点（round4 最大连通块 88 px，bbox 25×10 @ (608,423)，共 52 个碎块）。
2. 剩余大气基线偏差（0.552 % RMSE，无结构块，`mean signed B−A = +0.85, +0.25, −1.38`，极轻微偏红偏冷），来自运行时计算 LUT 与预计算贴图之间的精度/采样差异。
3. LensFlare 实现差异（pmndrs vs core LensFlareNode），≤ 1/255。
4. WebGL 侧的 SMAA 边缘抗锯齿、AgX 实现差异、half-float 舍入。

## 排除项（查过且无关，不必重复验证）

- `raymarchScattering`、`accurateShadowScattering`：对残差无影响。
- Tone curve：postprocessing 的 AgX 与 three 的 chunk 一致。
- BSM 计算中的 turbulence LOD、`shapeDetail`：均不影响级联位移。
- BSM 生产端内容：两个后端统计一致，问题在消费端坐标。
- 太阳位置：两侧一致到 0.03°。
