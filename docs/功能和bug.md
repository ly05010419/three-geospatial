# 功能和 Bug 记录

## B-20260814-003 WebGPU BSM 仅写入首个体素

- 日期：2026-08-14
- 状态：已修复（时序 resolve 部分由 B-20260814-005 与 2026-08-17 的视觉 A/B 闭环）
- 现象：Custom Layers 能显示云体，但低层雾面没有 WebGL 参考页中的大片云投影；页面无 WGSL 编译错误，BSM 路径和 controls 看起来均已开启。
- 根因：`CloudShadowNode` 的 march、resolve、clear 使用标量 `compute(1, [8, 8, 1])` 创建。Three.js TSL 把标量 count 编译为 `instanceIndex < 1` 守卫，运行时传入 `[64, 64, 3]` 只扩大 dispatch，不能移除该守卫，导致只有第 0 个 invocation 可能写入。
- 修复方案：三个计算核都改用无标量 count 的 `computeKernel([8, 8, 1])`，保留运行时按阴影分辨率和 cascade count 派发。
- 验证证据：修复前 BSM cascade 读回为全零；修复后 current 三层的非零半精度分量分别约为 487k、484k、488k，depth/velocity 也有约 782k–786k 非零分量。
- 后续结论：temporal resolve 的 WGSL 与派发问题由 B-20260814-005 修复；2026-08-17 的视觉 A/B 在 Basic 默认（temporalUpscale + temporalShadows 全开）下拿到与 WebGL 一致的云影画面，证明 A/B 输出不再为零，本条已闭环。
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

## B-20260817-001 时序历史用不透明黑清空

- 日期：2026-08-17
- 现象：WebGPU 云层在历史重置后的最初若干帧比 WebGL 暗，画面像被压了一层黑。
- 根因：`CloudsResolveNode.clearHistory()` 在 `resetRendererState()` 之后执行，此时 clear color 是 alpha = 1 的不透明黑。云层输出是预乘 alpha（alpha = 覆盖率），用 alpha 1 清空等于往场景上合成了一整帧黑色；WebGL 的渲染目标是零初始化的。
- 修复方案：清空前 `setClearColor(0x000000, 0)`，清完恢复 `setClearColor(0x000000, 1)` 供 resolve pass 使用。
- 涉及文件：
  - `packages/clouds/src/webgpu/CloudsResolveNode.ts`
  - `packages/clouds/src/webgpu/CloudsResolveNode.test.ts`
- 教训/测试要点：`resetRendererState()` 会带入渲染器的默认 clear 状态，任何依赖"纹理初始为 0"的历史缓冲都必须显式设置 alpha；单测直接断言 clear 时的 clear color 与 alpha。

## B-20260817-002 shadowLength 契约被当成 float 传给 vec2

- 日期：2026-08-17
- 现象：光轴阴影（light shafts）在 WebGPU 下位置与强度都与 WebGL 对不上。
- 根因：`CloudsNode.getShadowLengthNode()` 返回 `Node<'float'>`，而大气消费者（`SkyNode` / `AerialPerspectiveNode`）要的是 `vec2(阴影段长度, 阴影段起点到相机的距离)`。TSL 对 float 取 swizzle 是 no-op，Three 的 `SplitNode` 把它静默读成 `(L, L)`，既不报类型错也不报 WGSL 错。
- 修复方案：新增 `webgpu/shadowLength.ts`，`shadowLengthFromCamera(L) = vec2(L, 0)`（天空路径，复现 WebGL `GetSkyRadiance()`）、`shadowLengthToPoint(L, d) = vec2(L, max(d - L, 0))`（到点路径，复现 `GetSkyRadianceToPoint()`）；`CloudsNode` 与 `CloudsMarchNode` 的空间透视分别改用这两个函数。
- 涉及文件：
  - `packages/clouds/src/webgpu/shadowLength.ts`
  - `packages/clouds/src/webgpu/shadowLength.test.ts`
  - `packages/clouds/src/webgpu/CloudsNode.ts`
  - `packages/clouds/src/webgpu/CloudsNode.test.ts`
  - `packages/clouds/src/webgpu/CloudsMarchNode.ts`
- 教训/测试要点：TSL 的分量数不参与类型检查，跨包的向量契约必须由具名适配函数固定下来，并用单测断言返回的 node type 是 `vec2` 以及两个分量的语义。

