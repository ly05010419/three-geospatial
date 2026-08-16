import { Box } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import type { CloudLayers } from '@yong_three/three-clouds'
import {
  clouds,
  type CloudsMarchDebugShow,
  type CloudsQualityPreset,
  type CloudsResolveDebugShow
} from '@yong_three/three-clouds/webgpu'
import type { MotionValue } from 'motion/react'
import { useLayoutEffect, useMemo, useRef, type FC } from 'react'
import { AgXToneMapping, Euler, Vector3 } from 'three'
import {
  context,
  diffuseColor,
  mrt,
  normalView,
  pass,
  toneMapping,
  uniform,
  vec4
} from 'three/tsl'
import * as ThreeWebGPU from 'three/webgpu'
import type { Renderer } from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import {
  aerialPerspective,
  AtmosphereContext
} from '@takram/three-atmosphere/webgpu'
import { radians } from '@takram/three-geospatial'
import { EastNorthUpFrame } from '@takram/three-geospatial/r3f'
import { dithering, lensFlare } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../components/createStory'
import { Description } from '../components/Description'
import { GroundClampedOrbitControls } from '../components/GroundClampedOrbitControls'
import { resolveCloudsTimestamps } from '../components/Stats'
import { WebGPUCanvas } from '../components/WebGPUCanvas'
import {
  localDateArgs,
  localDateArgTypes,
  useLocalDateControls,
  type LocalDateArgs
} from '../controls/localDateControls'
import {
  useLocationControls,
  type LocationArgs
} from '../controls/locationControls'
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
import { useControl } from '../hooks/useControl'
import { useGuardedFrame } from '../hooks/useGuardedFrame'
import { useResource } from '../hooks/useResource'
import { useTransientControl } from '../hooks/useTransientControl'

// Three r183 exports RenderPipeline at runtime, while the current type package
// still exposes only its deprecated PostProcessing alias.
const RenderPipeline = (
  ThreeWebGPU as typeof ThreeWebGPU & {
    RenderPipeline: typeof ThreeWebGPU.PostProcessing
  }
).RenderPipeline

// Frozen comparison parameters (port plan §3.3). The world coordinate system
// equals ECEF (matrixWorldToECEF stays identity), and the camera takes the
// recorded MinimalSetup pose of the WebGL reference storybook:
const CAMERA_POSITION: [number, number, number] = [
  4529893.894855564, 2615333.425024031, 3638042.815326614
]
const CAMERA_ROTATION: [number, number, number] = [
  0.6423512931563148, -0.2928348796035058, -0.8344824769956042
]
const CAMERA_EULER = new Euler(...CAMERA_ROTATION)
const CAMERA_TARGET_VECTOR = new Vector3()
  .fromArray(CAMERA_POSITION)
  .add(new Vector3(0, 0, -1000).applyEuler(CAMERA_EULER))
const CAMERA_TARGET = CAMERA_TARGET_VECTOR.toArray()
const CAMERA_UP = new Vector3(0, 1, 0).applyEuler(CAMERA_EULER).toArray()
const LOCAL_CAMERA_POSITION: [number, number, number] = [0, 1, 5]

// Equivalent to dayOfYear 0, timeOfDay 9 at longitude 30:
const REFERENCE_DATE = Date.parse('2025-01-01T07:00:00Z')

interface DateControlsProps {
  atmosphereContext: AtmosphereContext
  longitude: number | MotionValue<number>
}

const DateControls: FC<DateControlsProps> = ({
  atmosphereContext,
  longitude
}) => {
  const animatedDateRef = useRef(REFERENCE_DATE)
  const updateAtmosphereDate = (date: number): void => {
    animatedDateRef.current = date
    const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } =
      atmosphereContext
    getECIToECEFRotationMatrix(date, matrixECIToECEF.value)
    getSunDirectionECI(date, sunDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
    getMoonDirectionECI(date, moonDirectionECEF.value).applyMatrix4(
      matrixECIToECEF.value
    )
  }

  useLocalDateControls(longitude, updateAtmosphereDate)
  const { animateDate, dateSpeed } = useControl(
    ({ animateDate, dateSpeed }: StoryArgs) => ({ animateDate, dateSpeed })
  )
  useGuardedFrame((_, delta) => {
    if (animateDate) {
      updateAtmosphereDate(
        animatedDateRef.current + dateSpeed * delta * 3_600_000
      )
    }
  })

  return null
}

const LocalFrameControls: FC<{
  atmosphereContext: AtmosphereContext
}> = ({ atmosphereContext }) => {
  const [longitude] = useLocationControls(
    atmosphereContext.matrixWorldToECEF.value
  )
  return (
    <DateControls atmosphereContext={atmosphereContext} longitude={longitude} />
  )
}

