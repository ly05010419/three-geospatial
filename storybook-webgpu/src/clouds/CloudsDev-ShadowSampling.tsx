// M3 verification probe for shadowSampling.ts (the BSM consumer library).
// Renders 4 tiles over a synthetic BSM Data3DTexture whose decode results are
// known analytically. Green = pass, red = fail; lower halves show raw values.
//
// Setup: the "planet" has bottomRadius 6360000 and shadowTopHeight 1000. The
// probe ray position sits at height 0 on the +z axis with the sun straight up,
// so distanceToTop = 1000 (within f32 cancellation error of ~1). The view
// matrix places the position at orthographic depth 0.2, inside cascade 0, and
// shadow matrix 0 projects it to uv (0.5, 0.5). Every texel of BSM slice i is
// (r, g, b, a) = (0, 0.01·(i+1), 2000, 1000), thus:
//   readShadowOpticalDepth = min(b + a, g·(distanceToTop − offset − r))
//                          = min(3000, 10·(i+1)) at zero offset.

import styled from '@emotion/styled'
import { ScreenQuad } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useMemo, type FC } from 'react'
import {
  Data3DTexture,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Matrix4,
  NoColorSpace,
  NoToneMapping,
  RGBAFormat,
  Vector2,
  Vector3
} from 'three'
import {
  Fn,
  float,
  int,
  positionGeometry,
  screenUV,
  select,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import { NodeMaterial, type Renderer } from 'three/webgpu'

import {
  createCloudShadowUniforms,
  getFadedCascadeIndex,
  readShadowOpticalDepth,
  sampleShadowOpticalDepth,
  type CloudShadowSamplingDependencies
} from '@takram/three-clouds/webgpu'
import type { Node } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../components/createStory'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import {
  rendererArgs,
  rendererArgTypes,
  type RendererArgs
} from '../controls/rendererControls'
import { useResource } from '../hooks/useResource'

const passColor = /*#__PURE__*/ vec4(0.1, 0.6, 0.25, 1)
const failColor = /*#__PURE__*/ vec4(0.8, 0.1, 0.1, 1)

const status = (pass: Node<'bool'>): Node<'vec4'> =>
  select(pass, passColor, failColor)

const BOTTOM_RADIUS = 6360000
const SHADOW_TOP_HEIGHT = 1000
const CASCADE_COUNT = 4
const MAP_SIZE = 16

