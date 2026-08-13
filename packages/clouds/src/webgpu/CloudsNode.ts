// Facade over the WebGPU clouds render pipeline.
// Ported from: three-geospatial/packages/clouds/src/CloudsEffect.ts
// Texture loading path ported from: three-geospatial/packages/clouds/src/r3f/Clouds.tsx
//
// The facade owns the shared uniform bags, the cloud layers, the frame
// counter, the input textures, the BSM (beer shadow map) producer
// (CloudShadowNode, including its CPU CascadedShadowMaps), march node, and
// temporal resolve node, driving them in the CloudsEffect.update() order every
// frame (see D1 in .port-plan.md).

import {
  Data3DTexture,
  Matrix3,
  Texture,
  Vector2,
  Vector3,
  type Camera,
  type PerspectiveCamera
} from 'three'
import { hash } from 'three/src/nodes/core/NodeUtils.js'
import {
  ivec2,
  screenCoordinate,
  screenUV,
  texture,
  texture3D,
  uniform
} from 'three/tsl'
import {
  NodeUpdateType,
  TempNode,
  type NodeBuilder,
  type NodeFrame,
  type Texture3DNode,
  type TextureNode,
  type UniformNode
} from 'three/webgpu'

import {
  getAtmosphereContext,
  type AtmosphereContext
} from '@takram/three-atmosphere/webgpu'
import { lerp } from '@takram/three-geospatial'
import type { Node } from '@takram/three-geospatial/webgpu'

import type { CascadedShadowMaps } from '../CascadedShadowMaps'
import { CloudLayers } from '../CloudLayers'
import {
  CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
  CLOUD_SHAPE_TEXTURE_SIZE
} from '../constants'
import { defaults, qualityPresets, type QualityPreset } from '../qualityPresets'
import { CloudShadowNode } from './CloudShadowNode'
import { CloudsMarchNode } from './CloudsMarchNode'
import { CloudsResolveNode } from './CloudsResolveNode'
import {
  configurePlaceholder2DTexture,
  configurePlaceholder3DTexture,
  configurePlaceholderSTBNTexture,
  loadDefaultCloudTextures,
  type DefaultCloudTextures
} from './defaultTextures'
import { ProceduralTexture3DNode } from './ProceduralTexture3DNode'
import { ProceduralTextureNode } from './ProceduralTextureNode'
import {
  createCloudLayerUniforms,
  createCloudParameterUniforms,
  updateCloudLayerUniforms,
  type CloudLayerUniforms,
  type CloudParameterUniforms
} from './uniforms'

const sizeScratch = /*#__PURE__*/ new Vector2()
const vectorScratch1 = /*#__PURE__*/ new Vector3()
const vectorScratch2 = /*#__PURE__*/ new Vector3()
const rotationScratch = /*#__PURE__*/ new Matrix3()

export type CloudsTextureInput = Texture | TextureNode | ProceduralTextureNode
export type CloudsTexture3DInput =
  | Data3DTexture
  | Texture3DNode
  | ProceduralTexture3DNode

export class CloudsNode extends TempNode {
  static override get type(): string {
    return 'CloudsNode'
  }

  depthNode?: TextureNode | null

  readonly cloudLayers = CloudLayers.DEFAULT.clone()

  // Mutable instances of the cloud parameter uniforms, mirroring the WebGL
  // CloudsEffect fields:
  readonly localWeatherRepeat = new Vector2().setScalar(100)
  readonly localWeatherOffset = new Vector2()
  readonly shapeRepeat = new Vector3().setScalar(0.0003)
  readonly shapeOffset = new Vector3()
  readonly shapeDetailRepeat = new Vector3().setScalar(0.006)
  readonly shapeDetailOffset = new Vector3()
  readonly turbulenceRepeat = new Vector2().setScalar(20)

  // Uniforms shared by reference between the shadow and march nodes (see D6
  // in .port-plan.md):
  readonly parameterUniforms: CloudParameterUniforms
  readonly layerUniforms: CloudLayerUniforms

  readonly shadowNode: CloudShadowNode
  readonly marchNode: CloudsMarchNode
  readonly resolveNode: CloudsResolveNode

  resolutionScale: number = defaults.resolutionScale

  // Texture node wrappers whose values can be swapped without rebuilding:
  private readonly localWeatherTextureNode: TextureNode
  private readonly shapeTextureNode: Texture3DNode
  private readonly shapeDetailTextureNode: Texture3DNode
  private readonly turbulenceTextureNode: TextureNode
  private readonly stbnTextureNode: Texture3DNode

  private frame = 0
  private readonly frameUniform: UniformNode<number>