## B-20260817-003 Bayer 投影抖动的 y 方向反了

- 日期：2026-08-17
- 现象：开启 temporal upscale 后云层边缘有 1 像素级的错位与蠕动，1/4 分辨率的新样本没有落在 resolve 期望的 Bayer 槽位上。
- 根因：抖动公式从 WebGL 逐字照抄，但 WebGL 用左下角原点的 `gl_FragCoord`，WebGPU 的 `screenUV` / `screenCoordinate` 是左上角原点。NDC 的 y 向上，所以投影矩阵第三列的 y 项需要取反，否则新样本落在镜像行。
- 修复方案：新增 `webgpu/temporalJitter.ts`（`getTemporalJitter` 保留 WebGL 公式，`applyProjectionJitter(projection, jitter, flipY)` 负责翻转），`CloudsMarchNode.copyCameraSettings()` 的投影与重投影都以 `flipY = true` 调用。
- 涉及文件：
  - `packages/clouds/src/webgpu/temporalJitter.ts`
  - `packages/clouds/src/webgpu/temporalJitter.test.ts`
  - `packages/clouds/src/webgpu/CloudsMarchNode.ts`
- 教训/测试要点：用几何单测覆盖完整的 16 帧周期——把抖动后的射线投回全分辨率像素，断言它正好命中该帧的 Bayer 槽；同时保留一条"WebGL 左下角公式落在镜像行"的测试，把旧 bug 固化成回归用例。

## B-20260817-004 CloudsNode 硬编码 shadowMaps.maxFar

- 日期：2026-08-17
- 现象：库的级联阴影范围被写死为 1e5，集成方无法让级联跟随相机 far，与 WebGL `CascadedShadowMaps` 的默认行为不一致。
- 根因：把对比用的冻结参数（`.port-plan.md` §3.3 的 `shadow.maxFar = 1e5`）直接写进了库构造函数，而 WebGL 的默认是 `maxFar: null`（跟随 `camera.far`）。
- 修复方案：新增可选的 `CloudShadowOptions.maxFar`；仅在显式传入时才覆盖 `shadowMaps.maxFar`，冻结参数由 Story 自行设置。
- 涉及文件：
  - `packages/clouds/src/webgpu/CloudsNode.ts`
  - `packages/clouds/src/webgpu/options.ts`
  - `packages/clouds/src/webgpu/CloudsNode.test.ts`
- 教训/测试要点：对比场景的取值属于 Story 配置，不属于库默认值；单测同时覆盖"不传时跟随 camera.far"和"传入时生效"两条路径。

## B-20260817-005 FrustumCorners 在 WebGPU 下用了 GL 的近平面 NDC z

- 日期：2026-08-17
- 现象：WebGPU 地面云影相对 WebGL 整体平移，`shadowLength` 调试图上出现成对的正负瓣；这是 round2 之后残留的最大结构性差异（最大连通块 6855 px）。
- 根因：`helpers/FrustumCorners.setFromCamera()` 把近平面角点写死为 NDC z = -1。WebGL 的裁剪空间 z ∈ [-1, 1]，WebGPU 是 [0, 1]，用 -1 反投影 WebGPU 投影矩阵会把近角点放到相机后方约 0.5 m。误差本身只有 8e-6 的相对量级，但 `CascadedShadowMaps.updateMatrices()` 会把光空间中心按 `Math.round(center / texel)` 吸附到整纹素，半径的微小误差被量化放大成 cascade 0 在 x 方向整整偏移 1 个纹素（此配置下约 330 m）。
- 修复方案：`const nearZ = camera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1`，四个近角点都用它。
- 涉及文件：
  - `packages/clouds/src/helpers/FrustumCorners.ts`
  - `packages/clouds/src/helpers/FrustumCorners.test.ts`
  - `packages/clouds/src/CascadedShadowMaps.test.ts`
- 教训/测试要点：先写 RED 测试——同一相机在两种 coordinateSystem 下构建级联，把 ortho 盒角点变回世界坐标比较，修复前偏差 283.9 m，修复后 < 1e-3 m。凡是"吸附/量化"的下游，都要按最终量化结果断言，不能只按相对误差判断可忽略。

## B-20260817-006 阴影段内高阶散射未省略导致洋面云影过亮

