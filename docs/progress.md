# 开发进度

更新时间：2026-08-14

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

## 进行中

- 当前无阻塞项。`THREE.Clock` 与 Storybook `PopoverProvider.ariaLabel` 仍是第三方开发环境弃用警告，不影响 WebGPU 渲染；项目直接使用的后处理已迁移到 `RenderPipeline`。