  // Textures created by this node (placeholders and the default assets from
  // loadDefaultTextures()), owned and disposed together with it. Textures
  // assigned via the setters are not disposed.
  private readonly placeholderTextures: Array<Texture | Data3DTexture>
  private defaultTextures?: DefaultCloudTextures
  private proceduralLocalWeather?: ProceduralTextureNode
  private proceduralShape?: ProceduralTexture3DNode
  private proceduralShapeDetail?: ProceduralTexture3DNode
  private proceduralTurbulence?: ProceduralTextureNode

  // Captured in setup() for the CPU shadow-map update in updateBefore():
  private atmosphereContext?: AtmosphereContext
  private camera?: Camera

  constructor(depthNode?: TextureNode | null) {
    super('vec4')
    this.depthNode = depthNode

    this.parameterUniforms = createCloudParameterUniforms({
      localWeatherRepeat: this.localWeatherRepeat,
      localWeatherOffset: this.localWeatherOffset,
      shapeRepeat: this.shapeRepeat,
      shapeOffset: this.shapeOffset,
      shapeDetailRepeat: this.shapeDetailRepeat,
      shapeDetailOffset: this.shapeDetailOffset,
      turbulenceRepeat: this.turbulenceRepeat
    })
    this.layerUniforms = createCloudLayerUniforms()
    updateCloudLayerUniforms(this.layerUniforms, this.cloudLayers)

    // Placeholder textures until real ones are assigned via the setters or
    // loadDefaultTextures(). Rendering with placeholders yields no clouds.
    // CRITICAL: The placeholders must carry the same sampler state as the
    // textures destined for them, because the shader is built against the
    // placeholders. The WGSL node builder bakes the sampling path at codegen:
    // a Data3DTexture defaults to NearestFilter, which three treats as
    // unfilterable and compiles into a clamped textureLoad, silently replacing
    // the repeat-wrapped linear sampling the clouds shader requires:
    this.placeholderTextures = [
      configurePlaceholder2DTexture(new Texture()),
      configurePlaceholder3DTexture(
        new Data3DTexture(),
        CLOUD_SHAPE_TEXTURE_SIZE,
        CLOUD_SHAPE_TEXTURE_SIZE,
        CLOUD_SHAPE_TEXTURE_SIZE
      ),
      configurePlaceholder3DTexture(
        new Data3DTexture(),
        CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
        CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
        CLOUD_SHAPE_DETAIL_TEXTURE_SIZE
      ),
      configurePlaceholder2DTexture(new Texture()),
      configurePlaceholderSTBNTexture(new Data3DTexture())
    ]
    const [localWeather, shape, shapeDetail, turbulence, stbn] =
      this.placeholderTextures
    this.localWeatherTextureNode = texture(localWeather)
    this.shapeTextureNode = texture3D(shape as Data3DTexture)
    this.shapeDetailTextureNode = texture3D(shapeDetail as Data3DTexture)
    this.turbulenceTextureNode = texture(turbulence)
    this.stbnTextureNode = texture3D(stbn as Data3DTexture)

    this.frameUniform = uniform(0, 'int').setName('frame')

    // The BSM producer, sharing the uniform bags, the texture node wrappers
    // and the frame counter with the march node (D6):
    this.shadowNode = new CloudShadowNode({
      parameterUniforms: this.parameterUniforms,
      layerUniforms: this.layerUniforms,
      localWeatherTexture: this.localWeatherTextureNode,
      shapeTexture: this.shapeTextureNode,
      shapeDetailTexture: this.shapeDetailTextureNode,
      turbulenceTexture: this.turbulenceTextureNode,
      stbnTexture: this.stbnTextureNode,
      frame: this.frameUniform
    })
    // The default of the frozen comparison parameters (§3.3 in
    // .port-plan.md). The WebGL CascadedShadowMaps defaults to the camera far
    // instead, which extends the cascades needlessly with the story's 4e5
    // far plane:
    this.shadowNode.shadowMaps.maxFar = 1e5

    this.marchNode = new CloudsMarchNode({
      depthNode: depthNode ?? null,
      parameterUniforms: this.parameterUniforms,
      layerUniforms: this.layerUniforms,
      localWeatherTexture: this.localWeatherTextureNode,
      shapeTexture: this.shapeTextureNode,
      shapeDetailTexture: this.shapeDetailTextureNode,
      turbulenceTexture: this.turbulenceTextureNode,
      stbnTexture: this.stbnTextureNode,
      shadowBuffer: this.shadowNode.getTextureNode('output'),
      shadowUniforms: this.shadowNode.shadowUniforms,
      frame: this.frameUniform
    })

    this.resolveNode = new CloudsResolveNode({
      colorNode: this.marchNode.getTextureNode('output'),
      depthVelocityNode: this.marchNode.getTextureNode('depthVelocity'),
      shadowLengthNode: this.marchNode.getTextureNode('shadowLength'),
      frame: this.frameUniform
    })

    this.updateBeforeType = NodeUpdateType.FRAME
  }

