// BSM (beer shadow map) slice viewer for the M3 verification (.port-plan.md).
// Drives CloudShadowNode standalone as a miniature facade: updates the
// cascaded shadow maps at the frozen camera pose of the Basic story every
// frame and displays the cascades in 2×2 quadrants with the debug scales of
// the DEBUG_SHOW_SHADOW_MAP view in the WebGL clouds.frag:
// (shadow.rgb + vec3(0, 0, shadow.a)) · (frontDepth 1e-5, meanExtinction 10,
// maxOpticalDepth 0.01). A/B against the WebGL Basic story with the leva
// debug.showShadowMap toggle enabled at the same camera.

import styled from '@emotion/styled'
import { ScreenQuad } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useLayoutEffect, useRef, type FC } from 'react'
import {
  LinearSRGBColorSpace,
  NoToneMapping,
  Vector3,
  type PerspectiveCamera
} from 'three'
import {
  context,
  Fn,
  float,
  int,
  positionGeometry,
  screenUV,
  select,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import {
  NodeMaterial,
  type NodeFrame,
  type Renderer,
  type Texture3DNode
} from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import {
  CloudShadowNode,
  createCloudLayerUniforms,
  createCloudParameterUniforms,
  loadDefaultCloudTextures,
  updateCloudLayerUniforms
} from '@yong_three/three-clouds/webgpu'
import { Ellipsoid, lerp } from '@takram/three-geospatial'

import { CloudLayers } from '@yong_three/three-clouds'
import { Vector2 } from 'three'

import type { StoryFC } from '../components/createStory'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import {
  rendererArgs,
  rendererArgTypes,
  type RendererArgs
} from '../controls/rendererControls'
import { useGuardedFrame } from '../hooks/useGuardedFrame'
import { useResource } from '../hooks/useResource'
import { useTransientControl } from '../hooks/useTransientControl'

// The frozen comparison parameters of the Basic story (port plan §3.3):
const CAMERA_POSITION: [number, number, number] = [
  4529893.894855564, 2615333.425024031, 3638042.815326614
]
const CAMERA_ROTATION: [number, number, number] = [
  0.6423512931563148, -0.2928348796035058, -0.8344824769956042
]
const REFERENCE_DATE = Date.parse('2025-01-01T07:00:00Z')

const vectorScratch1 = new Vector3()
const vectorScratch2 = new Vector3()

const Content: FC = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  renderer.toneMapping = NoToneMapping
  renderer.outputColorSpace = LinearSRGBColorSpace
  const camera = useThree(({ camera }) => camera)

  const atmosphereContext = useResource(() => new AtmosphereContext(), [])
  atmosphereContext.camera = camera

  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...renderer.contextNode.value,
      getAtmosphere: () => atmosphereContext
    })
  }, [renderer, atmosphereContext])

  useLayoutEffect(() => {
    const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } =
      atmosphereContext
    getECIToECEFRotationMatrix(REFERENCE_DATE, matrixECIToECEF.value)
    getSunDirectionECI(REFERENCE_DATE, sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
    getMoonDirectionECI(REFERENCE_DATE, moonDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
  }, [atmosphereContext])

  // The BSM producer under test, with the same parameters as the Basic story:
  const shadowNode = useResource(manage => {
    const textures = loadDefaultCloudTextures()
    manage(
      textures.localWeather,
      textures.shape,
      textures.shapeDetail,
      textures.turbulence,
      textures.stbn
    )
    const parameterUniforms = createCloudParameterUniforms({
      localWeatherRepeat: new Vector2().setScalar(100),
      localWeatherOffset: new Vector2(),
      shapeRepeat: new Vector3().setScalar(0.0003),
      shapeOffset: new Vector3(),
      shapeDetailRepeat: new Vector3().setScalar(0.006),
      shapeDetailOffset: new Vector3(),
      turbulenceRepeat: new Vector2().setScalar(20)
    })
    const layerUniforms = createCloudLayerUniforms()
    updateCloudLayerUniforms(layerUniforms, CloudLayers.DEFAULT)

    const shadowNode = new CloudShadowNode({
      parameterUniforms,
      layerUniforms,
      localWeatherTexture: textures.localWeather,
      shapeTexture: textures.shape,
      shapeDetailTexture: textures.shapeDetail,
      turbulenceTexture: textures.turbulence,
      stbnTexture: textures.stbn
    })
    shadowNode.shadowMaps.maxFar = 1e5 // Frozen parameter (§3.3)
    return shadowNode
  }, [])

  const material = useResource(manage => {
    const material = manage(new NodeMaterial())
    const cascadeCount = shadowNode.cascadeCount
    const bsm = shadowNode.getTextureNode('output')

    material.vertexNode = vec4(positionGeometry.xy, 0, 1)
    material.colorNode = Fn(() => {
      // Convert to a bottom-left-origin uv so that the quadrant layout and
      // the slice orientation match the WebGL debug view verbatim
      // (vec4 coord = vec4(vUv, vUv - 0.5) * 2.0):
      const uv = vec2(screenUV.x, screenUV.y.oneMinus()).toVar()
      const column = int(uv.x.mul(2)).min(1).toVar()
      const row = select(uv.y.greaterThan(0.5), int(0), int(1)).toVar()
      const index = row.mul(2).add(column).toVar()
      const tile = uv.mul(2).fract().toVar()

      const w = float(index).add(0.5).div(cascadeCount).toVar()
      const sampled = (bsm.sample(vec3(tile, w)) as Texture3DNode)
        .level(float(0))
        .toVar()
      // Cascades beyond the count remain black, equivalently to the
      // SHADOW_CASCADE_COUNT guards of the WebGL version:
      const shadow = select(
        index.lessThan(int(cascadeCount)),
        sampled,
        vec4(0)
      ).toVar()

      const frontDepthScale = 1e-5
      const meanExtinctionScale = 10
      const maxOpticalDepthScale = 0.01
      const color = shadow.rgb
        .add(vec3(0, 0, shadow.a))
        .mul(vec3(frontDepthScale, meanExtinctionScale, maxOpticalDepthScale))
      return vec4(color, 1)
    })()
    return material
  }, [shadowNode])

  const frameRef = useRef(0)

  // Miniature facade: the CSM update ported from
  // CloudsEffect.updateSharedUniforms() (the world equals ECEF here), then
  // the BSM march + resolve:
  useGuardedFrame(() => {
    const sunDirection = atmosphereContext.sunDirectionECEF.value
    const position = camera.getWorldPosition(vectorScratch1)
    const surfaceNormal = Ellipsoid.WGS84.getSurfaceNormal(
      position,
      vectorScratch2
    )
    const zenithAngle = sunDirection.dot(surfaceNormal)
    const distance = lerp(1e6, 1e3, zenithAngle)
    shadowNode.shadowMaps.update(
      camera as PerspectiveCamera,
      sunDirection,
      distance
    )
    shadowNode.frame.value = ++frameRef.current
    shadowNode.update({ renderer } as unknown as NodeFrame)
  })

  useTransientControl(
    ({ coverage }: StoryArgs) => coverage,
    coverage => {
      shadowNode.parameterUniforms.coverage.value = coverage
    }
  )
  useTransientControl(
    ({ temporalPass }: StoryArgs) => temporalPass,
    temporalPass => {
      shadowNode.temporalPass = temporalPass
    }
  )

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
  'cascade 0 — r: frontDepth·1e-5, g: meanExtinction·10, b: maxOpticalDepth·0.01',
  'cascade 1',
  'cascade 2',
  'cascade 3 (empty at the default cascade count)'
]

interface StoryArgs extends RendererArgs {
  coverage: number
  temporalPass: boolean
}

export const Story: StoryFC<{}, StoryArgs> = () => (
  <>
    <WebGPUCanvas
      camera={{
        near: 1,
        far: 4e5,
        fov: 75,
        position: CAMERA_POSITION,
        rotation: CAMERA_ROTATION
      }}
    >
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
  temporalPass: true,
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
  ...rendererArgTypes()
}

export default Story