- 日期：2026-08-17
- 现象：云影投在洋面上时，WebGPU 的暗化只有 WebGL 的一半左右；差异图上是大片结构块（round smoke 最大连通块 45983 px）。
- 根因：WebGL 的 Bruneton 运行时在光轴阴影段内省略高阶（多重）散射：天空路径为 `single(p)·T + higher(p)`，到点路径为 `higher(cam) - T(0,d)·higher(p at d-L)`。WebGPU 版本在注释里明确写着"regardless of occlusion"，无条件把高阶散射加回去，于是阴影段被填亮。
- 修复方案：新增 `AtmosphereContext.occludeHigherOrderScattering`（默认 false，保持上游行为），在 `webgpu/runtime.ts` 的天空与到点两条 LUT 路径、以及 `multiscattering.ts` 的 raymarch 路径按分支省略高阶散射；Clouds Basic Story 默认打开以对齐 WebGL。
- 涉及文件：
  - `packages/atmosphere/src/webgpu/AtmosphereContext.ts`
  - `packages/atmosphere/src/webgpu/AtmosphereContext.test.ts`
  - `packages/atmosphere/src/webgpu/runtime.ts`
  - `packages/atmosphere/src/webgpu/multiscattering.ts`
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`
- 教训/测试要点：两版大气对"阴影段内多重散射"的近似不同，属于有意的实现分歧，必须做成显式开关而不是改默认值；单测断言默认值为 false，避免无声改变上游行为。

## F-20260817-001 截图 A/B 对比工具链

- 日期：2026-08-17
- 描述：把"WebGPU 画面是否与 WebGL 肉眼无法区分"变成可复现、可量化的流程。
- 实现要点：
  - `capture.mjs`：Node 22 ESM、零依赖，直接用 `fetch` + `WebSocket` 讲 CDP，拉起 `--headless=new` 的 Chrome（本机 WebGPU 无需额外 flag），支持 `--width/--height/--dpr`、`--settle-frames`（默认 240 帧）、`--wait-gone` 选择器、`--press-key`，并额外导出 canvas 截图与日志。
  - `run-ab.sh`：顺序（共享 GPU，不并行）采集 WebGL 参照页与 WebGPU 页，然后调用 `compare.py`，输出目录默认在 scratchpad 的 `captures/<round>`。
  - `compare.py`：仅依赖 Pillow + numpy，产出 `diff.png` / `diff_signed.png` / `triptych.png` / `blink.gif` / `metrics.json`，指标含 RMSE（全分辨率与 50% 缩放）、PSNR、changed>8/16/32、逐通道有符号均值、最大连通块与启发式 verdict；`--selftest` 用合成图验证相同/噪声/平移三种情形与 CLI 错误码。
- 涉及文件：
  - `scripts/visual-compare/capture.mjs`
  - `scripts/visual-compare/run-ab.sh`
  - `scripts/visual-compare/compare.py`
  - `scripts/visual-compare/README.md`

## F-20260817-002 shadowMap 调试视图移植

- 日期：2026-08-17
- 描述：把 WebGL 的 `DEBUG_SHOW_SHADOW_MAP` 移植到 WebGPU，用于逐级联比对 BSM 内容。
- 实现要点：
  - `shadowSampling.getCascadedShadowMaps()` 把屏幕分成 2×2，按左上、右上、左下、右下的顺序铺开级联切片，超出 `cascadeCount` 的象限保持黑色；通道缩放（frontDepth 1e-5、meanExtinction 10、maxOpticalDepth 0.01）与 WebGL 逐字一致。
  - `CloudsMarchNode` 新增 `debugShow: 'shadowMap'`，在任何步进之前直接返回，depth/velocity 与 shadowLength 写 0，和 WebGL 的早退一致。
  - `screenUV` 是左上角原点而 WebGL `vUv` 是左下角，所以传入前翻转 y，保证两边的级联布局能直接对位。
  - Story 在该调试视图下强制关闭 temporal upscale（与 WebGL `useCloudsControls.ts` 一致），避免重投影扰动原始 BSM。
- 涉及文件：
  - `packages/clouds/src/webgpu/shadowSampling.ts`
  - `packages/clouds/src/webgpu/CloudsMarchNode.ts`
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`

## F-20260817-003 对比用 Story 参数（WebGPU Basic 与 WebGL MinimalSetup）

