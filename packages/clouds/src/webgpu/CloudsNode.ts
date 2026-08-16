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
  Matrix4,
  Texture,
  Vector2,
  Vector3,
  type Camera,
  type PerspectiveCamera
} from 'three'
import { hash } from 'three/src/nodes/core/NodeUtils.js'
import {
  exp,
  float,
  int,
  max,
  remapClamp,
  screenSize,
  screenUV,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4
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
import type { CloudLayerLike } from '../CloudLayer'
import { CloudLayers } from '../CloudLayers'
import {
  CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
  CLOUD_SHAPE_TEXTURE_SIZE
} from '../constants'
import { defaults, qualityPresets, type QualityPreset } from '../qualityPresets'
import { CloudShadowNode } from './CloudShadowNode'
import { CloudsMarchNode } from './CloudsMarchNode'
import { CloudsResolveNode } from './CloudsResolveNode'
import { getSTBN, type LocalWeatherChannels } from './common'
import {
  configurePlaceholder2DTexture,
  configurePlaceholder3DTexture,
  configurePlaceholderSTBNTexture,
  loadDefaultCloudTextures,
  type DefaultCloudTextures
} from './defaultTextures'
import type {
  CloudQualityOptions,
  CloudsOptions,
  DefaultTextureLoadOptions
} from './options'
import { ProceduralTexture3DNode } from './ProceduralTexture3DNode'
import { ProceduralTextureNode } from './ProceduralTextureNode'
import { sampleShadowOpticalDepth } from './shadowSampling'
import {
  createCloudLayerUniforms,
  createCloudParameterUniforms,
  updateCloudLayerUniforms,
  type CloudLayerUniforms,
  type CloudParameterUniforms
} from './uniforms'
import { sampleRedBilinear } from './varianceClipping'

const sizeScratch = /*#__PURE__*/ new Vector2()
const vectorScratch1 = /*#__PURE__*/ new Vector3()
const vectorScratch2 = /*#__PURE__*/ new Vector3()
const rotationScratch = /*#__PURE__*/ new Matrix3()

const frameMatrix = (
  frame: NonNullable<NonNullable<CloudsOptions['curvature']>['referenceFrame']>
): Matrix3 =>
  new Matrix3().set(
    frame.east.x,
    frame.north.x,
    frame.up.x,
    frame.east.y,
    frame.north.y,
    frame.up.y,
    frame.east.z,
    frame.north.z,
    frame.up.z
  )

const getPositionTransform = (
  curvature: CloudsOptions['curvature']
): Matrix3 | undefined => {
  if (curvature?.referenceFrame == null || curvature.planetFrame == null) {
    return undefined
  }
  const reference = frameMatrix(curvature.referenceFrame)
  const planet = frameMatrix(curvature.planetFrame).transpose()
  return reference.multiply(planet)
}

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
  readonly localWeatherVelocity = new Vector2()
  readonly shapeVelocity = new Vector3()
  readonly shapeDetailVelocity = new Vector3()

  // Explicit camera uniforms for the surface-shadow consumer. Using a
  // ReferenceNode here collides with the fullscreen pass' built-in
  // object.viewMatrix binding and produces an invalid WGSL member name.
  private readonly surfaceViewMatrix = uniform(new Matrix4()).setName(
    'cloudSurfaceViewMatrix'
  )
  private readonly surfaceProjectionMatrix = uniform(new Matrix4()).setName(
    'cloudSurfaceProjectionMatrix'
  )
  private readonly surfaceCameraNear = uniform(0).setName(
    'cloudSurfaceCameraNear'
  )

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
  private _qualityPreset: QualityPreset = 'high'

  // Textures created by this node (placeholders and the default assets from
  // loadDefaultTextures()), owned and disposed together with it. Textures
  // assigned via the setters are not disposed.
  private readonly placeholderTextures: Array<Texture | Data3DTexture>
  private defaultTextures?: DefaultCloudTextures
  private proceduralLocalWeather?: ProceduralTextureNode
  private proceduralShape?: ProceduralTexture3DNode
  private proceduralShapeDetail?: ProceduralTexture3DNode
  private proceduralTurbulence?: ProceduralTextureNode
  private proceduralSTBN?: ProceduralTexture3DNode

  // Captured in setup() for the CPU shadow-map update in updateBefore():
  private atmosphereContext?: AtmosphereContext
  private camera?: Camera
  private _enabled = true
  private _shadowsEnabled = true
  private _bsm = true
  readonly enabledUniform = uniform('bool').setName('cloudsEnabled')
  /** Runtime gate for the BSM producer and all cloud shadow consumers. */
  readonly shadowsEnabledUniform = uniform('bool').setName(
    'cloudsShadowsEnabled'
  )
  readonly options: CloudsOptions
  readonly shadowDispatchMode: 'automatic' | 'explicit'

  constructor(depthNode?: TextureNode | null, options: CloudsOptions = {}) {
    super('vec4')
    this.depthNode = depthNode
    this.options = options
    this.shadowDispatchMode =
      options.shadows?.dispatchMode ??
      (options.shadows?.autoUpdate === false ? 'explicit' : 'automatic')
    this._shadowsEnabled = options.shadows?.enabled ?? true
    this.shadowsEnabledUniform.value = this._shadowsEnabled
    const ellipsoid = options.ellipsoid ?? options.atmosphereContext?.ellipsoid
    const positionTransform = getPositionTransform(options.curvature)

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
    this.shapeTextureNode = texture3D(shape)
    this.shapeDetailTextureNode = texture3D(shapeDetail)
    this.turbulenceTextureNode = texture(turbulence)
    this.stbnTextureNode = texture3D(stbn)

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
      frame: this.frameUniform,
      planetRadius: options.curvature?.planetRadius,
      referenceRadius: options.curvature?.referenceRadius,
      preserveLocalScale: options.curvature?.preserveLocalScale,
      positionTransform
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
      frame: this.frameUniform,
      curvature: options.curvature,
      depth: options.depth,
      ellipsoid,
      positionTransform
    })

    this.resolveNode = new CloudsResolveNode({
      colorNode: this.marchNode.getTextureNode('output'),
      depthVelocityNode: this.marchNode.getTextureNode('depthVelocity'),
      shadowLengthNode: this.marchNode.getTextureNode('shadowLength'),
      frame: this.frameUniform
    })

    this.updateBeforeType = NodeUpdateType.FRAME
    const quality = options.quality ?? options
    if (quality.preset != null) this.qualityPreset = quality.preset
    if (quality.bsm != null) this.bsm = quality.bsm
    if (quality.lightShafts != null) this.lightShafts = quality.lightShafts
    if (quality.haze != null) this.haze = quality.haze
    if (quality.temporalUpscale != null) {
      this.temporalUpscale = quality.temporalUpscale
    }
    // Keep the requested BSM setting separate from the runtime producer gate:
    // disabling all shadow consumers must not lose the user's BSM preference.
    if (options.shadows?.enabled === false) this.shadowsEnabled = false
    this._enabled = options.enabled ?? true
    this.enabledUniform.value = this._enabled
  }

  override customCacheKey(): number {
    return hash(
      this.shadowNode.customCacheKey(),
      this.marchNode.customCacheKey(),
      this.resolveNode.customCacheKey(),
      Math.round(this.resolutionScale * 1000)
    )
  }

  get enabled(): boolean {
    return this._enabled
  }
  set enabled(value: boolean) {
    this._enabled = value
    this.enabledUniform.value = value
    this.resetHistory()
  }
  setEnabled(value: boolean): this {
    this.enabled = value
    return this
  }
  setCoverage(value: number): this {
    this.coverage = value
    return this
  }

  get shadowsEnabled(): boolean {
    return this._shadowsEnabled
  }
  set shadowsEnabled(value: boolean) {
    if (value === this._shadowsEnabled) return
    this._shadowsEnabled = value
    this.shadowsEnabledUniform.value = value
    // BSM sampling is baked into the march material. Disable its effective
    // input while the producer is gated, then restore the requested setting
    // when the producer is enabled again.
    this.marchNode.bsm = value && this._bsm
    this.resetHistory()
  }
  setShadowsEnabled(value: boolean): this {
    this.shadowsEnabled = value
    return this
  }

  setQuality(options: CloudQualityOptions): this {
    if (options.preset != null) this.qualityPreset = options.preset
    if (options.bsm != null) this.bsm = options.bsm
    if (options.lightShafts != null) this.lightShafts = options.lightShafts
    if (options.haze != null) this.haze = options.haze
    if (options.temporalUpscale != null) {
      this.temporalUpscale = options.temporalUpscale
    }
    this.resetHistory()
    return this
  }

  get maxRayDistance(): number {
    return this.marchNode.maxRayDistance.value
  }
  set maxRayDistance(value: number) {
    this.marchNode.maxRayDistance.value = value
  }

  // The cascaded shadow maps (CPU), owned by the shadow node and updated by
  // this facade every frame:
  get shadowMaps(): CascadedShadowMaps {
    return this.shadowNode.shadowMaps
  }

  // Consumes the BSM when true (the default); false restores the M2-only
  // image with zero shadow optical depth, for regression bisecting. The
  // internal material rebuild is automatic:
  get bsm(): boolean {
    return this._bsm
  }

  set bsm(value: boolean) {
    this._bsm = value
    this.marchNode.bsm = this._shadowsEnabled && value
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

  // Replaces all four layers and synchronizes the channel swizzles baked into
  // the shadow and primary march shaders. Mutating cloudLayers directly is
  // still supported for numeric parameters, but channel changes must go
  // through this method so both consumers are rebuilt consistently.
  setCloudLayers(layers: readonly CloudLayerLike[]): this {
    this.cloudLayers.set(layers)
    const channels = this.cloudLayers
      .localWeatherChannels as LocalWeatherChannels
    this.shadowNode.localWeatherChannels = channels
    this.marchNode.localWeatherChannels = channels
    updateCloudLayerUniforms(this.layerUniforms, this.cloudLayers)
    this.resetHistory()
    return this
  }

  get qualityPreset(): QualityPreset {
    return this._qualityPreset
  }

  set qualityPreset(value: QualityPreset) {
    this._qualityPreset = value
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
    this.marchNode.shadowCascadeCount = preset.shadow.cascadeCount
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
    } else if ((value as TextureNode).isTextureNode) {
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
    } else if ((value as Texture3DNode).isTexture3DNode) {
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
    } else if ((value as Texture3DNode).isTexture3DNode) {
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
    } else if ((value as TextureNode).isTextureNode) {
      this.proceduralTurbulence = undefined
      this.turbulenceTextureNode.value = (value as TextureNode).value
    } else {
      this.proceduralTurbulence = undefined
      this.turbulenceTextureNode.value = value as Texture
    }
  }

  get stbnTexture(): Data3DTexture | Texture3DNode | ProceduralTexture3DNode {
    return this.proceduralSTBN ?? (this.stbnTextureNode.value as Data3DTexture)
  }

  set stbnTexture(value: CloudsTexture3DInput) {
    if (value instanceof ProceduralTexture3DNode) {
      this.proceduralSTBN = value
      this.stbnTextureNode.value = value.texture
    } else if ((value as Texture3DNode).isTexture3DNode) {
      this.proceduralSTBN = undefined
      this.stbnTextureNode.value = (value as Texture3DNode).value
    } else {
      this.proceduralSTBN = undefined
      this.stbnTextureNode.value = value as Data3DTexture
    }
  }

  // Loads the default hosted assets into every texture slot. The loaded
  // textures are owned by this node and disposed together with it.
  loadDefaultTextures(options: DefaultTextureLoadOptions = {}): this {
    this.defaultTextures ??= loadDefaultCloudTextures(options)
    const { localWeather, shape, shapeDetail, turbulence, stbn } =
      this.defaultTextures
    this.localWeatherTexture = localWeather
    this.shapeTexture = shape
    this.shapeDetailTexture = shapeDetail
    this.turbulenceTexture = turbulence
    this.stbnTexture = stbn
    return this
  }

  async loadDefaultTexturesAsync(): Promise<this> {
    this.loadDefaultTextures()
    await this.defaultTextures?.ready
    return this
  }

  getTextureNode(name: 'output' | 'shadowLength' = 'output'): TextureNode {
    return this.resolveNode.getTextureNode(name)
  }

  getShadowLengthNode(): Node<'float'> {
    const shadowLength = sampleRedBilinear(
      this.getTextureNode('shadowLength'),
      screenUV
    )
    return this.shadowsEnabledUniform.select(shadowLength, float(0))
  }

  // Returns the fraction of direct sunlight reaching a scene surface. This
  // is the WebGPU counterpart of AtmosphereShadow consumed by the WebGL
  // AerialPerspectiveEffect. The input is an altitude-corrected ECEF position
  // in meters, matching the WebGL sampling contract.
  getSunTransmittanceNode(
    positionECEF: Node<'vec3'>,
    builder: NodeBuilder
  ): Node<'float'> {
    const atmosphereContext = getAtmosphereContext(builder)
    const camera = atmosphereContext.camera ?? builder.camera
    if (camera == null) {
      return float(1)
    }

    const altitudeCorrection: Node<'vec3'> = atmosphereContext.correctAltitude
      ? atmosphereContext.altitudeCorrectionECEF
      : vec3(0)
    const sampleOpticalDepth = sampleShadowOpticalDepth(
      this.shadowNode.getTextureNode('output'),
      this.shadowNode.shadowUniforms,
      {
        bottomRadius: float(atmosphereContext.parameters.bottomRadius),
        sunDirectionECEF: atmosphereContext.sunDirectionECEF,
        shadowTopHeight: this.layerUniforms.shadowTopHeight,
        matrixECEFToWorld: atmosphereContext.matrixECEFToWorld,
        altitudeCorrectionECEF: altitudeCorrection,
        viewMatrix: this.surfaceViewMatrix,
        cameraNear: this.surfaceCameraNear,
        temporalJitter: vec2(0),
        resolution: screenSize
      },
      {
        cascadeCount: this.shadowNode.cascadeCount,
        shadowSampleCount: this.marchNode.shadowSampleCount,
        includeTail: false
      }
    )
    // The surface-shadow PCF must follow the same temporal policy as the BSM
    // itself. Rotating this STBN slice while temporal shadows are disabled
    // makes otherwise static cast shadows visibly crawl across the receiver.
    const jitter = getSTBN(
      this.stbnTextureNode,
      this.shadowNode.temporalJitter ? this.frameUniform : int(0)
    )

    // Port of AerialPerspectiveEffect.getShadowRadius(). It adapts the PCF
    // radius to the projected size of one texel in cascade 0, keeping nearby
    // receivers sharp and distant receivers stable instead of applying a
    // fixed blur everywhere.
    const worldPosition = atmosphereContext.matrixECEFToWorld
      .mul(vec4(positionECEF.sub(altitudeCorrection), 1))
      .xyz.toConst()
    const shadowMatrix = this.shadowNode.shadowUniforms.shadowMatrices
      .element(int(0))
      .toConst()
    const inverseShadowMatrix = this.shadowNode.inverseShadowMatrices
      .element(int(0))
      .toConst()
    const clip = shadowMatrix.mul(vec4(worldPosition, 1)).toVar()
    clip.assign(clip.div(clip.w))

    const texelSize = this.shadowNode.shadowUniforms.shadowTexelSize
    const clipX = clip.add(vec4(texelSize.x.mul(2), 0, 0, 0)).toConst()
    const clipY = clip.add(vec4(0, texelSize.y.mul(2), 0, 0)).toConst()
    const worldX = inverseShadowMatrix.mul(clipX).toConst()
    const worldY = inverseShadowMatrix.mul(clipY).toConst()

    const viewProjectionMatrix = this.surfaceProjectionMatrix
      .mul(this.surfaceViewMatrix)
      .toConst()
    const projected = viewProjectionMatrix.mul(vec4(worldPosition, 1)).toVar()
    const projectedX = viewProjectionMatrix.mul(worldX).toVar()
    const projectedY = viewProjectionMatrix.mul(worldY).toVar()
    projected.assign(projected.div(projected.w))
    projectedX.assign(projectedX.div(projectedX.w))
    projectedY.assign(projectedY.div(projectedY.w))

    const center = projected.xy.mul(0.5).add(0.5).mul(screenSize).toConst()
    const offsetX = projectedX.xy.mul(0.5).add(0.5).mul(screenSize).toConst()
    const offsetY = projectedY.xy.mul(0.5).add(0.5).mul(screenSize).toConst()
    const projectedTexelSize = max(
      offsetX.distance(center),
      offsetY.distance(center)
    ).toConst()
    const radius = remapClamp(projectedTexelSize, 10, 50, 0, 3)
    const opticalDepth = sampleOpticalDepth(
      positionECEF,
      float(0),
      radius,
      jitter
    )
    return this.shadowsEnabledUniform.select(
      exp(opticalDepth.negate()),
      float(1)
    )
  }

  // Ported from the shadow map portion of CloudsEffect.updateSharedUniforms.
  // The camera position, the sun direction and the world matrices are
  // recomputed from the atmosphere context values on the CPU, independently
  // of the context uniform update timing (see D5 in .port-plan.md):
  private updateShadowMapCamera(): void {
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

  /**
   * Explicitly dispatch the cloud shadow pipeline for integrations that own
   * frame ordering.
   */
  updateShadowMaps(frame: NodeFrame): void {
    if (!this._shadowsEnabled) return
    this.updateShadowMapCamera()
    this.shadowNode.update(frame)
  }

  override updateBefore(frame: NodeFrame): void {
    const { renderer } = frame
    if (renderer == null) {
      return
    }

    ++this.frame
    this.frameUniform.value = this.frame

    const deltaTime = frame.deltaTime ?? 0
    this.localWeatherOffset.addScaledVector(
      this.localWeatherVelocity,
      deltaTime
    )
    this.shapeOffset.addScaledVector(this.shapeVelocity, deltaTime)
    this.shapeDetailOffset.addScaledVector(this.shapeDetailVelocity, deltaTime)

    const camera = this.camera as
      | (Camera & { near: number; projectionMatrix: Matrix4 })
      | undefined
    if (camera != null) {
      this.surfaceViewMatrix.value.copy(camera.matrixWorldInverse)
      this.surfaceProjectionMatrix.value.copy(camera.projectionMatrix)
      this.surfaceCameraNear.value = camera.near
    }

    // CPU-side shared uniform updates:
    updateCloudLayerUniforms(this.layerUniforms, this.cloudLayers)
    if (this._shadowsEnabled) this.updateShadowMapCamera()

    // Keep direct shadowMaps mutations synchronized as well. Quality presets
    // update both sides immediately so material rebuilds see the new count:
    this.marchNode.shadowCascadeCount = this.shadowNode.cascadeCount

    // The facade drives the sub-passes explicitly to guarantee their order;
    // sub-nodes are not independently FRAME-updated. The BSM march + resolve
    // run before the clouds march that consumes them:
    if (this._shadowsEnabled && this.shadowDispatchMode === 'automatic') {
      this.shadowNode.update(frame)
    }

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
    return this.enabledUniform.select(
      this.getTextureNode('output').sample(screenUV),
      vec4(0)
    )
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

export const clouds = (
  depthNode?: TextureNode | null,
  options: CloudsOptions = {}
): CloudsNode => new CloudsNode(depthNode, options)
