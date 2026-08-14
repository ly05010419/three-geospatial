# 功能和 Bug 记录

## B-20260814-003 WebGPU BSM 仅写入首个体素

- 日期：2026-08-14
- 状态：部分修复，时序 resolve 仍在排查
- 现象：Custom Layers 能显示云体，但低层雾面没有 WebGL 参考页中的大片云投影；页面无 WGSL 编译错误，BSM 路径和 controls 看起来均已开启。
- 根因：`CloudShadowNode` 的 march、resolve、clear 使用标量 `compute(1, [8, 8, 1])` 创建。Three.js TSL 把标量 count 编译为 `instanceIndex < 1` 守卫，运行时传入 `[64, 64, 3]` 只扩大 dispatch，不能移除该守卫，导致只有第 0 个 invocation 可能写入。
- 修复方案：三个计算核都改用无标量 count 的 `computeKernel([8, 8, 1])`，保留运行时按阴影分辨率和 cascade count 派发。
- 验证证据：修复前 BSM cascade 读回为全零；修复后 current 三层的非零半精度分量分别约为 487k、484k、488k，depth/velocity 也有约 782k–786k 非零分量。
- 剩余问题：temporal resolve 的 A/B 输出仍全零；Custom Layers 关闭 temporal shadows 时可直接读取 current BSM，但必须完成画面对比后才算修复完成。
- 涉及文件：
  - `packages/clouds/src/webgpu/CloudShadowNode.ts`
  - `storybook-webgpu/src/clouds/CloudsDev-ShadowMap.tsx`（仅作为调试入口，临时读回探针未保留）
- 教训/测试要点：对三维 compute 同时验证 dispatch、shader 内部 guard 与每个 slice 的有效输出；不能只检查调用次数或控制台错误。

## F-20260814-003 WebGPU Custom Layers 页面

- 日期：2026-08-14
- 描述：实现 WebGPU Clouds / Custom Layers，复现 WebGL 参考页的多高度、多密度自定义云层组合。
- 实现要点：
  - 使用四个云层和 `r/g/b/a` 四个天气通道，分别表现低层薄云、中层积云、高层云和贴近地面的雾层。
  - `CloudsNode.setCloudLayers()` 将通道顺序同步给主光线步进和 BSM 云影步进，避免云体与阴影采样不同步。
  - 复用可配置的 WebGPU Basic 场景，在 Custom Layers 中启用 North-Up-East 局部坐标系以及经度、纬度、高度控制。
  - 使用 WebGL 原页的 `[0, 0, 5]` 初始相机方向；Custom Layers 默认关闭主云 4× 时序重建和 BSM 时序抖动，保留确定性的当前帧 BSM 阴影。
  - 暴露 WebGL 参考页对应的位置、Local Date、日期动画、Tone Mapping 和 Renderer controls，并隐藏与该示例无关的调试项。
- 涉及文件：
  - `storybook-webgpu/src/clouds/Clouds-CustomLayers.tsx`
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`
  - `storybook-webgpu/src/clouds/Clouds.stories.tsx`
  - `packages/clouds/src/webgpu/CloudsNode.ts`
  - `packages/clouds/src/webgpu/CloudsNode.test.ts`

## B-20260814-002 Custom Layers 抖动且云影坐标错误

- 日期：2026-08-14
- 现象：Custom Layers 在静止状态仍有像素跳动，云层阴影缺失或位置不正确。
- 根因：局部 North-Up-East 参考系带有 ECEF 平移，但 `AtmosphereContext.matrixECEFToWorld` 使用 `transpose()` 计算逆变换；该做法只适用于纯旋转矩阵。Custom Layers 首次让 Clouds 同时依赖带平移的局部坐标和 BSM，因此暴露问题。
- 修复方案：
  - 将 ECEF→World 更新改为完整仿射 `invert()`。
  - 添加带旋转和平移的 World→ECEF→World 往返测试。
  - 恢复 WebGL Custom Layers 的原始相机方向。
  - 仅对 Custom Layers 关闭主云 temporal upscale、BSM temporal pass 和 temporal jitter；Basic 保持原配置。
- 涉及文件：
  - `packages/atmosphere/src/webgpu/AtmosphereContext.ts`
  - `packages/atmosphere/src/webgpu/AtmosphereContext.test.ts`
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`
  - `storybook-webgpu/src/clouds/Clouds-CustomLayers.tsx`
- 教训/测试要点：静止展示页必须验证长时间稳定性；局部坐标路径必须覆盖带平移的矩阵往返，不能只测 ECEF identity 路径。

## B-20260814-004 Custom Layers 非时序模式仍有随机抖动

- 日期：2026-08-14
- 现象：云体和云投影已经恢复，但在关闭云动画、日期动画、temporal upscale 与 temporal shadows 后，静止画面仍有细小爬动。
- 根因：非时序主云 march 和 BSM march 仍轮换 STBN slice；地表阴影 PCF 也无条件使用递增 frame；最终 `dithering` 还把 `time` 混入噪声。
- 修复方案：
  - 非时序主云 march 固定使用 STBN 第 0 层。
  - BSM temporal jitter 关闭时，march 与地表 PCF 都固定使用 STBN 第 0 层。
  - Basic 渲染组件增加 `enableDithering` 场景配置，Custom Layers 关闭时变 dithering，其他页面保持默认开启。
