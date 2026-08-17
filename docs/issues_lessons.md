# 问题与经验

## 2026-08-14：手动派发的 computeKernel 必须关闭节点自动更新

- `computeKernel()` 适合由运行时提供三维 dispatch，但它本身没有标量 count，因此没有可供自动更新阶段使用的默认 `dispatchSize`。
- 即使业务代码已经调用 `renderer.compute(node, [x, y, z])`，只要该 ComputeNode 仍挂在渲染节点图上，Three 的 `ComputeNode.updateBefore()` 还会再调用一次不带 dispatch 的 `renderer.compute(node)`，最终在 WebGPUBackend 中访问 `null[0]`。
- 对完全由拥有者手动派发的 March、Resolve、ClearHistory 核，应明确设置 `updateBeforeType = NodeUpdateType.NONE`；每帧只允许 `CloudShadowNode.updateBefore()` 这一处按正确三维尺寸执行。

## 2026-08-14：不要对 3D 纹理使用 r183 的 textureSize TSL 节点

- Three r183 的 `TextureSizeNode` 输出类型固定为 `uvec2`。传入 `texture_3d` 时，WGSL 会生成无效的 `vec2<f32>(textureDimensions(texture_3d))`，因为 `textureDimensions` 实际返回 `vec3<u32>`。
- 当纹理尺寸本来就由节点拥有者控制时，直接由 `resolution.xy` 与 `cascadeCount` 构造 `ivec3` 最大坐标更可靠，并把同一边界传给深度邻域查找和 variance clipping。
- TypeScript 和节点图构建无法发现这类错误，必须冷启动真实 WebGPU 页面并检查浏览器的 WGSL 编译输出。

## 2026-08-14：Storybook 虚拟入口 200 还必须提供真实运行时

- Storybook 10 会在 iframe 注入 `/vite-inject-mocker-entry.js`。当前 Storybook/Vite 组合的带 `filter` resolve hook 未生效，直接产生 404。
- 返回空模块虽然能消除 404，却会让预览初始化停在 preparing story；重导出 pnpm store 真实路径又会被 Vite `server.fs.allow` 拒绝。
- 最终方案是在 `viteFinal` 的 pre middleware 中读取 Storybook 打包好的 mocker runtime，并原样返回 JavaScript 内容。验收必须同时检查 HTTP 200、预览首帧和终端中没有 fs allow 错误。

## 2026-08-14：静态云场景必须冻结完整的逐帧随机链

- 只关闭 `temporalUpscale` 和 BSM `temporalJitter` 不足以保证静态画面稳定。主云 march、BSM march、地表阴影 PCF 以及最终 dithering 都可能各自引入逐帧变化。
- 没有历史重建时轮换 STBN slice 只会让噪声持续爬动，不会收敛；非时序路径应固定使用确定性的 STBN slice。
- 通用 `dithering` 节点把 `time` 混入屏幕坐标。对要求逐像素稳定的对比 Story，需要允许关闭这一级后处理，同时不影响其他 Story 的默认画质。
- 本次用浏览器连续截图量化，而不是只凭肉眼判断：修复前静置后仍有约 1.7%–2.3% 像素变化；冻结 PCF 并关闭 Custom Layers 的时变 dithering 后，相隔 3 秒两帧的最大通道差、平均差和变化像素数全部为 0。
- 冷启动 WebGPU 首次编译在高分辨率页面可能超过 45 秒。验收时必须等到 `PostProcessing` 管线完成并出现首帧，再开始稳定性采样，不能把编译中的黑屏误判为运行结果。

## 2026-08-14：TSL compute 的标量 count 不能当三维派发占位值

- `node.compute(1, workgroupSize)` 中的标量 `1` 不只是默认派发尺寸；Three.js 会为它生成 `instanceIndex < 1` 的着色器边界守卫。
- 后续调用 `renderer.compute(node, [x, y, z])` 只覆盖 GPU dispatch 数量，不会移除已经编译进 WGSL 的标量 count 守卫。因此表面上 compute calls 持续增长，实际上只有 global invocation 0 能写入。
- 需要由运行时覆盖三维派发尺寸的计算核，应使用无标量 count 的 `computeKernel()`；这样运行时可安全提供完整的三维 dispatch。
- “没有 GPU error”和“计算核被调用”都不能证明数据有效。体积纹理生产者必须至少读回各 slice 的非零数、范围或校验和，再验证消费者画面。

## 2026-08-14：带平移的局部参考系不能用转置代替逆矩阵

