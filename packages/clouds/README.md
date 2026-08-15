# @yong_three/three-clouds — WebGPU

[![npm version](https://img.shields.io/npm/v/@yong_three/three-clouds.svg?style=flat-square)](https://www.npmjs.com/package/@yong_three/three-clouds)

This branch contains the WebGPU implementation of geospatial volumetric
clouds. It is built on the Three.js node API and is published under the
`@yong_three/three-clouds` package scope. It is not an official Takram release.

## Production demo

Open the live WebGPU Storybook at
[`clouds.ceo-online.app`](https://clouds.ceo-online.app/?path=/story/clouds-clouds--basic).

The demo contains three examples:

- [Basic](https://clouds.ceo-online.app/?path=/story/clouds-clouds--basic)
- [Custom Layers](https://clouds.ceo-online.app/?path=/story/clouds-clouds--custom-layers)
- [Vanilla](https://clouds.ceo-online.app/?path=/story/clouds-clouds--vanilla)

![WebGPU volumetric clouds demo](docs/webgpu-clouds-basic.png)

## Installation

The published `0.1.3` release targets Three.js `0.184.x`:

```sh
npm install @yong_three/three-clouds@0.1.3 three@0.184 postprocessing
npm install --save-dev @types/three@0.182
```

The WebGPU entry point is:

```ts
import { clouds } from '@yong_three/three-clouds/webgpu'
```

The complete reference scenes also use the fork's atmosphere and core
changes. For exact scene-surface shadow parity, use this monorepo until the
companion fork packages are published.

## Quick start

`CloudsNode` is composited into a Three.js `RenderPipeline` together with an
atmosphere context and a scene color/depth pass. The renderer must request at
least 32 sampled textures per shader stage.

```ts
import { WebGPURenderer } from 'three/webgpu'
import { clouds } from '@yong_three/three-clouds/webgpu'

const renderer = new WebGPURenderer({
  requiredLimits: {
    maxSampledTexturesPerShaderStage: 32
  }
})
await renderer.init()

const cloudsNode = await clouds(depthNode).loadDefaultTexturesAsync()
cloudsNode.coverage = 0.3
cloudsNode.qualityPreset = 'high'
cloudsNode.localWeatherVelocity.set(0.001, 0)
```

Use the complete [`Clouds-Vanilla.tsx`](https://github.com/ly05010419/three-geospatial/blob/webgpu-clouds-port/storybook-webgpu/src/clouds/Clouds-Vanilla.tsx)
example for a standalone Three.js setup, or
[`Clouds-Basic.tsx`](https://github.com/ly05010419/three-geospatial/blob/webgpu-clouds-port/storybook-webgpu/src/clouds/Clouds-Basic.tsx)
for the Storybook integration.

## Supported features

- Volumetric cloud raymarching with weather, shape, detail, turbulence, haze,
  phase function, aerial perspective, powder, and ground bounce
- Cascaded beer shadow maps (BSM) with temporal resolve
- Temporal upscaling and full-resolution temporal resolve
- Light shafts through resolved cloud shadow length
- Cloud animation through weather, shape, and detail velocity uniforms
- Custom cloud layers through `CloudLayers` and `setCloudLayers()`
- Cloud shadows on scene geometry through
  `getSunTransmittanceNode()` and `AerialPerspectiveNode.sunTransmittanceNode`
- Quality presets, default texture loading, and runtime debug views

## Custom layers

```ts
import { CloudLayers } from '@yong_three/three-clouds'
import { clouds } from '@yong_three/three-clouds/webgpu'

const layers = new CloudLayers([
  {
    channel: 'r',
    altitude: 1000,
    height: 1000,
    shapeAmount: 0.8,
    weatherExponent: 0.6,
    shadow: true
  },
  {
    channel: 'g',
    altitude: 2000,
    height: 800,
    densityScale: 0.1
  }
])

const cloudsNode = clouds(depthNode).loadDefaultTextures()
cloudsNode.setCloudLayers(layers)
```

See [`Clouds-CustomLayers.tsx`](https://github.com/ly05010419/three-geospatial/blob/webgpu-clouds-port/storybook-webgpu/src/clouds/Clouds-CustomLayers.tsx)
for the complete four-layer scene.

## Scene-surface shadows

Cloud self-shadowing and scene-surface shadows are separate paths. Connect the
cloud optical transmittance node to the atmosphere aerial-perspective node:

```ts
aerialNode.sunTransmittanceNode = (positionECEF, builder) =>
  cloudsNode.getSunTransmittanceNode(positionECEF, builder)

postProcessing.needsUpdate = true
```

The scene pass must include normals. Changing this callback requires rebuilding
the render pipeline.

## Loading and animation

`loadDefaultTexturesAsync()` waits for all hosted assets and rejects on a
loading error. `loadDefaultTextures()` starts loading immediately and returns
the node synchronously.

```ts
cloudsNode.localWeatherVelocity.set(0.001, 0)
cloudsNode.shapeVelocity.set(0.0001, 0.0001, 0.0001)
cloudsNode.shapeDetailVelocity.set(0.0002, 0.0002, 0.0002)
```

## Integration options

The WebGPU factory accepts a second argument so applications do not need to
patch the package source or Vite configuration:

```ts
import { clouds } from '@yong_three/three-clouds/webgpu'

const cloudLayer = clouds(depthNode, {
  ellipsoid: gameEllipsoid,
  curvature: {
    referenceRadius: 6_360_000,
    planetRadius: 63_710,
    preserveLocalScale: true
  },
  depth: { mode: 'reversed-z', epsilon: 1e-7 },
  quality: {
    preset: 'high',
    bsm: true,
    lightShafts: true,
    haze: true,
    temporalUpscale: true
  },
  shadows: { dispatchMode: 'automatic' }
}).loadDefaultTextures({ assetBaseUrl: new URL('./assets/', import.meta.url) })
```

`depth.mode` selects the scene-depth comparison (`conventional` or
`reversed-z`). When using `reversed-z`, pass the **original depth texture/node**
from the render pass. Do not call `oneMinus()` (or otherwise invert the depth)
in the host application: the clouds node applies the reversed-Z comparison
itself. Inverting the input first reverses the convention twice and produces
incorrect scene intersections. `ellipsoid` is used for camera geodetic height instead of
implicitly using WGS84. `curvature` is carried as node configuration for
planet-scale integrations and keeps the reference and game radii explicit.

Correct:

```ts
const cloudLayer = clouds(originalDepthNode, {
  depth: { mode: 'reversed-z' }
})
```

Incorrect:

```ts
// Do not invert depth before passing it to the package.
const cloudLayer = clouds(oneMinus(originalDepthNode), {
  depth: { mode: 'reversed-z' }
})
```

When both `referenceFrame` and `planetFrame` are supplied, their east/north/up
bases are converted to a GPU matrix and applied to cloud and shadow shape
sampling.
The cloud/atmosphere WGSL helper is emitted as `getCloudLayerDensity`, so the
two pipelines can be composed without a Vite string replacement.

Runtime controls are available on the returned `CloudsNode`:

```ts
cloudLayer.setEnabled(false)
cloudLayer.setCoverage(0.35)
cloudLayer.setQuality({ preset: 'medium', bsm: false })
cloudLayer.maxRayDistance = 100_000
cloudLayer.resetHistory()
cloudLayer.updateShadowMaps(frame) // only when dispatchMode is 'explicit'
cloudLayer.dispose()
```

`setEnabled()` updates the `cloudsEnabled` GPU uniform. It is safe to call
after the renderer has built the pipeline; no material or shader rebuild is
triggered.

Set `shadows.enabled: false` to skip the BSM dispatch entirely. For an
application-owned frame graph, use `dispatchMode: 'explicit'` and call
`updateShadowMaps(frame)` exactly once per frame.

## Current limitations

- Advanced parameters remain available through `parameterUniforms`,
  `marchNode`, `shadowNode`, and `resolveNode`.
- 3D Tiles and world-origin-rebasing scenes are not ported in this branch.
- Procedural texture nodes are supported, but the validated parity path uses
  the hosted default texture assets.

## Local Storybook

```sh
pnpm install
pnpm nx storybook storybook-webgpu --port=4004 --no-open
```

Then open:

- [Basic](http://localhost:4004/?path=/story/clouds-clouds--basic)
- [Custom Layers](http://localhost:4004/?path=/story/clouds-clouds--custom-layers)
- [Vanilla](http://localhost:4004/?path=/story/clouds-clouds--vanilla)

Recommended checks:

```sh
pnpm exec tsc --noEmit -p storybook-webgpu/tsconfig.storybook.json
pnpm exec nx typecheck clouds
pnpm exec nx test clouds
pnpm exec nx build clouds
```

## License

[MIT](../../LICENSE)