- 涉及文件：
  - `packages/clouds/src/webgpu/CloudsMarchNode.ts`
  - `packages/clouds/src/webgpu/CloudShadowNode.ts`
  - `packages/clouds/src/webgpu/CloudsNode.ts`
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`
  - `storybook-webgpu/src/clouds/Clouds-CustomLayers.tsx`
- 验证：4004 页面冷启动后云投影清晰可见；相隔 3 秒截图逐像素差异为 0；无新增 console error；Clouds 9/9、Atmosphere 4/4、Storybook typecheck 全部通过。

## B-20260814-005 Basic 云影 resolve 的 WGSL 与 compute 派发崩溃

- 日期：2026-08-14
- 现象：Basic 报 `vec2<f32>(vec3<u32>)` WGSL 构造错误，随后 `WebGPUBackend.compute` 读取 `null[0]`，云影 resolve 无法运行。
- 根因：Three r183 的 `TextureSizeNode` 不支持 3D 尺寸；同时手动派发的无 count `computeKernel()` 仍被节点图自动更新，再次以空 dispatch 执行。
- 修复方案：由阴影 resolution 与 cascade count 显式构造三维纹理边界；March、Resolve、ClearHistory 设置 `NodeUpdateType.NONE`，仅保留 `CloudShadowNode` 的显式三维派发。
- 验证：Basic 和 Custom Layers 在 4004 iframe 冷启动后均正常出首帧，控制台没有 WGSL、WebGPUBackend.compute 或 GPU validation error。

## B-20260814-006 Storybook mocker 入口 404 导致冷启动挂起

- 日期：2026-08-14
- 现象：`/vite-inject-mocker-entry.js` 返回 404；简单空模块 fallback 后，冷启动可能一直停在 preparing story。
- 根因：当前 Storybook 10.4/Vite 7 组合未执行上游带 `filter` 的 resolve hook；真实 runtime 位于 pnpm store 路径，直接 `/@fs` 加载又超出 Vite allow list。
- 修复方案：在最终 Vite 配置的 pre middleware 中读取并原样响应 Storybook mocker runtime。
- 验证：入口返回 HTTP 200 和完整 runtime（56,263 bytes），Basic 与 Custom Layers 冷启动均完成。

## F-20260814-001 WebGPU Basic 云层与日期动画

- 日期：2026-08-14
- 描述：补齐 WebGL Basic 中可运动云层和连续天体时间变化的能力。
- 实现要点：
  - `animateClouds` 开启时把 `cloudSpeed` 写入 `CloudsNode.localWeatherVelocity`，关闭时归零。
  - 使用共享 Local Date controls 更新 ECI→ECEF、太阳方向和月亮方向。
  - `animateDate` 按帧推进时间，`dateSpeed` 单位为模拟小时/真实秒；默认关闭以保持确定性基准。
- 涉及文件：
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`
  - `packages/clouds/src/webgpu/CloudsNode.test.ts`

## F-20260814-002 WebGPU 地表/物体接收云影

- 日期：2026-08-14
- 描述：把 Clouds BSM 输出接入 WebGPU Aerial Perspective 的表面光照，补齐 WebGL `AtmosphereShadow` 能力。
- 实现要点：
  - `AerialPerspectiveNode.sunTransmittanceNode` 为表面位置提供太阳透射率，只调制太阳直射照度。
  - `CloudsNode.getSunTransmittanceNode()` 复用 BSM 级联、STBN 抖动和 PCF 采样。
  - 地表采样省略 optical-depth tail，并移植 WebGL 的屏幕投影自适应阴影半径。
  - Basic pass 输出 diffuse color、depth 与 view normal；`showShadowReceiver` 显示 WebGL 同款 ENU 调试盒子。
- 涉及文件：
  - `packages/atmosphere/src/webgpu/AerialPerspectiveNode.ts`
  - `packages/clouds/src/webgpu/CloudsNode.ts`
  - `packages/clouds/src/webgpu/shadowSampling.ts`
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`

## B-20260814-001 开启表面云影后 WebGPU 着色器无效

- 日期：2026-08-14
- 现象：`surfaceShadows=true` 时页面挂载成功，但 WebGPU 报 `Invalid ShaderModule vertex_RTT`，后处理无法绘制。
- 根因：表面阴影路径通过相机 `ReferenceNode` 再次声明 `viewMatrix`；它与全屏渲染通道的内建 uniform 冲突，自动重命名结果 `object.viewMatrix_1` 不是合法 WGSL 标识符。
- 修复方案：在 `CloudsNode` 中新增名称唯一的显式 view/projection/near uniform，并在 `updateBefore()` 中从场景相机同步；表面阴影节点统一引用这组 uniform。
- 涉及文件：
  - `packages/clouds/src/webgpu/CloudsNode.ts`
- 教训/测试要点：
  - 必须在真实 WebGPU 设备中切换 `surfaceShadows` 触发节点图重编译。
  - 浏览器回归需确认 `sb-show-main`、canvas 已创建，并在至少 15 秒运行后没有新增 GPU/console error。
