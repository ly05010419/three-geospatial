# 开发进度

更新时间：2026-08-17

## 已完成

- WebGPU Clouds / Custom Layers 已实现，并按 WebGL 参考页配置四层独立云层、RGBA 天气通道、局部坐标位置控制和日期动画。
- Custom Layers 已恢复 WebGL 原页的 `[0, 0, 5]` 初始相机方向，并默认关闭主云 4× 时序重建与 BSM 时序抖动，消除静止画面的像素跳动。
- 已修复局部坐标中 ECEF→World 错用矩阵转置的问题；完整仿射逆矩阵恢复了云层时序重投影和 BSM 阴影采样坐标。
- WebGPU Basic 已抽取为可配置场景；Basic 继续使用原 ECEF 固定视角，Custom Layers 复用同一渲染管线并启用 North-Up-East 局部坐标系。
- `CloudsNode.setCloudLayers()` 会同步主光线步进与云影步进的天气通道编译配置、更新云层 uniform，并重置时序历史。
- WebGPU Clouds / Basic 已补齐云层天气动画：`animateClouds` 与 `cloudSpeed` 控制本地天气纹理偏移。
- WebGPU Clouds / Basic 已补齐日期动画：可设置年月、年内日期、时刻，并通过 `animateDate` 与 `dateSpeed` 连续推进太阳/月亮方向。
- WebGPU Clouds / Basic 已接入物体表面云影：BSM 光学深度只衰减太阳直射光，保留天空间接光。
- 表面云影 PCF 半径已按 WebGL `AerialPerspectiveEffect.getShadowRadius()` 的投影尺寸算法移植。
- Basic 已加入 WebGL 同款可选调试盒子 `showShadowReceiver`，用于观察物体接收云影；默认关闭以维持基准画面。
- 云层自阴影继续使用既有 BSM 路径，`bsm` 默认开启；表面阴影采样与自阴影共享同一组级联阴影数据。
- 已修复表面云影开启后生成非法 WGSL 的相机矩阵绑定重名问题。
- 已完成类型检查、Atmosphere 4 项与 Clouds 9 项单元测试、生产 Storybook 构建和 Basic / Custom Layers 浏览器 WebGPU 运行时回归。
- 已定位 Custom Layers 无云投影的首个根因：`CloudShadowNode` 的 march、resolve、clear 计算核用标量 `compute(1, ...)` 创建，TSL 因此永久编译了 `instanceIndex < 1` 守卫。现已改用无标量 count 的 `computeKernel()`，march 的 3 个级联从近乎全零恢复为每层约 48 万个非零半精度分量。
- Custom Layers 的静态抖动已彻底消除：非时序主云、非时序 BSM 和地表阴影 PCF 都固定使用 STBN 第 0 层；该 Story 同时关闭随 `time` 变化的最终 dithering。冷启动后相隔 3 秒的两张 2920×1242 浏览器截图在预览 ROI 内逐像素差异为 0。
- 已在 `http://localhost:4004/?path=/story/clouds-clouds--custom-layers` 完成真实 WebGPU 冷启动回归：低层雾面可见大片蓝灰色云投影，控制台无新增 error；Clouds 9 项、Atmosphere 4 项测试和 Storybook TypeScript 检查全部通过。
- 已修复 Basic 时序云影 resolve 的 WebGPU WGSL：Three r183 的 `TextureSizeNode` 会把 3D 纹理尺寸错误生成为 `uvec2`，现改用已知的阴影分辨率和 cascade count 显式构造 `ivec3` 边界。
- 已修复手动派发的 `computeKernel()` 被 Three 节点更新阶段再次自动执行的问题；March、Resolve、ClearHistory 都禁用自动 `updateBefore`，避免无 dispatch size 时访问 `null[0]`。
- Storybook 10 的 mocker runtime 入口现由 Vite fallback middleware 提供真实 runtime，`/vite-inject-mocker-entry.js` 冷启动返回 200，不再出现 404 或挂起预览。
- Basic 与 Custom Layers 均在 4004 通过 iframe 冷启动 WebGPU 回归；Custom Layers 地面云影清晰可见，相隔 3 秒的 2920×1242 两帧 3,626,640 个像素全部一致，控制台无 WebGPU/WGSL/compute error。
- 2026-08-17：验收口径已从"代码与 WebGL 1:1"改为"最终画面与 WebGL 肉眼无法区分"，参照页固定为 WebGL `clouds-minimal-setup--minimal-setup`。
- 已建立无依赖的截图 A/B 工具链：`scripts/visual-compare/capture.mjs`（headless Chrome + CDP，等待 ≥240 帧稳定后截图）、`run-ab.sh`（顺序采集 WebGL/WebGPU 两张图并调用对比）、`compare.py`（PIL + numpy，输出 diff/三联图/blink 与 RMSE、changed%、最大连通块等指标，自带 `--selftest`）。
- 已修复 `CloudsResolveNode.clearHistory()` 用 alpha 1 清空历史的问题，改为 alpha 0，与 WebGL 渲染目标零初始化一致。
- 已修复 `CloudsNode.getShadowLengthNode()` 返回 float 的契约错误；新增 `webgpu/shadowLength.ts`，天空用 `shadowLengthFromCamera`、到点用 `shadowLengthToPoint`，与 WebGL Bruneton 的两条路径一致。
- 已修复 Bayer 投影抖动的 y 符号：新增 `webgpu/temporalJitter.ts`，`applyProjectionJitter(..., flipY)` 适配 WebGPU 左上角原点的 `screenUV`。
- 已移除 `CloudsNode` 里硬编码的 `shadowMaps.maxFar = 1e5`，改为可选的 `options.shadows.maxFar`，默认跟随 `camera.far`（与 WebGL `CascadedShadowMaps` 一致）。
- 已修复 `helpers/FrustumCorners.ts` 在 WebGPU 下把近平面角点按 GL 的 NDC z=-1 反投影的问题，这是地面云影整体偏移一个纹素（约 330 m）的根因。
- 大气新增可选项 `AtmosphereContext.occludeHigherOrderScattering`（默认 false 保持上游行为），复现 WebGL 在光轴阴影段内省略高阶散射的近似；Clouds Basic Story 打开它以对齐 WebGL。
- 已补齐 `shadowMap` 调试视图（`CloudsMarchNode` + `shadowSampling.getCascadedShadowMaps`），2×2 级联拼贴与 WebGL `DEBUG_SHOW_SHADOW_MAP` 对应。
- WebGPU `Clouds-Basic` 新增 `dithering`、`lensFlare`、`raymarchScattering`、`accurateShadowScattering`、`occludeHigherOrderScattering` 参数，默认 Tone Mapping 改为 AgX；`Clouds-CustomLayers` 通过 args/hiddenControl 同步。
- WebGL `MinimalSetup.stories.tsx` 已改写为 CSF3，新增 `clouds`、`coverage`、`postEffects`、`debugShow`、`turbulence`、`shapeDetail` 参数，用于逐层二分对比。
- 已修复 webgpu 目录下 5 个既有 ESLint 错误（import type、`globalThis.location`、`export type`）。
- 已定位并消除"无云基线 1.98% RMSE"的根因：`groundAlbedo` 预计算参数默认值不同（WebGL 0.1 vs WebGPU 0.3），它只被多重散射 LUT 的地面反弹项消费。WebGPU 包默认值保持 0.3；Clouds Basic Story 新增 `groundAlbedo` number arg（range 0–1，step 0.01）并默认 0.1，`Clouds-CustomLayers` 以 hiddenControl 同步。无云基线 RMSE 1.98% → 0.552%。
- 当前指标（1600×900、dpr 1）：round4 全图 RMSE 0.976%（round3 为 2.16%），半分辨率 0.782%，PSNR 40.21 dB，差异 >8/>16/>32 的像素占 2.31%/0.30%/0.015%，最大结构连通块 88 px，判定 noise-only（round smoke 为 45983 px）。11 个采样区域的 RGB 均值差全部落在 ±3/255 以内。

## 进行中

- `THREE.Clock` 与 Storybook `PopoverProvider.ariaLabel` 仍是第三方开发环境弃用警告，不影响 WebGPU 渲染；项目直接使用的后处理已迁移到 `RenderPipeline`。
