import { useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo, type FC } from 'react'
import { AgXToneMapping } from 'three'
import { context, pass, toneMapping, uniform, vec4 } from 'three/tsl'
import { PostProcessing, type Renderer } from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import {
  aerialPerspective,
  AtmosphereContext
} from '@takram/three-atmosphere/webgpu'
import { clouds } from '@takram/three-clouds/webgpu'
import { dithering, lensFlare } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../components/createStory'
import { Description } from '../components/Description'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import {
  rendererArgs,
  rendererArgTypes,
  type RendererArgs
} from '../controls/rendererControls'
import {
  toneMappingArgs,
  toneMappingArgTypes,
  useToneMappingControls,
  type ToneMappingArgs
} from '../controls/toneMappingControls'
import { useGuardedFrame } from '../hooks/useGuardedFrame'
import { useResource } from '../hooks/useResource'
import { useTransientControl } from '../hooks/useTransientControl'

// Frozen comparison parameters (port plan §3.3). The world coordinate system
// equals ECEF (matrixWorldToECEF stays identity), and the camera takes the
// recorded MinimalSetup pose of the WebGL reference storybook:
const CAMERA_POSITION: [number, number, number] = [
  4529893.894855564, 2615333.425024031, 3638042.815326614
]
const CAMERA_ROTATION: [number, number, number] = [
  0.6423512931563148, -0.2928348796035058, -0.8344824769956042
]

// Equivalent to dayOfYear 0, timeOfDay 9 at longitude 30:
const REFERENCE_DATE = Date.parse('2025-01-01T07:00:00Z')

const Content: FC<StoryProps> = () => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)

  const atmosphereContext = useResource(() => new AtmosphereContext(), [])
  atmosphereContext.camera = camera

  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...renderer.contextNode.value,
      getAtmosphere: () => atmosphereContext
    })
  }, [renderer, atmosphereContext])

  // The date is fixed during the parity captures; springs and the animation
  // of the celestial directions are intentionally absent:
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

  // Post-processing:

  // An empty scene pass provides the depth buffer the clouds march clamps
  // its rays against (depth = 1 everywhere without scene geometry):
  const passNode = useResource(
    () => pass(scene, camera, { samples: 0 }),
    [scene, camera]
  )
  const colorNode = passNode.getTextureNode('output')
  const depthNode = passNode.getTextureNode('depth')

  const cloudsNode = useResource(
    () => clouds(depthNode).loadDefaultTextures(),
    [depthNode]
  )

  const aerialNode = useResource(
    () => aerialPerspective(colorNode, depthNode),
    [colorNode, depthNode]
  )

  // The clouds output is premultiplied (rgb = radiance, a = coverage), and
  // composites over the scene exactly like cloudsEffect.frag in the WebGL
  // implementation:
  const compositeNode = useMemo(
    () =>
      vec4(aerialNode.rgb.mul(cloudsNode.a.oneMinus()).add(cloudsNode.rgb), 1),
    [aerialNode, cloudsNode]
  )

  const lensFlareNode = useResource(
    () => lensFlare(compositeNode),
    [compositeNode]
  )

  const toneMappingNode = useResource(
    () => toneMapping(AgXToneMapping, uniform(0), lensFlareNode),
    [lensFlareNode]
  )

  const postProcessing = useResource(
    () => new PostProcessing(renderer, toneMappingNode.add(dithering)),
    [renderer, toneMappingNode]
  )

  useGuardedFrame(() => {
    postProcessing.render()
  }, 1)

  useTransientControl(
    ({ coverage }: StoryArgs) => coverage,
    coverage => {
      cloudsNode.coverage = coverage
    }
  )

  // The M2/M3 bisect toggle: false renders without the BSM contribution.
  // A static option, so the node graph must rebuild:
  useTransientControl(
    ({ bsm }: StoryArgs) => bsm,
    bsm => {
      if (cloudsNode.bsm !== bsm) {
        cloudsNode.bsm = bsm
        postProcessing.needsUpdate = true
      }
    }
  )

  // Tone mapping controls:
  useToneMappingControls(toneMappingNode, () => {
    postProcessing.needsUpdate = true
  })

  return null
}

interface StoryProps {}

interface StoryArgs extends ToneMappingArgs, RendererArgs {
  coverage: number
  bsm: boolean
}

export const Story: StoryFC<StoryProps, StoryArgs> = props => (
  <WebGPUCanvas
    camera={{
      near: 1,
      far: 4e5,
      fov: 75,
      position: CAMERA_POSITION,
      rotation: CAMERA_ROTATION
    }}
  >
    <Content {...props} />
    <Description />
  </WebGPUCanvas>
)

Story.args = {
  coverage: 0.3,
  bsm: true,
  ...toneMappingArgs({
    toneMappingExposure: 10
  }),
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
  ...toneMappingArgTypes(),
  ...rendererArgTypes()
}
