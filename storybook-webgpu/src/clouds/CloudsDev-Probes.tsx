import styled from '@emotion/styled'
import { ScreenQuad } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef, type FC } from 'react'
import {
  Data3DTexture,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Matrix4,
  NoColorSpace,
  NoToneMapping,
  RedFormat,
  RenderTarget
} from 'three'
import {
  Fn,
  float,
  globalId,
  int,
  ivec2,
  ivec3,
  mod,
  mrt,
  positionGeometry,
  screenCoordinate,
  screenUV,
  select,
  texture,
  texture3D,
  textureStore,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import {
  NodeMaterial,
  QuadMesh,
  Storage3DTexture,
  type Renderer
} from 'three/webgpu'

import { bayerIndex, bayerOffsets } from '@yong/three-clouds/webgpu'
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

const approx = (a: Node<'vec3'>, b: Node<'vec3'>): Node<'bool'> =>
  a.sub(b).abs().lessThan(0.01).all()

// Distinct color per slice, used by both the compute and display shaders:
const sliceColor = (slice: Node<'int'>): Node<'vec3'> =>
  vec3(
    select(slice.equal(0).or(slice.equal(3)), 1, 0),
    select(slice.equal(1).or(slice.equal(3)), 1, 0),
    select(slice.equal(2), 1, 0)
  )

// (a) MRT into RenderTarget{count:3} with textures[2].format = RedFormat:
function createMRTRenderTarget(): RenderTarget {
  const renderTarget = new RenderTarget(16, 16, {
    count: 3,
    depthBuffer: false,
    type: HalfFloatType
  })
  const [output, depthVelocity, shadowLength] = renderTarget.textures
  output.name = 'output'
  depthVelocity.name = 'depthVelocity'
  shadowLength.name = 'shadowLength'
  shadowLength.format = RedFormat
  return renderTarget
}

// (b) rgba16f Storage3DTexture written by compute, one color per slice:
const STORAGE_SIZE = 16
const STORAGE_DEPTH = 4

function createStorageTexture(): Storage3DTexture {
  const texture = new Storage3DTexture(STORAGE_SIZE, STORAGE_SIZE, STORAGE_DEPTH)
  texture.type = HalfFloatType
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.colorSpace = NoColorSpace
  texture.generateMipmaps = false
  return texture
}

// (e) Mipmapped texture with a checkerboard base level, so that the coarsest
// level averages to 0.5:
const MIP_SIZE = 16

function createMipTexture(): DataTexture {
  const data = new Uint8Array(MIP_SIZE * MIP_SIZE * 4)
  for (let y = 0; y < MIP_SIZE; ++y) {
    for (let x = 0; x < MIP_SIZE; ++x) {
      const value = (x + y) % 2 === 0 ? 255 : 0
      data.set([value, value, value, 255], (y * MIP_SIZE + x) * 4)
    }
  }
  const texture = new DataTexture(data, MIP_SIZE, MIP_SIZE)
  texture.magFilter = LinearFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

// (f) Data3DTexture with texel values derived from their coordinates:
const VOLUME_SIZE = 4

function createVolumeTexture(): Data3DTexture {
  const data = new Uint8Array(VOLUME_SIZE ** 3 * 4)
  for (let z = 0; z < VOLUME_SIZE; ++z) {
    for (let y = 0; y < VOLUME_SIZE; ++y) {
      for (let x = 0; x < VOLUME_SIZE; ++x) {
        const index = ((z * VOLUME_SIZE + y) * VOLUME_SIZE + x) * 4
        data.set([x * 85, y * 85, z * 85, 255], index)
      }
    }
  }
  const texture = new Data3DTexture(data, VOLUME_SIZE, VOLUME_SIZE, VOLUME_SIZE)
  texture.needsUpdate = true
  return texture
}

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  renderer.toneMapping = NoToneMapping
  renderer.outputColorSpace = LinearSRGBColorSpace

  const [
    material,
    mrtMaterial,
    mrtRenderTarget,
    storageTexture,
    mipTexture,
    volumeTexture
  ] = useResource(
    manage =>
      manage(
        new NodeMaterial(),
        new NodeMaterial(),
        createMRTRenderTarget(),
        createStorageTexture(),
        createMipTexture(),
        createVolumeTexture()
      ),
    []
  )

  const { frame, computeNode } = useMemo(() => {
    const frame = uniform(0, 'int').setName('frame')
    const matrices = uniformArray(
      Array.from(
        { length: 4 },
        (_, index) =>
          new Matrix4().makeTranslation(
            index * 0.25 + 0.1,
            1 - index * 0.25,
            index * 0.2
          )
      )
    )
    const negativeOne = uniform(-1)
    const negativeFiveHalf = uniform(-5.5)
    const four = uniform(4)
    const offsets = uniformArray(
      bayerOffsets.map(offset => offset.clone()),
      'vec2'
    )

    const computeNode = Fn(() => {
      textureStore(
        storageTexture,
        globalId,
        vec4(sliceColor(int(globalId.z)), 1)
      )
    })()
      // @ts-expect-error The count can be dimensional.
      .compute([STORAGE_SIZE / 4, STORAGE_SIZE / 4, 1], [4, 4, STORAGE_DEPTH])
      .setName('storageProbe')

    mrtMaterial.vertexNode = vec4(positionGeometry.xy, 0, 1)
    mrtMaterial.mrtNode = mrt({
      output: vec4(0.2, 0.4, 0.6, 1),
      depthVelocity: vec4(0.8, 0.1, 0.7, 1),
      shadowLength: vec4(0.5, 0.33, 0.66, 1)
    })

    material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    material.colorNode = Fn(() => {
      const uv = screenUV.toVar()
      const column = int(uv.x.mul(4)).min(3).toVar()
      const row = int(uv.y.mul(2)).min(1).toVar()
      const tileUV = vec2(uv.x.mul(4).fract(), uv.y.mul(2).fract()).toVar()
      const strip = int(tileUV.x.mul(4)).min(3).toVar()
      // screenUV's origin is at the top-left corner:
      const lower = tileUV.y.greaterThan(0.5)

      // (a) NodeMaterial.mrtNode into count:3 with a RedFormat attachment.
      // If the RedFormat reinterpretation failed, the third attachment
      // retains its green and blue channels and turns the tile red.
      const output = texture(mrtRenderTarget.textures[0], tileUV)
        .level(float(0))
        .toVar()
      const depthVelocity = texture(mrtRenderTarget.textures[1], tileUV)
        .level(float(0))
        .toVar()
      const shadowLength = texture(mrtRenderTarget.textures[2], tileUV)
        .level(float(0))
        .toVar()
      const mrtPass = approx(output.rgb, vec3(0.2, 0.4, 0.6))
        .and(approx(depthVelocity.rgb, vec3(0.8, 0.1, 0.7)))
        .and(approx(shadowLength.rgb, vec3(0.5, 0, 0)))
      const mrtRaw = select(
        strip.equal(0),
        output,
        select(strip.equal(1), depthVelocity, shadowLength)
      )
      const probeA = select(lower, mrtRaw, status(mrtPass))

      // (b) Storage3DTexture slices sampled at w = (i + 0.5) / N. Any
      // cross-slice bleed under linear filtering blends the distinct slice
      // colors and fails the comparison.
      const slicesPass = [0, 1, 2, 3]
        .map(index =>
          approx(
            texture3D(
              storageTexture,
              vec3(0.5, 0.5, (index + 0.5) / STORAGE_DEPTH)
            )
              .level(float(0))
              .rgb,
            sliceColor(int(index))
          )
        )
        .reduce((a, b) => a.and(b))
      const sliceRaw = texture3D(
        storageTexture,
        vec3(tileUV, float(strip).add(0.5).div(STORAGE_DEPTH))
      ).level(float(0))
      const probeB = select(lower, vec4(sliceRaw.rgb, 1), status(slicesPass))

      // (c) uniformArray of Matrix4[4] indexed dynamically per-fragment:
      const translation = matrices
        .element(strip)
        .mul(vec4(0, 0, 0, 1))
        .xyz.toVar()
      const expectedTranslation = vec3(
        float(strip).mul(0.25).add(0.1),
        float(strip).mul(0.25).oneMinus(),
        float(strip).mul(0.2)
      )
      const probeC = select(
        lower,
        vec4(translation, 1),
        status(approx(translation, expectedTranslation))
      )

      // (d) mod() WGSL codegen for negative operands. Floored semantics
      // (GLSL mod) yields 3 and 2.5; truncated (WGSL %) yields -1 and -1.5.
      const modPass = mod(negativeOne, four)
        .sub(3)
        .abs()
        .lessThan(1e-4)
        .and(mod(negativeFiveHalf, four).sub(2.5).abs().lessThan(1e-4))
      const probeD = status(modPass)

      // (e) Explicit-LOD sampling of a mipmapped texture in fragment. The
      // coarsest level averages the checkerboard to 0.5; without mipmaps
      // the level clamps to 0 and reads 1 at the center texel.
      const lodBase = texture(mipTexture, vec2(0.5 / MIP_SIZE)).level(float(0))
      const lodTop = texture(mipTexture, vec2(0.5)).level(float(4))
      const lodPass = lodBase.r
        .greaterThan(0.9)
        .and(lodTop.r.sub(0.5).abs().lessThan(0.05))
      const lodRamp = texture(mipTexture, tileUV).level(tileUV.x.mul(5))
      const probeE = select(lower, lodRamp, status(lodPass))

      // (f) textureLoad of a Data3DTexture at integer coordinates:
      const loadPass = [0, 1, 2, 3]
        .map(index =>
          approx(
            texture3D(volumeTexture, ivec3(index, 3 - index, index)).setSampler(
              false
            ).rgb,
            vec3(index / 3, (3 - index) / 3, index / 3)
          )
        )
        .reduce((a, b) => a.and(b))
      const loadRaw = texture3D(
        volumeTexture,
        ivec3(strip, int(3).sub(strip), strip)
      ).setSampler(false)
      const probeF = select(lower, vec4(loadRaw.rgb, 1), status(loadPass))

      // (g) Bayer reconstruction: bayerIndex must invert the CPU-side
      // bayerOffsets, and the pixel whose index equals frame % 16 must be
      // the one the CPU offset points at. Renders black when consistent.
      const coord = ivec2(screenCoordinate.xy).toVar()
      const tileCoord = coord.mod(4).toVar()
      const index = bayerIndex(tileCoord).toVar()
      const reconstructed = ivec2(offsets.element(index).mul(4))
      const inversePass = reconstructed.equal(tileCoord).all()
      const frameIndex = frame.mod(16).toVar()
      const expectedTexel = ivec2(offsets.element(frameIndex).mul(4))
      const framePass = index
        .equal(frameIndex)
        .equal(tileCoord.equal(expectedTexel).all())
      const probeG = select(
        inversePass.and(framePass),
        vec4(0, 0, 0, 1),
        failColor
      )

      const info = vec4(vec3(0.1), 1)
      return select(
        row.equal(0),
        select(
          column.equal(0),
          probeA,
          select(column.equal(1), probeB, select(column.equal(2), probeC, probeD))
        ),
        select(
          column.equal(0),
          probeE,
          select(column.equal(1), probeF, select(column.equal(2), probeG, info))
        )
      )
    })()

    return { frame, computeNode }
  }, [material, mrtMaterial, mrtRenderTarget, storageTexture, mipTexture, volumeTexture])

  const quadMesh = useMemo(() => new QuadMesh(mrtMaterial), [mrtMaterial])
  const initializedRef = useRef(false)
  useFrame(() => {
    frame.value += 1
    if (initializedRef.current) {
      return
    }
    initializedRef.current = true
    void renderer.compute(computeNode)
    renderer.setRenderTarget(mrtRenderTarget)
    quadMesh.render(renderer)
    renderer.setRenderTarget(null)
  })

  return <ScreenQuad material={material} />
}

const Overlay = styled('div')`
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
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
  '(a) MRT count:3, RedFormat attachment',
  '(b) Storage3DTexture compute, texture3D().level(0) slices',
  '(c) uniformArray Matrix4[4], dynamic index',
  '(d) mod() floored codegen',
  '(e) sample().level() of mipmapped texture',
  '(f) textureLoad of Data3DTexture',
  '(g) Bayer reconstruction (black = pass)',
  'Green = pass, red = fail; lower halves show raw patterns'
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