const Content: FC<StoryProps> = ({
  cloudLayers,
  enableDithering = true,
  localFrame = false,
  temporalShadows = true
}) => {
  const renderer = useThree<Renderer>(({ gl }) => gl as any)
  const showStats = useControl(({ showStats }: StoryArgs) => showStats)
  const trackTimestamp = useControl(
    ({ trackTimestamp }: StoryArgs) => trackTimestamp
  )
  const scene = useThree(({ scene }) => scene)
  const camera = useThree(({ camera }) => camera)
  const timestampResolveRef = useRef<Promise<void> | null>(null)
  const nativeGpuProbeRef = useRef<Promise<void> | null>(null)

  const atmosphereContext = useResource(() => new AtmosphereContext(), [])
  atmosphereContext.camera = camera

  useLayoutEffect(() => {
    renderer.contextNode = context({
      ...renderer.contextNode.value,
      getAtmosphere: () => atmosphereContext
    })
  }, [renderer, atmosphereContext])

  // Post-processing:

  // The normal attachment lets AerialPerspectiveNode light scene geometry and
  // apply cloud surface shadows. With the receiver hidden, depth stays 1 and
  // the output remains identical to the empty-scene reference.
  const passNode = useResource(
    () =>
      pass(scene, camera, { samples: 0 }).setMRT(
        mrt({
          output: diffuseColor,
          normal: normalView
        })
      ),
    [scene, camera]
  )
  const colorNode = passNode.getTextureNode('output')
  const depthNode = passNode.getTextureNode('depth')
  const normalNode = passNode.getTextureNode('normal')

  const cloudsNode = useResource(
    () => clouds(depthNode).loadDefaultTextures(),
    [depthNode]
  )
  useLayoutEffect(() => {
    cloudsNode.shadowNode.temporalPass = temporalShadows
    cloudsNode.shadowNode.temporalJitter = temporalShadows
  }, [cloudsNode, temporalShadows])
  useLayoutEffect(() => {
    if (cloudLayers != null) {
      cloudsNode.setCloudLayers(cloudLayers)
    }
  }, [cloudLayers, cloudsNode])

  const aerialNode = useResource(
    () => aerialPerspective(colorNode, depthNode, normalNode),
    [colorNode, depthNode, normalNode]
  )
  useMemo(() => {
    const shadowLengthNode = cloudsNode.getShadowLengthNode()
    aerialNode.shadowLengthNode = shadowLengthNode
    const skyNode = aerialNode.skyNode as {
      showStars?: boolean
      shadowLengthNode?: typeof shadowLengthNode
    } | null
    if (skyNode != null) {
      skyNode.showStars = false
      skyNode.shadowLengthNode = shadowLengthNode
    }
    return shadowLengthNode
  }, [aerialNode, cloudsNode])

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
    () =>
      new RenderPipeline(
        renderer,
        enableDithering ? toneMappingNode.add(dithering) : toneMappingNode
      ),
    [enableDithering, renderer, toneMappingNode]
  )

  useGuardedFrame(() => {
    const profileGpu = showStats && trackTimestamp
    const submitStarted = showStats ? performance.now() : 0
    postProcessing.render()

    if (!showStats) return

    const performanceMetrics = ((renderer as any).__cloudsPerformance ??=
      {}) as {
      submitMs?: number
      gpuQueueMs?: number
    }

    performanceMetrics.submitMs = performance.now() - submitStarted

    const queue = (renderer as any).backend?.device?.queue as
      | { onSubmittedWorkDone?: () => Promise<unknown> }
      | undefined
    if (
      profileGpu &&
      typeof queue?.onSubmittedWorkDone === 'function' &&
      nativeGpuProbeRef.current == null
    ) {
      nativeGpuProbeRef.current = queue
        .onSubmittedWorkDone()
        .then(() => {
          performanceMetrics.gpuQueueMs = performance.now() - submitStarted
        })
        .catch(() => undefined)
        .finally(() => {
          nativeGpuProbeRef.current = null
        })
    }
    // Three.js timestamp queries are written during the explicit render pass
    // and must be resolved after submission for the performance panel.
    if (profileGpu && timestampResolveRef.current == null) {
      const pending = resolveCloudsTimestamps(renderer)
        .catch(() => undefined)
        .finally(() => {
          timestampResolveRef.current = null
          if ((renderer as any).__cloudsTimestampPending === pending) {
            delete (renderer as any).__cloudsTimestampPending
          }
        })
      timestampResolveRef.current = pending
      ;(renderer as any).__cloudsTimestampPending = pending
    }
  }, 1)

  useTransientControl(
    ({ coverage }: StoryArgs) => coverage,
    coverage => {
      cloudsNode.coverage = coverage
    }
  )

  useTransientControl(
    ({ animateClouds, cloudSpeed }: StoryArgs) => ({
      animateClouds,
      cloudSpeed
    }),
    ({ animateClouds, cloudSpeed }) => {
      cloudsNode.localWeatherVelocity.set(animateClouds ? cloudSpeed : 0, 0)
    }
  )

  useTransientControl(
    ({ qualityPreset }: StoryArgs) => qualityPreset,
    qualityPreset => {
      cloudsNode.qualityPreset = qualityPreset
      cloudsNode.resetHistory()
      // Surface-shadow cascade/sample counts are shader constants.
      postProcessing.needsUpdate = true
    }
  )

  // The M2/M3 bisect toggle: false renders without the BSM contribution.
  useTransientControl(
    ({ bsm }: StoryArgs) => bsm,
    bsm => {
      if (cloudsNode.bsm !== bsm) {
        cloudsNode.bsm = bsm
      }
    }
  )

  // M4 bisect toggle: false renders the march pass at full resolution and
  // uses the non-upscale temporal resolve path from cloudsResolve.frag.
  useTransientControl(
    ({ temporalUpscale }: StoryArgs) => temporalUpscale,
    temporalUpscale => {
      if (cloudsNode.temporalUpscale !== temporalUpscale) {
        cloudsNode.temporalUpscale = temporalUpscale
        cloudsNode.resetHistory()
      }
    }
  )

  useTransientControl(
    ({ lightShafts }: StoryArgs) => lightShafts,
    lightShafts => {
      if (cloudsNode.lightShafts !== lightShafts) {
        cloudsNode.lightShafts = lightShafts
        cloudsNode.resetHistory()
      }
    }
  )

  useTransientControl(
    ({ surfaceShadows }: StoryArgs) => surfaceShadows,
    surfaceShadows => {
      aerialNode.sunTransmittanceNode = surfaceShadows
        ? (positionECEF, builder) =>
            cloudsNode.getSunTransmittanceNode(positionECEF, builder)
        : null
      postProcessing.needsUpdate = true
    }
  )

  // The BSM producer is shared by three independent consumers. Do not pay
  // for its two compute passes when all of them are disabled; this is the
  // equivalent of compiling the WebGL SHADOWS path out for a no-shadow
  // benchmark while retaining the requested BSM setting for later toggles.
  useTransientControl(
    ({ bsm, lightShafts, surfaceShadows }: StoryArgs) => ({
      bsm,
      lightShafts,
      surfaceShadows
    }),
    ({ bsm, lightShafts, surfaceShadows }) => {
      cloudsNode.shadowsEnabled = bsm || lightShafts || surfaceShadows
    }
  )

  useTransientControl(
    ({ haze }: StoryArgs) => haze,
    haze => {
      if (cloudsNode.haze !== haze) {
        cloudsNode.haze = haze
      }
    }
  )

  useTransientControl(
    ({ shapeDetail }: StoryArgs) => shapeDetail,
    shapeDetail => {
      if (cloudsNode.shapeDetail !== shapeDetail) {
        cloudsNode.shapeDetail = shapeDetail
      }
    }
  )

  useTransientControl(
    ({ turbulence }: StoryArgs) => turbulence,
    turbulence => {
      if (cloudsNode.turbulence !== turbulence) {
        cloudsNode.turbulence = turbulence
      }
    }
  )

  useTransientControl(
    ({ marchDebugShow }: StoryArgs) => marchDebugShow,
    marchDebugShow => {
      if (cloudsNode.marchNode.debugShow !== marchDebugShow) {
        cloudsNode.marchNode.debugShow = marchDebugShow
      }
    }
  )

  useTransientControl(
    ({ resolveDebugShow }: StoryArgs) => resolveDebugShow,
    resolveDebugShow => {
      if (cloudsNode.resolveNode.debugShow !== resolveDebugShow) {
        cloudsNode.resolveNode.debugShow = resolveDebugShow
      }
    }
  )

  // Tone mapping controls:
  useToneMappingControls(toneMappingNode, () => {
    postProcessing.needsUpdate = true
  })

  const { showShadowReceiver } = useControl(
    ({ showShadowReceiver }: StoryArgs) => ({ showShadowReceiver })
  )

  const shadowReceiver = (
    <Box
      args={[2e3, 2e3, 2e3]}
      position={[1e3, -2e3, 1e3]}
      rotation={[Math.PI / 4, Math.PI / 4, 0]}
    >
      <meshBasicMaterial color='white' />
    </Box>
  )

  return (
    <>
      {localFrame ? (
        <LocalFrameControls atmosphereContext={atmosphereContext} />
      ) : (
        <DateControls atmosphereContext={atmosphereContext} longitude={30} />
      )}
      {showShadowReceiver ? (
        localFrame ? (
          shadowReceiver
        ) : (
          <EastNorthUpFrame longitude={radians(30)} latitude={radians(35)}>
            {shadowReceiver}
          </EastNorthUpFrame>
        )
      ) : null}
    </>
  )
}

