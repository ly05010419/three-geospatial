import {
  Euler,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  Vector3,
  type ToneMapping
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { WebGPURendererParameters } from 'three/src/renderers/webgpu/WebGPURenderer.js'
import { context, pass, toneMapping, uniform, vec4 } from 'three/tsl'
import * as ThreeWebGPU from 'three/webgpu'
import { WebGPURenderer } from 'three/webgpu'
import type { CloudsQualityPreset } from '@yong_three/three-clouds/webgpu'
import { useEffect, useRef } from 'react'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import {
  aerialPerspective,
  AtmosphereContext
} from '@takram/three-atmosphere/webgpu'
import { clouds } from '@yong_three/three-clouds/webgpu'
import { dithering, lensFlare } from '@takram/three-geospatial/webgpu'

import type { StoryFC } from '../components/createStory'
import {
  CAMERA_GROUND_CLEARANCE,
  clampCameraAboveGround,
  getCameraHeightAboveGround
} from '../components/cameraGroundClamp'
import {
  createPerformancePanel,
  resolveCloudsTimestamps
} from '../components/Stats'
import {
  toneMappingArgTypes,
  toneMappingArgs
} from '../controls/toneMappingControls'
import { useControl } from '../hooks/useControl'
import { agxPunchyToneMapping, AgXPunchyToneMapping } from '../helpers/AgxToneMapping'

// Three r183 exports RenderPipeline at runtime, while the current type package
// still exposes only its deprecated PostProcessing alias.
const RenderPipeline = (
  ThreeWebGPU as typeof ThreeWebGPU & {
    RenderPipeline: typeof ThreeWebGPU.PostProcessing
  }
).RenderPipeline

const CAMERA_POSITION = new Vector3(
  4529893.894855564,
  2615333.425024031,
  3638042.815326614
)
const CAMERA_ROTATION: [number, number, number] = [
  0.6423512931563148, -0.2928348796035058, -0.8344824769956042
]
const CAMERA_TARGET = new Vector3(...CAMERA_POSITION)
  .add(new Vector3(0, 0, -1000).applyEuler(new Euler(...CAMERA_ROTATION)))
const CAMERA_UP = new Vector3(0, 1, 0).applyEuler(new Euler(...CAMERA_ROTATION))
const REFERENCE_DATE = Date.parse('2025-01-01T07:00:00Z')

interface VanillaArgs {
  coverage: number
  qualityPreset: CloudsQualityPreset
  bsm: boolean
  temporalUpscale: boolean
  lightShafts: boolean
  haze: boolean
  shapeDetail: boolean
  turbulence: boolean
  animateClouds: boolean
  cloudSpeed: number
  animateDate: boolean
  dateSpeed: number
  dayOfYear: number
  timeOfDay: number
  year: number
  toneMapping: boolean
  toneMappingMode: ToneMapping
  toneMappingExposure: number
  pixelRatio: number
}

interface VanillaArgsRef {
  current: VanillaArgs
}

async function init(
  container: HTMLDivElement,
  argsRef: VanillaArgsRef
): Promise<() => void> {
  const rendererParameters: WebGPURendererParameters = {
    requiredLimits: {
      maxSampledTexturesPerShaderStage: 32
    },
    trackTimestamp: true
  }
  const renderer = new WebGPURenderer(rendererParameters)
  renderer.library.addToneMapping(agxPunchyToneMapping, AgXPunchyToneMapping)
  renderer.highPrecision = true
  renderer.setPixelRatio(argsRef.current.pixelRatio)
  renderer.setSize(window.innerWidth, window.innerHeight)
  container.appendChild(renderer.domElement)
  await renderer.init()

  const scene = new Scene()
  const camera = new PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    1,
    4e5
  )
  camera.position.copy(CAMERA_POSITION)
  camera.rotation.fromArray(CAMERA_ROTATION)
  camera.up.copy(CAMERA_UP)
  camera.updateMatrixWorld()

  // Match the React demos: left-drag rotates, middle-drag zooms, and
  // right-drag pans the camera. OrbitControls' default mouse mapping already
  // assigns the right button to pan; keep the same target and minimum distance
  // as the Basic story.
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.copy(CAMERA_TARGET)
  controls.minDistance = 1000
  controls.update()

  const atmosphereContext = new AtmosphereContext()
  atmosphereContext.camera = camera
  renderer.contextNode = context({
    ...renderer.contextNode.value,
    getAtmosphere: () => atmosphereContext
  })

  const { matrixECIToECEF, sunDirectionECEF, moonDirectionECEF } =
    atmosphereContext
  getECIToECEFRotationMatrix(REFERENCE_DATE, matrixECIToECEF.value)
  getSunDirectionECI(REFERENCE_DATE, sunDirectionECEF.value).applyMatrix4(
    matrixECIToECEF.value
  )
  getMoonDirectionECI(REFERENCE_DATE, moonDirectionECEF.value).applyMatrix4(
    matrixECIToECEF.value
  )

  const passNode = pass(scene, camera, { samples: 0 })
  const colorNode = passNode.getTextureNode('output')
  const depthNode = passNode.getTextureNode('depth')
  const cloudsNode = clouds(depthNode).loadDefaultTextures()
  const aerialNode = aerialPerspective(colorNode, depthNode)

  const shadowLengthNode = cloudsNode.getShadowLengthNode()
  aerialNode.shadowLengthNode = shadowLengthNode
  const skyNode = aerialNode.skyNode as {
    shadowLengthNode?: typeof shadowLengthNode
  } | null
  if (skyNode != null) {
    skyNode.shadowLengthNode = shadowLengthNode
  }

  const compositeNode = vec4(
    aerialNode.rgb.mul(cloudsNode.a.oneMinus()).add(cloudsNode.rgb),
    1
  )
  const lensFlareNode = lensFlare(compositeNode)
  const exposureNode = uniform(argsRef.current.toneMappingExposure)
  const toneMappingNode = toneMapping(
    argsRef.current.toneMappingMode,
    exposureNode,
    lensFlareNode
  )
  const postProcessing = new RenderPipeline(
    renderer,
    toneMappingNode.add(dithering)
  )
  const performancePanel = createPerformancePanel(renderer)
  const timestampResolveRef: { current: Promise<void> | null } = {
    current: null
  }
  const nativeGpuProbeRef: { current: Promise<void> | null } = {
    current: null
  }
  const previous = {
    coverage: Number.NaN,
    qualityPreset: undefined as CloudsQualityPreset | undefined,
    bsm: undefined as boolean | undefined,
    temporalUpscale: undefined as boolean | undefined,
    lightShafts: undefined as boolean | undefined,
    haze: undefined as boolean | undefined,
    shapeDetail: undefined as boolean | undefined,
    turbulence: undefined as boolean | undefined,
    animateClouds: undefined as boolean | undefined,
    cloudSpeed: Number.NaN,
    toneMapping: undefined as boolean | undefined,
    toneMappingMode: undefined as ToneMapping | undefined,
    toneMappingExposure: Number.NaN,
    pixelRatio: Number.NaN
  }
  let animatedDate = REFERENCE_DATE
  let previousDate = Number.NaN
  let previousTime = 0
  let rotationBlocked = false
  const previousCameraQuaternion = camera.quaternion.clone()

  const updateDate = (date: number): void => {
    animatedDate = date
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

  const applyControls = (deltaSeconds: number): void => {
    const args = argsRef.current
    const cloudNode = cloudsNode as any

    if (previous.coverage !== args.coverage) {
      cloudNode.coverage = args.coverage
      previous.coverage = args.coverage
    }
    if (previous.qualityPreset !== args.qualityPreset) {
      cloudNode.qualityPreset = args.qualityPreset
      cloudNode.resetHistory?.()
      postProcessing.needsUpdate = true
      previous.qualityPreset = args.qualityPreset
    }
    if (previous.bsm !== args.bsm) {
      cloudNode.bsm = args.bsm
      previous.bsm = args.bsm
    }
    if (previous.temporalUpscale !== args.temporalUpscale) {
      cloudNode.temporalUpscale = args.temporalUpscale
      cloudNode.resetHistory?.()
      previous.temporalUpscale = args.temporalUpscale
    }
    if (previous.lightShafts !== args.lightShafts) {
      cloudNode.lightShafts = args.lightShafts
      cloudNode.resetHistory?.()
      previous.lightShafts = args.lightShafts
    }
    if (previous.haze !== args.haze) {
      cloudNode.haze = args.haze
      previous.haze = args.haze
    }
    if (previous.shapeDetail !== args.shapeDetail) {
      cloudNode.shapeDetail = args.shapeDetail
      previous.shapeDetail = args.shapeDetail
    }
    if (previous.turbulence !== args.turbulence) {
      cloudNode.turbulence = args.turbulence
      previous.turbulence = args.turbulence
    }
    if (
      previous.animateClouds !== args.animateClouds ||
      previous.cloudSpeed !== args.cloudSpeed
    ) {
      cloudNode.localWeatherVelocity.set(
        args.animateClouds ? args.cloudSpeed : 0,
        0
      )
      previous.animateClouds = args.animateClouds
      previous.cloudSpeed = args.cloudSpeed
    }

    if (previous.toneMapping !== args.toneMapping || previous.toneMappingMode !== args.toneMappingMode) {
      const toneNode = toneMappingNode as typeof toneMappingNode & {
        setToneMapping?: (value: ToneMapping) => void
      }
      toneNode.setToneMapping?.(
        args.toneMapping ? args.toneMappingMode : NoToneMapping
      )
      renderer.toneMapping = args.toneMapping
        ? args.toneMappingMode
        : NoToneMapping
      postProcessing.needsUpdate = true
      previous.toneMapping = args.toneMapping
      previous.toneMappingMode = args.toneMappingMode
    }
    if (previous.toneMappingExposure !== args.toneMappingExposure) {
      exposureNode.value = args.toneMappingExposure
      renderer.toneMappingExposure = args.toneMappingExposure
      previous.toneMappingExposure = args.toneMappingExposure
    }
    if (previous.pixelRatio !== args.pixelRatio) {
      renderer.setPixelRatio(args.pixelRatio)
      renderer.setSize(window.innerWidth, window.innerHeight)
      previous.pixelRatio = args.pixelRatio
    }

    if (args.animateDate) {
      animatedDate += args.dateSpeed * deltaSeconds * 3_600_000
      updateDate(animatedDate)
    } else {
      const date =
        Date.UTC(args.year, 0, 1) +
        ((args.dayOfYear - 1) * 24 + args.timeOfDay - 2) * 3_600_000
      if (date !== previousDate) {
        updateDate(date)
        previousDate = date
      }
    }
  }

  const handleResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  }
  window.addEventListener('resize', handleResize)

  void renderer.setAnimationLoop(time => {
    controls.update()
    const moved = clampCameraAboveGround(camera)
    const height = getCameraHeightAboveGround(camera)
    if (moved) {
      rotationBlocked = true
      camera.quaternion.copy(previousCameraQuaternion)
    }
    else if (rotationBlocked && height > CAMERA_GROUND_CLEARANCE + 0.1) {
      rotationBlocked = false
    }
    controls.enableRotate = !rotationBlocked
    if (rotationBlocked) {
      camera.quaternion.copy(previousCameraQuaternion)
    } else {
      previousCameraQuaternion.copy(camera.quaternion)
    }
    const deltaSeconds =
      previousTime > 0 ? Math.min(Math.max(time - previousTime, 0) / 1000, 0.25) : 0
    previousTime = time
    applyControls(deltaSeconds)
    const submitStarted = performance.now()
    postProcessing.render()

    const performanceMetrics = ((renderer as any).__cloudsPerformance ??= {}) as {
      submitMs?: number
      gpuQueueMs?: number
    }
    performanceMetrics.submitMs = performance.now() - submitStarted

    const queue = (renderer as any).backend?.device?.queue as
      | { onSubmittedWorkDone?: () => Promise<unknown> }
      | undefined
    if (
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

    if (timestampResolveRef.current == null) {
      const pending = resolveCloudsTimestamps(renderer).finally(() => {
        timestampResolveRef.current = null
        if ((renderer as any).__cloudsTimestampPending === pending) {
          delete (renderer as any).__cloudsTimestampPending
        }
      })
      timestampResolveRef.current = pending
      ;(renderer as any).__cloudsTimestampPending = pending
    }
  })

  return () => {
    window.removeEventListener('resize', handleResize)
    void renderer.setAnimationLoop(null)
    performancePanel.dispose()
    controls.dispose()
    postProcessing.dispose()
    lensFlareNode.dispose()
    aerialNode.dispose()
    cloudsNode.dispose()
    passNode.dispose()
    atmosphereContext.dispose()
    const pending = (renderer as any).__cloudsTimestampPending as
      | Promise<unknown>
      | undefined
    if (pending != null) {
      void pending.catch(() => undefined).then(() => {
        renderer.dispose()
      })
    } else {
      renderer.dispose()
    }
    renderer.domElement.remove()
  }
}

export const Story: StoryFC<{}, VanillaArgs> = () => {
  const args = useControl((value: VanillaArgs) => value)
  const argsRef = useRef<VanillaArgs>(args)
  argsRef.current = args
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container == null) return

    let disposed = false
    const promise = init(container, argsRef)
    promise
      .then(dispose => {
        if (disposed) dispose()
      })
      .catch((error: unknown) => {
        console.error(error)
      })

    return () => {
      disposed = true
      void promise
        .then(dispose => {
          dispose()
        })
        .catch(() => undefined)
    }
  }, [])

  return <div ref={containerRef} />
}

