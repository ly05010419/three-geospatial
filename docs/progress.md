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

## 进行中

- 修复 BSM temporal resolve：GPU 读回确认 `current` 和 `depthVelocity` 已有数据，但 `resolveTextureA/B` 仍然全零。Custom Layers 当前通过 `temporalShadows={false}` 读取已恢复的 current BSM；Basic 的默认时序阴影路径尚未完成验收。
- 在 `http://localhost:4004/?path=/story/clouds-clouds--custom-layers` 与 WebGL 参考页做同视角可视化对比，必须确认低层雾面出现大片云投影且静止画面不抖。
- 补充完整测试、生产构建和浏览器控制台回归；完成前不能把云阴影标记为已交付。