export interface StoryProps {
  cloudLayers?: CloudLayers
  enableDithering?: boolean
  localFrame?: boolean
  temporalShadows?: boolean
}

export interface StoryArgs
  extends ToneMappingArgs, RendererArgs, LocalDateArgs, LocationArgs {
  coverage: number
  animateClouds: boolean
  cloudSpeed: number
  animateDate: boolean
  dateSpeed: number
  qualityPreset: CloudsQualityPreset
  bsm: boolean
  temporalUpscale: boolean
  lightShafts: boolean
  surfaceShadows: boolean
  showShadowReceiver: boolean
  haze: boolean
  shapeDetail: boolean
  turbulence: boolean
  marchDebugShow: CloudsMarchDebugShow
  resolveDebugShow: CloudsResolveDebugShow
}

export const Story: StoryFC<StoryProps, StoryArgs> = ({
  localFrame = false,
  ...props
}) => (
  <WebGPUCanvas
    renderer={{
      requiredLimits: {
        maxSampledTexturesPerShaderStage: 32
      }
    }}
    camera={{
      near: 1,
      far: 4e5,
      fov: 75,
      ...(localFrame
        ? { position: LOCAL_CAMERA_POSITION }
        : {
            position: CAMERA_POSITION,
            rotation: CAMERA_ROTATION,
            up: CAMERA_UP
          })
    }}
  >
    <GroundClampedOrbitControls
      target={localFrame ? [0, 0, 0] : CAMERA_TARGET}
      minDistance={1000}
      localFrame={localFrame}
    />
    <Content {...props} localFrame={localFrame} />
    <Description />
  </WebGPUCanvas>
)