- 日期：2026-08-17
- 描述：两侧 Story 都补上可从 URL args 控制的开关，使得画面差异可以逐层二分而不必改代码。
- 实现要点：
  - WebGPU `Clouds-Basic`：`dithering` 由 prop 改为 args；Tone Mapping 默认改为 AgX（原 AgXPunchy）以对齐 WebGL；新增 `lensFlare`（bypass 时重建输出节点图与管线）、`raymarchScattering`、`accurateShadowScattering`、`occludeHigherOrderScattering`（默认 true = WebGL 对齐）、`marchDebugShow: 'shadowMap'`。
  - `Clouds-CustomLayers` 通过 args 与 hiddenControl 同步上述改动，不再传 `enableDithering` prop。
  - WebGL `MinimalSetup.stories.tsx` 改写为 CSF3，新增 `clouds`（无云基线开关）、`coverage`、`postEffects`（关闭 LensFlare + ToneMapping 得到线性输出）、`debugShow`（shadowLength / velocity / frontDepth / shadowMap / uv / sampleCount，按 WebGL 的 define 分派到 resolve 与 current 两个 material）、`turbulence`、`shapeDetail`；`shadowMap` 时同样关闭 temporal upscale。
- 涉及文件：
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`
  - `storybook-webgpu/src/clouds/Clouds-CustomLayers.tsx`
  - `storybook/src/clouds/MinimalSetup.stories.tsx`

## F-20260817-004 大气可选项 occludeHigherOrderScattering

- 日期：2026-08-17
- 描述：为 `AtmosphereContext` 增加与 WebGL Bruneton 一致的"阴影段内省略高阶散射"近似开关。
- 实现要点：
  - 默认 `false`，即保持上游 WebGPU 行为（高阶散射不受局部遮挡影响）。
  - 打开后，`runtime.ts` 的三条分支（无阴影、相机在阴影内、相机在阴影外）各自单独查一次高阶散射 LUT：`H = H(camera)`、`H = H(P)`、`H = H(camera) - T(0,a)(H(A) - H(B))`。
  - `multiscattering.ts` 的 raymarch 路径改走"多重散射被阴影衰减"的分支，与天空侧保持一致。
- 涉及文件：
  - `packages/atmosphere/src/webgpu/AtmosphereContext.ts`
  - `packages/atmosphere/src/webgpu/runtime.ts`
  - `packages/atmosphere/src/webgpu/multiscattering.ts`
  - `packages/atmosphere/src/webgpu/AtmosphereContext.test.ts`

## B-20260817-007 groundAlbedo 预计算默认值不同导致大气整体偏亮偏暖

- 日期：2026-08-17
- 状态：已修复（在 Story 侧对齐，不改包默认值）
- 现象：把云完全去掉后（WebGL `clouds:!false` vs WebGPU `coverage:0`），WebGPU 的大气仍整体比 WebGL 亮 3~9/255 且偏暖：全图 RMSE 1.98%，`mean signed B−A = +5.07, +5.14, +3.27`，`changed>8` 占 8.27%，但 `largest_blob` 为 0 px——完全没有结构性色块。这是 round3 之后残差里最大的一项，且位于 clouds 包之外。
- 根因：`groundAlbedo`（地面平均反照率）只在多重散射 LUT 的**预计算**里被消费——`packages/atmosphere/src/webgpu/multiscattering.ts` 的 `computeMultipleScatteringTexture()` 在视线与地面相交时加上 `solarIrradiance · T · cosθ · groundAlbedo / π` 的反弹项；运行时着色器不读这个字段。两个后端的默认值不同：
  - WebGL `AtmosphereParameters`：`groundAlbedo = new Color().setScalar(0.1)`（`packages/atmosphere/src/AtmosphereParameters.ts:164`），且随包发布的**预计算 LUT 贴图就是按 0.1 生成的**。
  - WebGPU `AtmosphereParameters`：`groundAlbedo = new Vector3().setScalar(0.3)`（`packages/atmosphere/src/webgpu/AtmosphereParameters.ts:113`），LUT 在运行时按 0.3 现算。

  地面反弹回大气的能量差了 3 倍，因此天空与空间透视被整体抬亮——正好是"全局偏色、无结构块"的形态。

- 修复方案：归到"上游默认值差异"，**不改包默认值**（WebGPU 包仍为 0.3，改它等于改所有上游使用者的画面），只在对比用的 Clouds Basic Story 加显式 arg：
  - 新增 `groundAlbedo` number arg（`control: range`，min 0、max 1、step 0.01），默认 `DEFAULT_GROUND_ALBEDO = 0.1`。
  - Story 用 `createAtmosphereContext(DEFAULT_GROUND_ALBEDO)` 构造：先 `new AtmosphereParameters()`，写入 `parameters.groundAlbedo.setScalar(v)`，再 `new AtmosphereContext(parameters)`。这样首次 LUT 预计算就用的是对齐值。
  - 运行时改动走 `useTransientControl`：`parameters.groundAlbedo.setScalar(v)` + `lutNode.needsUpdate = true` + `cloudsNode.resetHistory()`。`AtmosphereLUTNode.updateBefore()` 通过 `version !== currentVersion` 判定重算，每次重算都调用 `AtmosphereLUTTextures.createContext()` 新建一个 `AtmosphereContextBase`，其 `parametersNode` 会把新的 `groundAlbedo` 重新烘焙成 WGSL 常量，并重建全部计算核——所以**不需要**重建后处理管线。回调里先做 `parameters.groundAlbedo.x === v` 的幂等判断，避免 `useTransientControl` 每次 render 的初始回调触发无谓的 LUT 重算。
  - `Clouds-CustomLayers` 以 `groundAlbedo: hiddenControl` 同步隐藏。
- 验证证据（1600×900、dpr 1）：
  - 无云基线：RMSE 1.98% → **0.552%**，`mean_abs_diff` 4.505 → 1.070，`mean signed B−A` (+5.07,+5.14,+3.27) → (+0.85,+0.25,−1.38)，`changed>8` 8.27% → **0.012%**，`largest_blob` 保持 0 px。
  - 有云全图（round4）：RMSE 2.16% → **0.976%**，半分辨率 0.782%，PSNR 40.21 dB，`changed>8/16/32` = 2.31%/0.30%/0.015%，最大连通块 88 px，判定 noise-only。
  - 11 个采样区域（天空、云内、地平线带、洋面）的 RGB 均值差全部落在 ±3/255 以内，且不再是"所有区域同号偏亮"。
- 涉及文件：
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`
  - `storybook-webgpu/src/clouds/Clouds-CustomLayers.tsx`