Story.args = {
  coverage: 0.3,
  qualityPreset: 'high',
  bsm: true,
  temporalUpscale: true,
  lightShafts: true,
  haze: true,
  shapeDetail: true,
  turbulence: true,
  animateClouds: false,
  cloudSpeed: 0.001,
  animateDate: false,
  dateSpeed: 0.05,
  dayOfYear: 1,
  timeOfDay: 9,
  year: 2025,
  ...toneMappingArgs({
    toneMappingMode: AgXPunchyToneMapping,
    toneMappingExposure: 10
  }),
  pixelRatio: Math.min(window.devicePixelRatio, 2)
}

Story.argTypes = {
  coverage: {
    control: { type: 'range', min: 0, max: 1, step: 0.01 }
  },
  qualityPreset: {
    control: { type: 'select' },
    options: ['low', 'medium', 'high', 'ultra']
  },
  bsm: { control: { type: 'boolean' } },
  temporalUpscale: { control: { type: 'boolean' } },
  lightShafts: { control: { type: 'boolean' } },
  haze: { control: { type: 'boolean' } },
  shapeDetail: { control: { type: 'boolean' } },
  turbulence: { control: { type: 'boolean' } },
  animateClouds: {
    control: { type: 'boolean' },
    table: { category: 'animation' }
  },
  cloudSpeed: {
    control: { type: 'range', min: -0.01, max: 0.01, step: 0.0001 },
    table: { category: 'animation' }
  },
  animateDate: {
    control: { type: 'boolean' },
    table: { category: 'local date' }
  },
  dateSpeed: {
    name: 'speed',
    control: { type: 'range', min: -0.5, max: 0.5, step: 0.01 },
    table: { category: 'local date' }
  },
  dayOfYear: {
    control: { type: 'range', min: 1, max: 365, step: 1 },
    table: { category: 'local date' }
  },
  timeOfDay: {
    name: 'time of day',
    control: { type: 'range', min: 0, max: 24, step: 0.1 },
    table: { category: 'local date' }
  },
  year: {
    control: { type: 'range', min: 2000, max: 2050, step: 1 },
    table: { category: 'local date' }
  },
  ...toneMappingArgTypes({ min: 0.1, max: 100 }),
  pixelRatio: {
    name: 'pixel ratio',
    control: { type: 'range', min: 0.5, max: 3.5, step: 0.1 },
    table: { category: 'renderer' }
  }
}

export default Story