// Every texel of slice i is (0, 0.01·(i+1), 2000, 1000):
function createShadowTexture(): Data3DTexture {
  const data = new Float32Array(MAP_SIZE * MAP_SIZE * CASCADE_COUNT * 4)
  for (let z = 0; z < CASCADE_COUNT; ++z) {
    for (let i = 0; i < MAP_SIZE * MAP_SIZE; ++i) {
      const index = (z * MAP_SIZE * MAP_SIZE + i) * 4
      data[index + 0] = 0 // frontDepth
      data[index + 1] = 0.01 * (z + 1) // meanExtinction
      data[index + 2] = 2000 // maxOpticalDepth
      data[index + 3] = 1000 // maxOpticalDepthTail
    }
  }
  const texture = new Data3DTexture(data, MAP_SIZE, MAP_SIZE, CASCADE_COUNT)
  texture.type = FloatType
  texture.format = RGBAFormat
  // Linear filtering as in the actual BSM, so that any cross-slice bleed at
  // w = (i + 0.5) / N blends the distinct per-slice values and fails:
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.colorSpace = NoColorSpace
  texture.needsUpdate = true
  return texture
}

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  renderer.toneMapping = NoToneMapping
  renderer.outputColorSpace = LinearSRGBColorSpace

  const [material, shadowTexture] = useResource(
    manage => manage(new NodeMaterial(), createShadowTexture()),
    []
  )

  useMemo(() => {
    const shadowUniforms = createCloudShadowUniforms()
    shadowUniforms.shadowTexelSize.value.set(1 / MAP_SIZE, 1 / MAP_SIZE)
    shadowUniforms.shadowFar.value = 1001
    const intervals = [
      [0, 0.33],
      [0.33, 0.66],
      [0.66, 0.85],
      [0.85, 1]
    ] as const
    intervals.forEach(([min, max], index) => {
      shadowUniforms.shadowIntervals.array[index].set(min, max)
    })
    // Shadow matrix 0 projects the probe position to clip (0, 0) with w = 1,
    // that is uv (0.5, 0.5). The other cascades project far off-screen:
    shadowUniforms.shadowMatrices.array[0].makeTranslation(0, 0, -BOTTOM_RADIUS)
    for (let i = 1; i < CASCADE_COUNT; ++i) {
      shadowUniforms.shadowMatrices.array[i]
        .makeTranslation(10, 10, -BOTTOM_RADIUS)
    }

    const dependencies: CloudShadowSamplingDependencies = {
      bottomRadius: uniform(BOTTOM_RADIUS).setName('bottomRadius'),
      sunDirectionECEF: uniform(new Vector3(0, 0, 1)).setName(
        'sunDirectionECEF'
      ),
      shadowTopHeight: uniform(SHADOW_TOP_HEIGHT).setName('shadowTopHeight'),
      matrixECEFToWorld: uniform(new Matrix4()).setName('matrixECEFToWorld'),
      altitudeCorrectionECEF: uniform(new Vector3()).setName(
        'altitudeCorrectionECEF'
      ),
      // Puts the probe position at viewZ = -201, i.e. orthographic depth 0.2
      // with near = 1 and far = 1001 — inside cascade 0:
      viewMatrix: uniform(
        new Matrix4().makeTranslation(0, 0, -(BOTTOM_RADIUS + 201))
      ).setName('probeViewMatrix'),
      cameraNear: uniform(1).setName('cameraNear'),
      temporalJitter: uniform(new Vector2()).setName('temporalJitter'),
      resolution: uniform(new Vector2(1, 1)).setName('resolution')
    }

    const shadowBuffer = texture3D(shadowTexture)
    const options = { cascadeCount: CASCADE_COUNT, shadowSampleCount: 8 }
    const sampleShadowOpticalDepthFn = sampleShadowOpticalDepth(
      shadowBuffer,
      shadowUniforms,
      dependencies,
      options
    )
    const readShadowOpticalDepthFn = readShadowOpticalDepth(
      shadowBuffer,
      options
    )
    const getFadedCascadeIndexFn = getFadedCascadeIndex(shadowUniforms, options)

    material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    material.colorNode = Fn(() => {
      const uv = screenUV.toVar()
      const column = int(uv.x.mul(2)).min(1).toVar()
      const row = int(uv.y.mul(2)).min(1).toVar()
      const tileUV = vec2(uv.x.mul(2).fract(), uv.y.mul(2).fract()).toVar()
      const strip = int(tileUV.x.mul(4)).min(3).toVar()
      const lower = tileUV.y.greaterThan(0.5)

      const rayPosition = vec3(0, 0, BOTTOM_RADIUS).toConst()
      const jitter = float(0.5).toConst()
      // distanceToTop carries ~1 of f32 cancellation error at this magnitude:
      const tolerance = 0.2

      // (a) Full chain, radius < 0.1 (single-tap read path). Slice 0 decodes
      // to min(3000, 10 · distanceToTop / 1000) = 10:
      const a = sampleShadowOpticalDepthFn(rayPosition, 0, 0, jitter).toVar()
      const probeA = select(
        lower,
        vec4(vec3(a.mul(0.1)), 1),
        status(a.sub(10).abs().lessThan(tolerance))
      )

      // (b) Full chain, radius = 4 (Vogel PCF path). The slice is uniform, so
      // the 8-tap average must equal the single tap:
      const b = sampleShadowOpticalDepthFn(rayPosition, 0, 4, jitter).toVar()
      const probeB = select(
        lower,
        vec4(vec3(b.mul(0.1)), 1),
        status(b.sub(10).abs().lessThan(tolerance))
      )

      // (c) readShadowOpticalDepth per cascade slice at w = (i + 0.5) / N.
      // Slice i must decode to 10·(i+1); cross-slice bleed fails this:
      const slicesPass = [0, 1, 2, 3]
        .map(index =>
          readShadowOpticalDepthFn(vec2(0.5), 1000, 0, int(index))
            .sub(10 * (index + 1))
            .abs()
            .lessThan(0.5)
        )
        .reduce((a, b) => a.and(b))
      const sliceRaw = readShadowOpticalDepthFn(tileUV, 1000, 0, strip)
      const probeC = select(
        lower,
        vec4(vec3(sliceRaw.mul(0.025)), 1),
        status(slicesPass)
      )

      // (d) distanceOffset shortens distanceToFront: expect ~5 at offset 500.
      // A position at view depth beyond every faded cascade interval returns
      // -1 from getFadedCascadeIndex and 0 from the full chain:
      const d = sampleShadowOpticalDepthFn(rayPosition, 500, 0, jitter).toVar()
      const beyondPosition = vec3(0, 0, BOTTOM_RADIUS + 800).toConst()
      const beyondIndex = getFadedCascadeIndexFn(
        dependencies.viewMatrix,
        beyondPosition,
        dependencies.cameraNear,
        jitter
      ).toVar()
      const beyond = sampleShadowOpticalDepthFn(
        beyondPosition,
        0,
        0,
        jitter
      ).toVar()
      const probeD = select(
        lower,
        vec4(vec3(d.mul(0.1)), 1),
        status(
          d.sub(5)
            .abs()
            .lessThan(tolerance)
            .and(beyondIndex.equal(-1))
            .and(beyond.abs().lessThan(1e-6))
        )
      )

      // screenUV's origin is at the top-left corner:
      return select(
        row.equal(0),
        select(column.equal(0), probeA, probeB),
        select(column.equal(0), probeC, probeD)
      )
    })()
  }, [material, shadowTexture])

  return <ScreenQuad material={material} />
}

const Overlay = styled('div')`
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, 1fr);
  pointer-events: none;
`

const Label = styled('div')`
  padding: 8px;
  color: white;
  font-size: small;
  letter-spacing: 0.02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
`

const LABELS = [
  '(a) sampleShadowOpticalDepth, read path = 10',
  '(b) sampleShadowOpticalDepth, Vogel PCF path = 10',
  '(c) readShadowOpticalDepth slices = 10·(i+1), no bleed',
  '(d) distanceOffset = 5; beyond cascades = -1/0'
]

export const Story: StoryFC<{}, RendererArgs> = () => (
  <>
    <WebGPUCanvas>
      <Content />
    </WebGPUCanvas>
    <Overlay>
      {LABELS.map(label => (
        <Label key={label}>{label}</Label>
      ))}
    </Overlay>
  </>
)

Story.args = {
  ...rendererArgs()
}

Story.argTypes = {
  ...rendererArgTypes()
}

export default Story