- 教训/测试要点：**预计算参数的默认值差异只会表现为全局偏色**——RMSE 高、`changed>8` 面积大，但 `largest_blob` 为 0。看到这个形态就该去比对两侧 `AtmosphereParameters` 的逐字段默认值，而不是继续在采样/几何/色调曲线上找。另外要区分"参数值不同"与"预计算贴图按哪个值生成"：WebGL 侧真正的约束是随包 LUT 资产已经按 0.1 烘焙，改运行时参数是改不动它的。

## F-20260817-005 Clouds Basic 的 groundAlbedo 对比 arg

- 日期：2026-08-17
- 描述：给 WebGPU Clouds Basic Story 加一个可从 URL args 控制的 `groundAlbedo`，用于对齐 WebGL 预计算 LUT 并在需要时扫参数。
- 实现要点：
  - `groundAlbedo: number`，`control: { type: 'range', min: 0, max: 1, step: 0.01 }`，默认 `DEFAULT_GROUND_ALBEDO = 0.1`（WebGL 对齐值；WebGPU 包默认 0.3 保持不变）。
  - 常量与 `createAtmosphereContext(groundAlbedo)` 工厂放在模块顶层，注释写明两侧默认值的来源行号以及"WebGL 预计算 LUT 资产按 0.1 生成"这一约束。
  - `useResource(() => createAtmosphereContext(DEFAULT_GROUND_ALBEDO), [])` 保证常规路径只算一次 LUT；URL 传了别的值时，`useTransientControl` 的初始回调在同一次 render 内同步执行（早于第一帧的 `postProcessing.render()`，也就早于 `AtmosphereLUTNode.updateBefore()`），因此第一次预计算就用的是目标值。
  - 运行时改动：`setScalar` + `lutNode.needsUpdate = true` + `cloudsNode.resetHistory()`；LUT 改动改变光照，必须丢历史。不重建管线（节点图不变，只是同一批 storage texture 被重新填充）。
  - 与 `raymarchScattering` / `accurateShadowScattering` / `occludeHigherOrderScattering` 一组，都是"atmosphere context 侧"的 A/B 旋钮。
- 涉及文件：
  - `storybook-webgpu/src/clouds/Clouds-Basic.tsx`
  - `storybook-webgpu/src/clouds/Clouds-CustomLayers.tsx`
