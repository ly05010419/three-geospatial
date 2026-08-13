# WebGPU Clouds Status

The WebGPU port lives under the `@takram/three-clouds/webgpu` subpath. It is a
node-based API centered on `clouds(depthNode?)` and `CloudsNode`, not a drop-in
replacement for the WebGL `CloudsEffect` or the r3f `<Clouds>` component.

## Basic Parity

The `storybook-webgpu` story `clouds/Clouds > Basic` is the current parity
target for the WebGL `clouds/Clouds > Basic` story. It uses the frozen
comparison pose and date from `.port-plan.md`, the default hosted weather/shape
textures, `coverage = 0.3`, `qualityPreset = "high"`, temporal upscaling,
BSM shadows, haze, and light shafts.

Accepted differences from the WebGL story:

- WebGL keeps SMAA in the post chain; the WebGPU Basic parity story does not.
- AgX and lens-flare implementations are different libraries, so small
  post-tonemap differences are expected.
- Temporal noise phase can differ after both temporal chains have settled.
- The WebGPU BSM uses 3D storage textures instead of WebGL array render
  targets; this is architecturally different but intended to be visually
  equivalent.

## Implemented

- Cloud raymarching with weather, shape, detail, turbulence, haze, phase
  function, aerial perspective, powder, and ground bounce.
- Cascaded BSM generation and temporal resolve.
- Temporal upscaling and full-resolution temporal resolve.
- Light shafts through resolved shadow length.
- Default cloud texture loading for WebGPU.
- Quality preset application for the WebGPU node pipeline.
- Runtime toggles for `bsm`, `temporalUpscale`, `lightShafts`, `haze`,
  `shapeDetail`, and `turbulence`, with history resets where needed.
- Debug views for march `uv`, `sampleCount`, `frontDepth`, `shadowLength`, and
  resolve `velocity`, `shadowLength`.
- Vanilla WebGPU story without r3f scene helpers.

## Not 1:1

- No WebGPU r3f `<Clouds>` wrapper is provided.
- `CloudsNode` does not mirror every `CloudsEffect` getter/setter. Advanced
  parameters are available through `parameterUniforms`, `marchNode`,
  `shadowNode`, and `resolveNode`.
- WebGL demo stories such as custom layers, 3D tiles, and world-origin rebasing
  are not ported.
- The WebGPU Basic story intentionally exposes fewer controls than the WebGL
  leva panel; it focuses on parity-critical toggles and debug views.
- Procedural texture nodes are supported, but the validated parity path uses
  the hosted default texture assets.

## Verification

Recommended local gates:

```sh
pnpm exec tsc --noEmit -p storybook-webgpu/tsconfig.storybook.json
pnpm exec nx typecheck clouds
pnpm exec nx test clouds
pnpm exec nx build clouds
```

Visual parity should be checked against:

- WebGPU:
  `http://127.0.0.1:6006/iframe.html?id=clouds-clouds--basic&viewMode=story`
- WebGL frozen pose:
  `http://127.0.0.1:6007/iframe.html?id=clouds-minimal-setup--minimal-setup&viewMode=story`
- WebGL interactive Basic:
  `http://127.0.0.1:6007/iframe.html?id=clouds-clouds--basic&viewMode=story`

Wait at least 120 frames before comparing captures so both cloud upscaling and
BSM history are settled. Structural differences in cloud placement, shadow
placement, or light-shaft direction should be treated as bugs rather than tuned
away with constants. Do not use the WebGL interactive Basic story for direct
RMSE unless its leva controls and frozen parameters have been locked first.