Story.args = {
  coverage: 0.3,
  animateClouds: false,
  cloudSpeed: 0.001,
  animateDate: false,
  dateSpeed: 0.05,
  qualityPreset: 'high',
  bsm: true,
  temporalUpscale: true,
  lightShafts: true,
  surfaceShadows: true,
  showShadowReceiver: false,
  haze: true,
  shapeDetail: true,
  turbulence: true,
  marchDebugShow: 'none',
  resolveDebugShow: 'none',
  ...localDateArgs({
    dayOfYear: 1,
    timeOfDay: 9,
    year: 2025
  }),
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
  animateClouds: {
    control: {
      type: 'boolean'
    },
    table: { category: 'animation' }
  },
  cloudSpeed: {
    control: {
      type: 'range',
      min: -0.01,
      max: 0.01,
      step: 0.0001
    },
    table: { category: 'animation' }
  },
  animateDate: {
    control: {
      type: 'boolean'
    },
    table: { category: 'animation' }
  },
  dateSpeed: {
    control: {
      type: 'range',
      min: -0.5,
      max: 0.5,
      step: 0.01
    },
    table: { category: 'animation' }
  },
  qualityPreset: {
    control: {
      type: 'select'
    },
    options: ['low', 'medium', 'high', 'ultra']
  },
  bsm: {
    control: {
      type: 'boolean'
    }
  },
  temporalUpscale: {
    control: {
      type: 'boolean'
    }
  },
  lightShafts: {
    control: {
      type: 'boolean'
    }
  },
  surfaceShadows: {
    control: {
      type: 'boolean'
    },
    table: { category: 'shadows' }
  },
  showShadowReceiver: {
    control: {
      type: 'boolean'
    },
    table: { category: 'shadows' }
  },
  haze: {
    control: {
      type: 'boolean'
    }
  },
  shapeDetail: {
    control: {
      type: 'boolean'
    }
  },
  turbulence: {
    control: {
      type: 'boolean'
    }
  },
  marchDebugShow: {
    control: {
      type: 'select'
    },
    options: ['none', 'uv', 'sampleCount', 'frontDepth', 'shadowLength']
  },
  resolveDebugShow: {
    control: {
      type: 'select'
    },
    options: ['none', 'velocity', 'shadowLength']
  },
  ...localDateArgTypes(),
  ...toneMappingArgTypes(),
  ...rendererArgTypes()
}
