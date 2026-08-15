import { AgXToneMapping, Euler, PerspectiveCamera, Scene, Vector3 } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { WebGPURendererParameters } from 'three/src/renderers/webgpu/WebGPURenderer.js'
import { context, pass, toneMapping, uniform, vec4 } from 'three/tsl'
import * as ThreeWebGPU from 'three/webgpu'
import { WebGPURenderer } from 'three/webgpu'

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

async function init(container: HTMLDivElement): Promise<() => void> {
  const rendererParameters: WebGPURendererParameters = {
    requiredLimits: {
      maxSampledTexturesPerShaderStage: 32
    }
  }
  const renderer = new WebGPURenderer(rendererParameters)
  renderer.highPrecision = true
  renderer.setPixelRatio(window.devicePixelRatio)
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
  const toneMappingNode = toneMapping(
    AgXToneMapping,
    uniform(10),
    lensFlareNode
  )
  const postProcessing = new RenderPipeline(
    renderer,
    toneMappingNode.add(dithering)
  )

  const handleResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  }
  window.addEventListener('resize', handleResize)

  void renderer.setAnimationLoop(() => {
    controls.update()
    postProcessing.render()
  })

  return () => {
    window.removeEventListener('resize', handleResize)
    void renderer.setAnimationLoop(null)
    controls.dispose()
    postProcessing.dispose()
    lensFlareNode.dispose()
    aerialNode.dispose()
    cloudsNode.dispose()
    passNode.dispose()
    atmosphereContext.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }
}

export const Story: StoryFC = () => (
  <div
    ref={ref => {
      if (ref != null) {
        const promise = init(ref)
        promise.catch((error: unknown) => {
          console.error(error)
        })
        return () => {
          void promise.then(dispose => {
            dispose()
          })
        }
      }
    }}
  />
)

export default Story