  override customCacheKey(): number {
    return hash(
      this.shadowNode.customCacheKey(),
      this.marchNode.customCacheKey(),
      this.resolveNode.customCacheKey(),
      Math.round(this.resolutionScale * 1000)
    )
  }

  // The cascaded shadow maps (CPU), owned by the shadow node and updated by
  // this facade every frame:
  get shadowMaps(): CascadedShadowMaps {
    return this.shadowNode.shadowMaps
  }

  // Consumes the BSM when true (the default); false restores the M2-only
  // image with zero shadow optical depth, for regression bisecting. Changing
  // this requires rebuilding the node graph (e.g. by setting needsUpdate on
  // the post-processing that owns this node):
  get bsm(): boolean {
    return this.marchNode.bsm
  }

  set bsm(value: boolean) {
    this.marchNode.bsm = value
  }

  get temporalUpscale(): boolean {
    return this.resolveNode.temporalUpscale
  }

  set temporalUpscale(value: boolean) {
    if (value !== this.resolveNode.temporalUpscale) {
      this.marchNode.temporalUpscale = value
      this.resolveNode.temporalUpscale = value
      this.resolveNode.resetHistory()
    }
  }

  get lightShafts(): boolean {
    return this.resolveNode.lightShafts
  }

  set lightShafts(value: boolean) {
    if (value !== this.resolveNode.lightShafts) {
      this.marchNode.lightShafts = value
      this.resolveNode.lightShafts = value
      this.resolveNode.resetHistory()
    }
  }

  // Clears temporal history so that both resolves restart from the current
  // frame, for deterministic captures (see R10 in .port-plan.md):
  resetHistory(): void {
    this.shadowNode.resetHistory()
    this.resolveNode.resetHistory()
  }

  // Convenience accessor equivalent to clouds.coverage in the WebGL version:
  get coverage(): number {
    return this.parameterUniforms.coverage.value
  }

  set coverage(value: number) {
    this.parameterUniforms.coverage.value = value
  }

  set qualityPreset(value: QualityPreset) {
    const preset = qualityPresets[value]

    this.resolutionScale = preset.resolutionScale
    this.lightShafts = preset.lightShafts
    this.shapeDetail = preset.shapeDetail
    this.turbulence = preset.turbulence
    this.haze = preset.haze

    Object.assign(this.marchNode, {
      multiScatteringOctaves: preset.clouds.multiScatteringOctaves,
      accurateSunSkyLight: preset.clouds.accurateSunSkyLight,
      accuratePhaseFunction: preset.clouds.accuratePhaseFunction
    })
    this.marchNode.maxIterationCount.value = preset.clouds.maxIterationCount
    this.marchNode.minStepSize.value = preset.clouds.minStepSize
    this.marchNode.maxStepSize.value = preset.clouds.maxStepSize
    this.marchNode.maxRayDistance.value = preset.clouds.maxRayDistance
    this.marchNode.perspectiveStepScale.value =
      preset.clouds.perspectiveStepScale
    this.marchNode.minDensity.value = preset.clouds.minDensity
    this.marchNode.minExtinction.value = preset.clouds.minExtinction
    this.marchNode.minTransmittance.value = preset.clouds.minTransmittance
    this.marchNode.maxIterationCountToGround.value =
      preset.clouds.maxIterationCountToGround
    this.marchNode.maxIterationCountToSun.value =
      preset.clouds.maxIterationCountToSun
    this.marchNode.minSecondaryStepSize.value =
      preset.clouds.minSecondaryStepSize
    this.marchNode.secondaryStepScale.value = preset.clouds.secondaryStepScale
    this.marchNode.maxShadowLengthIterationCount.value =
      preset.clouds.maxShadowLengthIterationCount
    this.marchNode.minShadowLengthStepSize.value =
      preset.clouds.minShadowLengthStepSize
    this.marchNode.maxShadowLengthRayDistance.value =
      preset.clouds.maxShadowLengthRayDistance

    this.shadowNode.shadowMaps.cascadeCount = preset.shadow.cascadeCount
    this.shadowNode.shadowMaps.mapSize.copy(preset.shadow.mapSize)
    this.shadowNode.maxIterationCount.value = preset.shadow.maxIterationCount
    this.shadowNode.minStepSize.value = preset.shadow.minStepSize
    this.shadowNode.maxStepSize.value = preset.shadow.maxStepSize
    this.shadowNode.minDensity.value = preset.shadow.minDensity
    this.shadowNode.minExtinction.value = preset.shadow.minExtinction
    this.shadowNode.minTransmittance.value = preset.shadow.minTransmittance
  }