- North-Up-East 的 `matrixWorldToECEF` 同时包含旋转和数百万米的 ECEF 平移；只有纯正交旋转矩阵才满足转置等于逆矩阵。
- 对完整仿射矩阵调用 `transpose()` 会把平移放入齐次行，导致 ECEF 点回到 World 时错误，进而同时破坏云层历史帧重投影、BSM 级联采样和表面阴影。
- `matrixECEFToWorld` 必须对完整矩阵调用 `invert()`，并用“World→ECEF→World 点往返”单元测试覆盖带平移场景。
- 静止画面稳定性不能仅以无 shader error 判断；对展示 Story 应明确控制主云 temporal upscale 和 BSM temporal jitter 的默认值。

## 2026-08-14：自定义云层通道既是数据也是着色器编译配置

- `CloudLayer` 的高度、密度等数值可以通过 uniform 更新，但 RGBA 天气通道的排列会改变节点图生成的 swizzle，属于着色器编译配置。
- 只替换 `CloudsNode.cloudLayers` 的数值会让主步进与云影步进仍使用旧通道，产生画面与阴影不一致。
- 应通过 `CloudsNode.setCloudLayers()` 同时同步两个步进节点的通道、更新云层 uniform，并重置时序历史；新增动态云层入口时不要绕过该方法。

## 2026-08-14：WebGPU 必须做真实着色器编译验证

- TypeScript、ESLint 和 Storybook 构建成功，只能证明节点图在 JavaScript/TypeScript 层合法，不能证明最终 WGSL 合法。
- 后处理节点中再次创建命名为 `viewMatrix` 的相机 `ReferenceNode`，会与全屏通道的内建绑定重名。Three.js 重命名后生成了带点号的 WGSL 成员 `object.viewMatrix_1`，导致着色器编译失败。
- 修复方式是由 `CloudsNode` 持有名称唯一的显式相机 uniform，并在每帧从场景相机同步矩阵和 near 值。
- 以后新增 WebGPU 节点路径时，至少要在真实 WebGPU 页面中触发所有布尔分支，并检查 GPU shader compilation/uncaptured error；不能把类型检查当作运行时验证。

## 2026-08-14：同一份 BSM 数据应服务不同语义的消费者

- 云层自阴影需要 `maxOpticalDepth + maxOpticalDepthTail`，以保留厚云内部的遮蔽。
- 地表/物体阴影应只使用 `maxOpticalDepth`，与 WebGL Aerial Perspective 一致，避免尾部光学深度造成明显锯齿；远处阴影还会自然受到大气入射散射软化。
- 因此采样器共享算法，但通过 `includeTail` 明确表达消费语义，不能复制两套近似实现。

## 2026-08-17：代码逐字相同 ≠ 行为相同

- `helpers/FrustumCorners` 是 WebGL 与 WebGPU 共用的 CPU 代码，一个字都没改，但它把近平面角点写死为 NDC z = -1。WebGL 裁剪空间 z ∈ [-1, 1]，WebGPU 是 [0, 1]，同一行代码在两个后端语义不同。
- 直接后果只有 8e-6 的相对误差（近角点跑到相机后方约 0.5 m），肉眼绝不可能从"半径差了 0.0008%"想到画面问题。
- 放大它的是下游的量化：`CascadedShadowMaps.updateMatrices()` 把光空间中心按 `Math.round(center / texel)` 吸附到整纹素，而 texel 由半径推出。半径跨过吸附边界，整个 cascade 0 就平移一个纹素（此配置约 330 m），地面云影随之整体位移。
- 复用 CPU 代码时，必须逐个审查它对后端约定的隐含假设：NDC z 范围、UV 原点、行序、深度方向。凡是下游存在吸附/取整/量化的量，都要按最终量化结果写断言，而不是按相对误差判断"可忽略"。

## 2026-08-17：TSL 的分量数不参与类型检查

- `CloudsNode.getShadowLengthNode()` 返回 `Node<'float'>`，而大气消费者要 `vec2(长度, 起点距离)`。TypeScript 没报错，WGSL 也编译通过。
- 原因是 TSL 对 float 取 swizzle 是 no-op：Three 的 `SplitNode` 拿 `.x` / `.y` 都返回同一个标量，于是运行时读到的是 `(L, L)`——阴影段起点被当成了长度。
- 这类错误既不会崩也不会花屏，只会让画面"差一点"，是视觉对比里最难查的一类。
- 对策：跨包/跨模块的向量契约要用具名适配函数固定（`shadowLengthFromCamera` / `shadowLengthToPoint`），并用单测断言返回节点的 node type 是 `vec2`、两个分量各自的语义值，而不是只断言数值。

