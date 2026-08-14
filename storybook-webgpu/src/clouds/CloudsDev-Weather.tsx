import styled from '@emotion/styled'
import { ScreenQuad } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useMemo, type FC } from 'react'
import {
  Data3DTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  NoColorSpace,
  NoToneMapping,
  RepeatWrapping,
  TextureLoader,
  Vector2,
  Vector3
} from 'three'
import {
  float,
  Fn,
  int,
  positionGeometry,
  screenUV,
  select,
  texture,
  texture3D,
  vec3,
  vec4
} from 'three/tsl'
import { NodeMaterial, type Renderer } from 'three/webgpu'

import { CloudLayers, DEFAULT_LOCAL_WEATHER_URL } from '@yong/three-clouds'
import {
  createCloudLayerUniforms,
  createCloudParameterUniforms,
  sampleWeather,
  updateCloudLayerUniforms
} from '@yong/three-clouds/webgpu'
import type { Node } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../components/createStory'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import {
  rendererArgs,
  rendererArgTypes,
  type RendererArgs
} from '../controls/rendererControls'
import { useControl } from '../hooks/useControl'
import { useResource } from '../hooks/useResource'

function createWeatherTexture(): ReturnType<TextureLoader['load']> {
  // The same sampler state as the WebGL texture loading path (r3f/Clouds.tsx):
  return new TextureLoader().load(DEFAULT_LOCAL_WEATHER_URL, texture => {
    texture.minFilter = LinearMipmapLinearFilter
    texture.magFilter = LinearFilter
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.colorSpace = NoColorSpace
    texture.needsUpdate = true
  })
}

// sampleWeather doesn't read the shape texture, but CloudSamplingTextures
// requires it. Provide a 1×1×1 placeholder:
function createDummyShapeTexture(): Data3DTexture {
  const texture = new Data3DTexture(new Uint8Array(4), 1, 1, 1)
  texture.needsUpdate = true
  return texture
}

// Component of a vec4 selected by a dynamic lane index:
const lane = (value: Node<'vec4'>, index: Node<'int'>): Node<'float'> =>
  select(
    index.equal(0),
    value.x,
    select(index.equal(1), value.y, select(index.equal(2), value.z, value.w))
  )

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  renderer.toneMapping = NoToneMapping
  renderer.outputColorSpace = LinearSRGBColorSpace

  const [material, weatherTexture, shapeTexture] = useResource(
    manage =>
      manage(
        new NodeMaterial(),
        createWeatherTexture(),
        createDummyShapeTexture()
      ),
    []
  )

  const { parameterUniforms } = useMemo(() => {
    const parameterUniforms = createCloudParameterUniforms({
      localWeatherRepeat: new Vector2(1, 1),
      localWeatherOffset: new Vector2(),
      shapeRepeat: new Vector3(),
      shapeOffset: new Vector3(),
      shapeDetailRepeat: new Vector3(),
      shapeDetailOffset: new Vector3(),
      turbulenceRepeat: new Vector2()
    })
    const layerUniforms = createCloudLayerUniforms()
    updateCloudLayerUniforms(layerUniforms, CloudLayers.DEFAULT)

    const sampleWeatherFn = sampleWeather(parameterUniforms, layerUniforms, {
      localWeatherTexture: texture(weatherTexture),
      shapeTexture: texture3D(shapeTexture)
    })

    material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    material.colorNode = Fn(() => {
      // Divide the screen into 2×2 quadrants, one per density lane.
      // screenUV's origin is at the top-left corner, thus the lanes read
      // x, y (top row), z, w (bottom row):
      const uv = screenUV.toVar()
      const column = int(uv.x.mul(2)).min(1).toVar()
      const row = int(uv.y.mul(2)).min(1).toVar()
      const laneIndex = row.mul(2).add(column).toVar()
      const tileUV = uv.mul(2).fract().toVar()

      // Sample the weather at the middle height of each lane's layer, which
      // makes the height fraction 0.5 for the lane on display:
      const minLayerHeights = vec4(layerUniforms.minLayerHeights).toVar()
      const maxLayerHeights = vec4(layerUniforms.maxLayerHeights).toVar()
      const midHeights = minLayerHeights.add(maxLayerHeights).mul(0.5).toVar()
      const height = lane(midHeights, laneIndex).toVar()

      const weather = sampleWeatherFn(tileUV, height, float(0))
      const value = lane(weather.get('density'), laneIndex).toVar()

      // Layers with zero height (layer 3 in CloudLayers.DEFAULT) yield NaN
      // height fractions. Display them as black; this guard is display-only
      // and doesn't alter the weather sampling under test:
      const empty = lane(maxLayerHeights, laneIndex).lessThanEqual(
        lane(minLayerHeights, laneIndex)
      )
      return vec4(vec3(select(empty, float(0), value)), 1)
    })()

    return { parameterUniforms }
  }, [material, weatherTexture, shapeTexture])

  const coverage = useControl(({ coverage }: StoryArgs) => coverage)
  parameterUniforms.coverage.value = coverage
  const repeat = useControl(({ repeat }: StoryArgs) => repeat)
  parameterUniforms.localWeatherRepeat.value.setScalar(repeat)

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
  'density.x — layer 0 at mid height',
  'density.y — layer 1 at mid height',
  'density.z — layer 2 at mid height',
  'density.w — layer 3 (empty by default)'
]

interface StoryArgs extends RendererArgs {
  coverage: number
  repeat: number
}

export const Story: StoryFC<{}, StoryArgs> = () => (
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
  coverage: 0.3,
  repeat: 1,
  ...rendererArgs()
}

Story.argTypes = {
  coverage: {
    control: {
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01
    }
  },
  repeat: {
    control: {
      type: 'range',
      min: 1,
      max: 8,
      step: 1
    }
  },
  ...rendererArgTypes()
}

export default Story