  get shapeDetail(): boolean {
    return this.marchNode.shapeDetail
  }

  set shapeDetail(value: boolean) {
    this.marchNode.shapeDetail = value
    this.shadowNode.shapeDetail = value
  }

  get turbulence(): boolean {
    return this.marchNode.turbulence
  }

  set turbulence(value: boolean) {
    this.marchNode.turbulence = value
    this.shadowNode.turbulence = value
  }

  get haze(): boolean {
    return this.marchNode.haze
  }

  set haze(value: boolean) {
    this.marchNode.haze = value
  }

  get localWeatherTexture(): Texture | TextureNode | ProceduralTextureNode {
    return this.proceduralLocalWeather ?? this.localWeatherTextureNode.value
  }

  set localWeatherTexture(value: CloudsTextureInput) {
    if (value instanceof ProceduralTextureNode) {
      this.proceduralLocalWeather = value
      this.localWeatherTextureNode.value = value.texture
    } else if ((value as TextureNode).isTextureNode === true) {
      this.proceduralLocalWeather = undefined
      this.localWeatherTextureNode.value = (value as TextureNode).value
    } else {
      this.proceduralLocalWeather = undefined
      this.localWeatherTextureNode.value = value as Texture
    }
  }

  get shapeTexture(): Data3DTexture | Texture3DNode | ProceduralTexture3DNode {
    return (
      this.proceduralShape ?? (this.shapeTextureNode.value as Data3DTexture)
    )
  }

  set shapeTexture(value: CloudsTexture3DInput) {
    if (value instanceof ProceduralTexture3DNode) {
      this.proceduralShape = value
      this.shapeTextureNode.value = value.texture
    } else if ((value as Texture3DNode).isTexture3DNode === true) {
      this.proceduralShape = undefined
      this.shapeTextureNode.value = (value as Texture3DNode).value
    } else {
      this.proceduralShape = undefined
      this.shapeTextureNode.value = value as Data3DTexture
    }
  }

  get shapeDetailTexture():
    | Data3DTexture
    | Texture3DNode
    | ProceduralTexture3DNode {
    return (
      this.proceduralShapeDetail ??
      (this.shapeDetailTextureNode.value as Data3DTexture)
    )
  }

  set shapeDetailTexture(value: CloudsTexture3DInput) {
    if (value instanceof ProceduralTexture3DNode) {
      this.proceduralShapeDetail = value
      this.shapeDetailTextureNode.value = value.texture
    } else if ((value as Texture3DNode).isTexture3DNode === true) {
      this.proceduralShapeDetail = undefined
      this.shapeDetailTextureNode.value = (value as Texture3DNode).value
    } else {
      this.proceduralShapeDetail = undefined
      this.shapeDetailTextureNode.value = value as Data3DTexture
    }
  }

  get turbulenceTexture(): Texture | TextureNode | ProceduralTextureNode {
    return this.proceduralTurbulence ?? this.turbulenceTextureNode.value
  }

  set turbulenceTexture(value: CloudsTextureInput) {
    if (value instanceof ProceduralTextureNode) {
      this.proceduralTurbulence = value
      this.turbulenceTextureNode.value = value.texture
    } else if ((value as TextureNode).isTextureNode === true) {
      this.proceduralTurbulence = undefined
      this.turbulenceTextureNode.value = (value as TextureNode).value
    } else {
      this.proceduralTurbulence = undefined
      this.turbulenceTextureNode.value = value as Texture
    }
  }

  get stbnTexture(): Data3DTexture | Texture3DNode | ProceduralTexture3DNode {
    return this.stbnTextureNode.value as Data3DTexture
  }

  set stbnTexture(value: CloudsTexture3DInput) {
    if (value instanceof ProceduralTexture3DNode) {
      this.stbnTextureNode.value = value.texture
    } else if ((value as Texture3DNode).isTexture3DNode === true) {
      this.stbnTextureNode.value = (value as Texture3DNode).value
    } else {
      this.stbnTextureNode.value = value as Data3DTexture
    }
  }