## 2026-08-17：视觉对比要分层二分，不能靠肉眼盯

- 先做无云基线：WebGL 关掉 Clouds、WebGPU 把 coverage 设 0，把"大气本身的差异"从"云的差异"里剥离出来。本次基线 RMSE 1.98%、无结构块、WebGPU 整体亮 3~9/255，于是后续所有残差都要减去这一层再判断。
- 再用调试视图逐层二分：BSM 的 2×2 级联拼贴看阴影贴图内容，`shadowLength` 的 turbo 伪彩看光轴，`frontDepth` / `velocity` / `uv` 看几何与重投影。两侧 Story 都要暴露同一组 `debugShow`，否则没法对位。
- 量化用相关性与平移搜索，不用肉眼：差异图上出现"成对的正负瓣"就是平移而不是强度问题；对 BSM producer 做统计比对（分布一致）能直接排除生产端，把问题锁到消费端的坐标。
- 指标要看结构而不只看均值：本次从 round smoke 到 round3，RMSE 只从 3.28% 降到 2.16%，但最大结构连通块从 45983 px 降到 9 px——RMSE 被全局偏色主导，连通块才反映"肉眼能否看出"。
- 排除法同样要记录：raymarchScattering / accurateShadowScattering 无影响、LensFlare ≤ 1/255、tone curve 两版一致、BSM 里的 turbulence LOD 与 shapeDetail 都不影响位移、太阳位置一致到 0.03°。这些"查过且无关"的结论能避免下一轮重复劳动。

## 2026-08-17：两版大气对阴影段多重散射的近似不同

- WebGL 的 Bruneton 运行时在光轴阴影段内省略高阶（多重）散射；WebGPU 版本注释里写明"regardless of occlusion"，无条件加回去。结果是云影投在洋面上时 WebGPU 只暗了一半。
- 这属于有意的实现分歧，不是 bug：两种做法都自洽，只是能量归属不同。
- 因此正确做法是加显式开关 `AtmosphereContext.occludeHigherOrderScattering`（默认 false = 保持上游行为），由需要 WebGL 对齐的 Story 打开，而不是直接改默认值——上游的其他使用者不该因为对比需求被改变画面。
- 一旦引入这类开关，就必须有单测断言默认值，否则以后很容易被"顺手改成 true"。

## 2026-08-17：预计算参数的默认值差异只会表现为"全局偏色"

- 差异形态本身就是诊断线索：`groundAlbedo` 两侧默认值不同（WebGL 0.1 vs WebGPU 0.3）时，指标是「RMSE 1.98%、`changed>8` 占 8.27%、三通道 `mean signed` 同号为正、`largest_blob` = 0 px」。面积大、无结构块、三通道同号——这只可能是某个全局标量参数，不可能是采样、几何或重投影问题。
- 定位方法是"无云基线 + 参数逐字段回读"：先用 WebGL `clouds:!false` / WebGPU `coverage:0` 把大气从云里剥离出来，再把两侧的 `AtmosphereParameters` 默认值逐字段对照。不要在剥离之前去猜色调曲线或噪声。
- 还要区分"参数值"和"预计算资产按哪个值烘焙"：WebGL 侧真正的约束是随包发布的 LUT 贴图已经按 0.1 生成，运行时改参数改不动它。所以对齐方向只能是让 WebGPU 用 0.1，而不是让 WebGL 用 0.3。
- 处理方式沿用 `occludeHigherOrderScattering` 的先例：**不改包默认值**（上游使用者不该因为对比需求被改画面），只在对比 Story 加显式 arg。上游默认值不同属于"应做成显式开关"，不属于"平台差异、记录后接受"。
- 改动生效机制要落到具体节点：`groundAlbedo` 被烘焙成 WGSL 常量，改字段本身不会生效；`AtmosphereLUTNode` 靠 `version` 判定重算，每次重算都新建 LUT context 并重编译计算核，因此 `lutNode.needsUpdate = true` 就够了，不需要重建后处理管线。凡是"值被烘焙进 shader"的参数，都要先找到它的重编译触发点再写 UI 开关。
- 收益量化：无云基线 RMSE 1.98% → 0.552%（`changed>8` 8.27% → 0.012%），有云全图 2.16% → 0.976%。RMSE 之所以能一次降一半，正是因为它长期被这一层全局偏色主导——这也反过来印证了"判肉眼可辨要看 `largest_blob`，不要看 RMSE"。