  // Loads the default hosted assets into every texture slot. The loaded
  // textures are owned by this node and disposed together with it.
  loadDefaultTextures(): this {
    this.defaultTextures ??= loadDefaultCloudTextures()
    const { localWeather, shape, shapeDetail, turbulence, stbn } =
      this.defaultTextures
    this.localWeatherTexture = localWeather
    this.shapeTexture = shape
    this.shapeDetailTexture = shapeDetail
    this.turbulenceTexture = turbulence
    this.stbnTexture = stbn
    return this
  }

  getTextureNode(name: 'output' | 'shadowLength' = 'output'): TextureNode {
    return this.resolveNode.getTextureNode(name)
  }

  getShadowLengthNode(): Node<'float'> {
    return this.getTextureNode('shadowLength').load(ivec2(screenCoordinate.xy))
      .r
  }

  // Ported from the shadow map portion of CloudsEffect.updateSharedUniforms.
  // The camera position, the sun direction and the world matrices are
  // recomputed from the atmosphere context values on the CPU, independently
  // of the context uniform update timing (see D5 in .port-plan.md):
  private updateShadowMaps(): void {
    const atmosphereContext = this.atmosphereContext
    const camera = this.camera
    if (atmosphereContext == null || camera == null) {
      return
    }
    const worldToECEFMatrix = atmosphereContext.matrixWorldToECEF.value
    const sunDirectionECEF = atmosphereContext.sunDirectionECEF.value
    const cameraPositionECEF = camera
      .getWorldPosition(vectorScratch1)
      .applyMatrix4(worldToECEFMatrix)

    // TODO: Position the sun on the top atmosphere sphere.
    // Increase light's distance to the target when the sun is at the horizon.
    // [Comment and heuristic preserved from the WebGL version.]
    const surfaceNormal = atmosphereContext.ellipsoid.getSurfaceNormal(
      cameraPositionECEF,
      vectorScratch2
    )
    const zenithAngle = sunDirectionECEF.dot(surfaceNormal)
    const distance = lerp(1e6, 1e3, zenithAngle)

    const ecefToWorldRotation = rotationScratch
      .setFromMatrix4(worldToECEFMatrix)
      .transpose()
    this.shadowNode.shadowMaps.update(
      camera as PerspectiveCamera,
      vectorScratch2.copy(sunDirectionECEF).applyMatrix3(ecefToWorldRotation),
      distance
    )
  }

  override updateBefore(frame: NodeFrame): void {
    const { renderer } = frame
    if (renderer == null) {
      return
    }

    ++this.frame
    this.frameUniform.value = this.frame

    // CPU-side shared uniform updates. Velocity integration of the offset
    // uniforms is added in later milestones:
    updateCloudLayerUniforms(this.layerUniforms, this.cloudLayers)
    this.updateShadowMaps()

    // Keep the consumer's unrolled cascade count in sync with the producer.
    // Changing the cascade count still requires rebuilding the node graph
    // (see D7 in .port-plan.md):
    this.marchNode.shadowCascadeCount = this.shadowNode.cascadeCount

    // The facade drives the sub-passes explicitly to guarantee their order;
    // sub-nodes are not independently FRAME-updated. The BSM march + resolve
    // run before the clouds march that consumes them:
    this.shadowNode.update(frame)

    const size = renderer.getDrawingBufferSize(sizeScratch)
    const width = Math.max(1, Math.ceil(size.x * this.resolutionScale))
    const height = Math.max(1, Math.ceil(size.y * this.resolutionScale))
    this.marchNode.setSize(width, height)
    this.marchNode.update(frame)
    this.resolveNode.setSize(width, height)
    this.resolveNode.update(frame)
  }

  override setup(builder: NodeBuilder): unknown {
    // Captured for the CPU shadow map update. The camera resolution mirrors
    // CloudsMarchNode.setup():
    const atmosphereContext = getAtmosphereContext(builder)
    this.atmosphereContext = atmosphereContext
    this.camera = atmosphereContext.camera ?? builder.camera ?? undefined
    return this.resolutionScale === 1
      ? this.getTextureNode('output').load(ivec2(screenCoordinate.xy))
      : this.getTextureNode('output').sample(screenUV)
  }

  override dispose(): void {
    this.shadowNode.dispose()
    this.marchNode.dispose()
    this.resolveNode.dispose()
    for (const texture of this.placeholderTextures) {
      texture.dispose()
    }
    if (this.defaultTextures != null) {
      const { localWeather, shape, shapeDetail, turbulence, stbn } =
        this.defaultTextures
      localWeather.dispose()
      shape.dispose()
      shapeDetail.dispose()
      turbulence.dispose()
      stbn.dispose()
    }
    super.dispose()
  }
}

export const clouds = (depthNode?: TextureNode | null): CloudsNode =>
  new CloudsNode(depthNode)
