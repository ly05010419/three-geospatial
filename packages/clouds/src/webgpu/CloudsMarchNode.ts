// Ported from:
// three-geospatial/packages/clouds/src/CloudsMaterial.ts and
// three-geospatial/packages/clouds/src/shaders/clouds.vert + clouds.frag
//
// M2/M3 scope: the march renders at full resolution into a single rgba16f
// color target with unjittered camera settings (temporalJitter = 0). The BSM
// (beer shadow map) produced by CloudShadowNode is consumed through the
// shadowBuffer/shadowUniforms inputs; the bsm option restores the M2-only
// mode (zero shadow optical depth) for regression bisecting. M4 adds
// marchShadowLength, the Bayer projection jitter, the ¼-resolution target,
// and the depthVelocity and shadowLength MRT outputs.

import {
  HalfFloatType,
  LinearFilter,
  Matrix4,
  RenderTarget,
  RGBAFormat,
  Vector2,
  Vector3,
  type Camera,
  type Data3DTexture,
  type OrthographicCamera,
  type PerspectiveCamera,
  type Texture
} from 'three'
import { hash } from 'three/src/nodes/core/NodeUtils.js'
import {
  add,
  bool,
  dot,
  float,
  Fn,
  If,
  ivec3,
  min,
  mix,
  positionGeometry,
  pow,
  screenUV,
  uniform,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import {
  NodeMaterial,
  QuadMesh,
  RendererUtils,
  TempNode,
  type NodeBuilder,
  type NodeFrame,
  type Texture3DNode,
  type TextureNode,
  type UniformNode
} from 'three/webgpu'
import invariant from 'tiny-invariant'

import {
  getAtmosphereContext,
  getIndirectLuminanceToPoint,
  type AtmosphereContext
} from '@takram/three-atmosphere/webgpu'
import { Geodetic, reinterpretType } from '@takram/three-geospatial'
import {
  depthToViewZ,
  outputTexture,
  turbo,
  type Node
} from '@takram/three-geospatial/webgpu'

import { defaults } from '../qualityPresets'
import {
  getGlobeUv,
  getMipLevel,
  getSTBN,
  sampleMedia,
  sampleWeather,
  type CloudSamplingOptions,
  type CloudSamplingTextures,
  type LocalWeatherChannels
} from './common'
import {
  checker,
  createApproximateHaze,
  createMarchClouds,
  createMarchOpticalDepth,
  createSunSkyIrradianceCache,
  toTexture3DNode,
  toTextureNode,
  type MarchCloudsShadowDependencies
} from './marchClouds'
import type { PhaseFunctionOptions } from './phaseFunction'
import {
  getHazeRayNearFar,
  getRayNearFar,
  rayIntersectsGround,
  raySpheresIntersections
} from './rayIntersections'
import { sampleShadowOpticalDepth } from './shadowSampling'
import type {
  CloudLayerUniforms,
  CloudParameterUniforms,
  CloudShadowUniforms
} from './uniforms'

const { resetRendererState, restoreRendererState } = RendererUtils

const vectorScratch = /*#__PURE__*/ new Vector3()
const geodeticScratch = /*#__PURE__*/ new Geodetic()

export type CloudsMarchDebugShow = 'none' | 'uv' | 'sampleCount' | 'frontDepth'

const debugShowValues: readonly CloudsMarchDebugShow[] = [
  'none',
  'uv',
  'sampleCount',
  'frontDepth'
]

export interface CloudsMarchNodeParameters {
  // The scene depth, read to clamp the ray at the scene. Without it the rays
  // extend to the cloud layer boundaries:
  depthNode?: TextureNode | null
  parameterUniforms: CloudParameterUniforms
  layerUniforms: CloudLayerUniforms
  localWeatherTexture: Texture | TextureNode
  shapeTexture: Data3DTexture | Texture3DNode
  shapeDetailTexture?: Data3DTexture | Texture3DNode | null
  turbulenceTexture?: Texture | TextureNode | null
  stbnTexture: Data3DTexture | Texture3DNode
  // The resolved BSM produced by CloudShadowNode
  // (shadowNode.getTextureNode('output')) and its consumer uniform bag
  // (shadowNode.shadowUniforms). Both must be provided for the BSM
  // consumption; the march falls back to the M2-only mode (zero shadow
  // optical depth) otherwise:
  shadowBuffer?: Texture3DNode | null
  shadowUniforms?: CloudShadowUniforms | null
  // Frame counter that phases the spatiotemporal blue noise. Provide to share
  // the owner's counter; a new uniform is created otherwise:
  frame?: UniformNode<number>
}

export class CloudsMarchNode extends TempNode {
  static override get type(): string {
    return 'CloudsMarchNode'
  }

  depthNode?: TextureNode | null
  parameterUniforms: CloudParameterUniforms
  layerUniforms: CloudLayerUniforms
  localWeatherTexture: Texture | TextureNode
  shapeTexture: Data3DTexture | Texture3DNode
  shapeDetailTexture?: Data3DTexture | Texture3DNode | null
  turbulenceTexture?: Texture | TextureNode | null
  stbnTexture: Data3DTexture | Texture3DNode
  shadowBuffer?: Texture3DNode | null
  shadowUniforms?: CloudShadowUniforms | null

  // Static options, equivalent to the defines in the WebGL version. Changing
  // any of these requires rebuilding the node graph (e.g. by setting
  // needsUpdate on the post-processing that owns this node).
  // Consumes the BSM when true (and the shadow inputs are provided); false
  // restores the M2-only image with zero shadow optical depth, for
  // regression bisecting:
  bsm = true
  // Equivalent to the SHADOW_CASCADE_COUNT define in the WebGL version. Must
  // match the cascade count of the CloudShadowNode producing the shadow
  // buffer; CloudsNode keeps them in sync:
  shadowCascadeCount: number = defaults.shadow.cascadeCount
  // Equivalent to the SHADOW_SAMPLE_COUNT define in the WebGL version:
  shadowSampleCount = 8
  localWeatherChannels: LocalWeatherChannels = 'rgba'
  shapeDetail: boolean = defaults.shapeDetail
  turbulence: boolean = defaults.turbulence
  haze: boolean = defaults.haze
  multiScatteringOctaves: number = defaults.clouds.multiScatteringOctaves
  accurateSunSkyLight: boolean = defaults.clouds.accurateSunSkyLight
  accuratePhaseFunction: boolean = defaults.clouds.accuratePhaseFunction
  // The POWDER and GROUND_BOUNCE defines are derived from the uniform values
  // in the WebGL version. They are plain static options here by design:
  powder = true
  groundBounce = true
  // Ideally these should be uniforms, but the phase function is highly
  // optimizable and used many times, so they are baked as constants:
  scatterAnisotropy1 = 0.7
  scatterAnisotropy2 = -0.2
  scatterAnisotropyMix = 0.5
  debugShow: CloudsMarchDebugShow = 'none'

  // Camera settings, updated in update() via copyCameraSettings():
  readonly viewMatrix: UniformNode<Matrix4> = uniform(new Matrix4()).setName(
    'viewMatrix'
  )
  readonly inverseProjectionMatrix: UniformNode<Matrix4> = uniform(
    new Matrix4()
  ).setName('inverseProjectionMatrix')
  readonly inverseViewMatrix: UniformNode<Matrix4> = uniform(
    new Matrix4()
  ).setName('inverseViewMatrix')
  readonly reprojectionMatrix: UniformNode<Matrix4> = uniform(
    new Matrix4()
  ).setName('reprojectionMatrix')
  readonly viewReprojectionMatrix: UniformNode<Matrix4> = uniform(
    new Matrix4()
  ).setName('viewReprojectionMatrix')
  readonly cameraPosition: UniformNode<Vector3> = uniform(
    new Vector3()
  ).setName('cameraPosition')
  readonly resolution: UniformNode<Vector2> = uniform(new Vector2()).setName(
    'resolution'
  )
  readonly cameraNear: UniformNode<number> = uniform(0).setName('cameraNear')
  readonly cameraFar: UniformNode<number> = uniform(0).setName('cameraFar')
  readonly cameraHeight: UniformNode<number> =
    uniform(0).setName('cameraHeight')
  // Set this before calling update(). CloudsNode drives it with its frame
  // counter, which phases the spatiotemporal blue noise:
  readonly frame: UniformNode<number>
  readonly temporalJitter: UniformNode<Vector2> = uniform(
    new Vector2()
  ).setName('temporalJitter')
  readonly targetUvScale: UniformNode<Vector2> = uniform(
    new Vector2(1, 1)
  ).setName('targetUvScale')
  readonly mipLevelScale: UniformNode<number> =
    uniform(1).setName('mipLevelScale')

  // Scattering
  readonly skyLightScale: UniformNode<number> =
    uniform(1).setName('skyLightScale')
  readonly groundBounceScale: UniformNode<number> =
    uniform(1).setName('groundBounceScale')
  readonly powderScale: UniformNode<number> =
    uniform(0.8).setName('powderScale')
  readonly powderExponent: UniformNode<number> =
    uniform(150).setName('powderExponent')

  // Primary raymarch
  readonly maxIterationCount: UniformNode<number> = uniform(
    defaults.clouds.maxIterationCount,
    'int'
  ).setName('maxIterationCount')
  readonly minStepSize: UniformNode<number> = uniform(
    defaults.clouds.minStepSize
  ).setName('minStepSize')
  readonly maxStepSize: UniformNode<number> = uniform(
    defaults.clouds.maxStepSize
  ).setName('maxStepSize')
  readonly maxRayDistance: UniformNode<number> = uniform(
    defaults.clouds.maxRayDistance
  ).setName('maxRayDistance')
  readonly perspectiveStepScale: UniformNode<number> = uniform(
    defaults.clouds.perspectiveStepScale
  ).setName('perspectiveStepScale')
  readonly minDensity: UniformNode<number> = uniform(
    defaults.clouds.minDensity
  ).setName('minDensity')
  readonly minExtinction: UniformNode<number> = uniform(
    defaults.clouds.minExtinction
  ).setName('minExtinction')
  readonly minTransmittance: UniformNode<number> = uniform(
    defaults.clouds.minTransmittance
  ).setName('minTransmittance')

  // Secondary raymarch
  readonly maxIterationCountToSun: UniformNode<number> = uniform(
    defaults.clouds.maxIterationCountToSun,
    'int'
  ).setName('maxIterationCountToSun')
  readonly maxIterationCountToGround: UniformNode<number> = uniform(
    defaults.clouds.maxIterationCountToGround,
    'int'
  ).setName('maxIterationCountToGround')
  readonly minSecondaryStepSize: UniformNode<number> = uniform(
    defaults.clouds.minSecondaryStepSize
  ).setName('minSecondaryStepSize')
  readonly secondaryStepScale: UniformNode<number> = uniform(
    defaults.clouds.secondaryStepScale
  ).setName('secondaryStepScale')

  // Haze
  readonly hazeDensityScale: UniformNode<number> =
    uniform(3e-5).setName('hazeDensityScale')
  readonly hazeExponent: UniformNode<number> =
    uniform(1e-3).setName('hazeExponent')
  readonly hazeScatteringCoefficient: UniformNode<number> = uniform(
    0.9
  ).setName('hazeScatteringCoefficient')
  readonly hazeAbsorptionCoefficient: UniformNode<number> = uniform(
    0.5
  ).setName('hazeAbsorptionCoefficient')

  private readonly renderTarget: RenderTarget
  private readonly material = new NodeMaterial()
  private readonly mesh = new QuadMesh(this.material)
  private readonly textureNode: TextureNode
  private rendererState?: RendererUtils.RendererState

  // Copies of the camera matrices for the reprojection matrices, which the
  // temporal resolve consumes in M4. copyCameraSettings() can be called
  // multiple times within a frame, so they are stored explicitly:
  private previousProjectionMatrix?: Matrix4
  private previousViewMatrix?: Matrix4

  // Captured in setup() for CPU use in update():
  private atmosphereContext?: AtmosphereContext
  private camera?: Camera

  constructor({
    depthNode,
    parameterUniforms,
    layerUniforms,
    localWeatherTexture,
    shapeTexture,
    shapeDetailTexture,
    turbulenceTexture,
    stbnTexture,
    shadowBuffer,
    shadowUniforms,
    frame
  }: CloudsMarchNodeParameters) {
    super(null)
    this.depthNode = depthNode
    this.parameterUniforms = parameterUniforms
    this.layerUniforms = layerUniforms
    this.localWeatherTexture = localWeatherTexture
    this.shapeTexture = shapeTexture
    this.shapeDetailTexture = shapeDetailTexture
    this.turbulenceTexture = turbulenceTexture
    this.stbnTexture = stbnTexture
    this.shadowBuffer = shadowBuffer
    this.shadowUniforms = shadowUniforms
    this.frame = frame ?? uniform(0, 'int').setName('frame')

    // M4 turns this into a ¼-resolution MRT (color + depthVelocity +
    // shadowLength with RedFormat) target:
    this.renderTarget = new RenderTarget(1, 1, {
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    const outputTextureInstance = this.renderTarget.texture
    outputTextureInstance.minFilter = LinearFilter
    outputTextureInstance.magFilter = LinearFilter
    outputTextureInstance.generateMipmaps = false
    outputTextureInstance.name = 'CloudsMarchNode.Output'

    this.material.name = 'CloudsMarchNode.Material'
    this.textureNode = outputTexture(this, this.renderTarget.texture)
  }

  override customCacheKey(): number {
    return hash(
      +(this.depthNode != null),
      +(this.shadowBuffer != null && this.shadowUniforms != null),
      +this.bsm,
      this.shadowCascadeCount,
      this.shadowSampleCount,
      +this.shapeDetail,
      +this.turbulence,
      +this.haze,
      +this.accurateSunSkyLight,
      +this.accuratePhaseFunction,
      +this.powder,
      +this.groundBounce,
      this.multiScatteringOctaves,
      // The hash function coerces parameters to int32, thus fractions and
      // strings must be encoded manually:
      ...[...this.localWeatherChannels].map(char => 'rgba'.indexOf(char)),
      debugShowValues.indexOf(this.debugShow),
      Math.round(this.scatterAnisotropy1 * 1000),
      Math.round(this.scatterAnisotropy2 * 1000),
      Math.round(this.scatterAnisotropyMix * 1000)
    )
  }

  // The name parameter widens to 'depthVelocity' and 'shadowLength' when the
  // MRT outputs arrive at M4:
  getTextureNode(name: 'output' = 'output'): TextureNode {
    invariant(name === 'output')
    return this.textureNode
  }

  setSize(width: number, height: number): this {
    const { renderTarget } = this
    if (width !== renderTarget.width || height !== renderTarget.height) {
      renderTarget.setSize(width, height)
      this.resolution.value.set(width, height)
      // The render target size always matches the output size in the full
      // resolution mode of M2. M4 sets the ratio of the upscaled resolution
      // (a multiple of 4) to the target size here:
      this.targetUvScale.value.setScalar(1)

      // Invalidate reprojection:
      this.previousProjectionMatrix = undefined
      this.previousViewMatrix = undefined
    }
    return this
  }

  // Ported from CloudsMaterial.copyCameraSettings(), with the temporal
  // upscaling (Bayer projection jitter) path omitted until M4:
  private copyCameraSettings(camera: Camera): void {
    const atmosphereContext = this.atmosphereContext
    invariant(atmosphereContext != null)

    this.viewMatrix.value.copy(camera.matrixWorldInverse)
    this.inverseViewMatrix.value.copy(camera.matrixWorld)

    const previousProjectionMatrix =
      this.previousProjectionMatrix ?? camera.projectionMatrix
    const previousViewMatrix =
      this.previousViewMatrix ?? camera.matrixWorldInverse

    this.temporalJitter.value.setScalar(0)
    this.mipLevelScale.value = 1
    this.inverseProjectionMatrix.value.copy(camera.projectionMatrixInverse)
    this.reprojectionMatrix.value
      .copy(previousProjectionMatrix)
      .multiply(previousViewMatrix)
    this.viewReprojectionMatrix.value
      .copy(this.reprojectionMatrix.value)
      .multiply(this.inverseViewMatrix.value)

    reinterpretType<PerspectiveCamera | OrthographicCamera>(camera)
    this.cameraNear.value = camera.near
    this.cameraFar.value = camera.far

    const cameraPosition = camera.getWorldPosition(this.cameraPosition.value)
    const cameraPositionECEF = vectorScratch
      .copy(cameraPosition)
      .applyMatrix4(atmosphereContext.matrixWorldToECEF.value)
    try {
      this.cameraHeight.value =
        geodeticScratch.setFromECEF(cameraPositionECEF).height
    } catch {
      // Abort when unable to project position to the ellipsoid surface.
    }
  }

  // Stores the current view and projection matrices for the next
  // reprojection. Ported from CloudsMaterial.copyReprojectionMatrix():
  copyReprojectionMatrix(camera: Camera): void {
    this.previousProjectionMatrix ??= new Matrix4()
    this.previousViewMatrix ??= new Matrix4()
    this.previousProjectionMatrix.copy(camera.projectionMatrix)
    this.previousViewMatrix.copy(camera.matrixWorldInverse)
  }

  // Renders the march pass. This node is not updated by the frame loop;
  // CloudsNode drives it explicitly to guarantee the pass ordering, after
  // setting the frame uniform and the size (setSize):
  override update(frame: NodeFrame): void {
    const { renderer } = frame
    const camera = this.camera
    if (renderer == null || camera == null) {
      return
    }

    this.copyCameraSettings(camera)

    this.rendererState = resetRendererState(renderer, this.rendererState)
    renderer.setRenderTarget(this.renderTarget)
    this.mesh.render(renderer)
    restoreRendererState(renderer, this.rendererState)

    this.copyReprojectionMatrix(camera)
  }

  private setupFragmentNode(
    builder: NodeBuilder,
    atmosphereContext: AtmosphereContext,
    camera: Camera
  ): Node {
    const { worldToUnit } = atmosphereContext.parametersNode
    const { matrixWorldToECEF, sunDirectionECEF } = atmosphereContext
    const bottomRadius = float(atmosphereContext.parameters.bottomRadius)
    const altitudeCorrection: Node<'vec3'> = atmosphereContext.correctAltitude
      ? atmosphereContext.altitudeCorrectionECEF
      : vec3(0)

    const { localWeatherRepeat, localWeatherOffset } = this.parameterUniforms
    const { minHeight, maxHeight, shadowTopHeight } = this.layerUniforms

    const perspective = camera.isPerspectiveCamera === true
    const logarithmic = builder.renderer.logarithmicDepthBuffer

    // Vertex-stage ray setup, ported from clouds.vert. All varyings are
    // interpolated across the fullscreen triangle:
    const viewPosition = this.inverseProjectionMatrix.mul(
      vec4(positionGeometry, 1)
    ).xyz
    const worldDirection = this.inverseViewMatrix.mul(vec4(viewPosition, 0)).xyz
    const worldCameraDirection = this.inverseViewMatrix
      .mul(vec4(0, 0, -1, 0))
      .xyz.normalize()
    const cameraPositionECEF = matrixWorldToECEF.mul(
      vec4(this.cameraPosition, 1)
    ).xyz
    const vCameraPosition = cameraPositionECEF.toVertexStage()
    // Direction to the center of the screen:
    const vCameraDirection = matrixWorldToECEF
      .mul(vec4(worldCameraDirection, 0))
      .xyz.toVertexStage()
    // Direction to the texel:
    const vRayDirection = matrixWorldToECEF
      .mul(vec4(worldDirection, 0))
      .xyz.toVertexStage()
    // M4 adds vViewPosition (viewPosition.toVertexStage()) for the no-hit
    // view-space reprojection.

    // Vertex-stage irradiance cache, ported from sampleSunSkyIrradiance() in
    // clouds.vert. The cache is used by the haze always, and by the clouds
    // unless accurateSunSkyLight is on:
    const { groundIrradiance, cloudsIrradiance } = createSunSkyIrradianceCache(
      cameraPositionECEF.add(altitudeCorrection),
      { bottomRadius, worldToUnit, sunDirectionECEF, minHeight, maxHeight }
    )

    // Sampling functions over the input textures:
    const samplingTextures: CloudSamplingTextures = {
      localWeatherTexture: toTextureNode(this.localWeatherTexture),
      shapeTexture: toTexture3DNode(this.shapeTexture),
      shapeDetailTexture:
        this.shapeDetailTexture != null
          ? toTexture3DNode(this.shapeDetailTexture)
          : null,
      turbulenceTexture:
        this.turbulenceTexture != null
          ? toTextureNode(this.turbulenceTexture)
          : null
    }
    const samplingOptions: CloudSamplingOptions = {
      shadow: false,
      channels: this.localWeatherChannels,
      shapeDetail: this.shapeDetail,
      turbulence: this.turbulence
    }
    const sampleWeatherFn = sampleWeather(
      this.parameterUniforms,
      this.layerUniforms,
      samplingTextures,
      samplingOptions
    )
    const sampleMediaFn = sampleMedia(
      this.parameterUniforms,
      this.layerUniforms,
      samplingTextures,
      samplingOptions
    )
    const stbnTexture = toTexture3DNode(this.stbnTexture)

    // The BSM consumption, ported from the SHADOWS-guarded portion of
    // clouds.frag via shadowSampling.ts. The dependencies map onto the nodes
    // this pass already owns and the atmosphere context:
    const { shadowBuffer, shadowUniforms } = this
    const shadow: MarchCloudsShadowDependencies | null =
      this.bsm && shadowBuffer != null && shadowUniforms != null
        ? {
            sampleShadowOpticalDepth: sampleShadowOpticalDepth(
              shadowBuffer,
              shadowUniforms,
              {
                bottomRadius,
                sunDirectionECEF,
                shadowTopHeight,
                matrixECEFToWorld: atmosphereContext.matrixECEFToWorld,
                altitudeCorrectionECEF: altitudeCorrection,
                viewMatrix: this.viewMatrix,
                cameraNear: this.cameraNear,
                temporalJitter: this.temporalJitter,
                resolution: this.resolution
              },
              {
                cascadeCount: this.shadowCascadeCount,
                shadowSampleCount: this.shadowSampleCount
              }
            ),
            maxShadowFilterRadius: shadowUniforms.maxShadowFilterRadius
          }
        : null

    const phaseFunctionOptions: PhaseFunctionOptions = {
      accuratePhaseFunction: this.accuratePhaseFunction,
      scatterAnisotropy1: this.scatterAnisotropy1,
      scatterAnisotropy2: this.scatterAnisotropy2,
      scatterAnisotropyMix: this.scatterAnisotropyMix
    }

    const marchOpticalDepth = createMarchOpticalDepth({
      bottomRadius,
      minSecondaryStepSize: this.minSecondaryStepSize,
      secondaryStepScale: this.secondaryStepScale,
      sampleWeather: sampleWeatherFn,
      sampleMedia: sampleMediaFn
    })
    const marchClouds = createMarchClouds({
      options: {
        multiScatteringOctaves: this.multiScatteringOctaves,
        accurateSunSkyLight: this.accurateSunSkyLight,
        groundBounce: this.groundBounce,
        powder: this.powder
      },
      phaseFunctionOptions,
      bottomRadius,
      worldToUnit,
      sunDirectionECEF,
      parameterUniforms: this.parameterUniforms,
      layerUniforms: this.layerUniforms,
      uniforms: this,
      sampleWeather: sampleWeatherFn,
      sampleMedia: sampleMediaFn,
      marchOpticalDepth,
      shadow,
      groundIrradiance,
      cloudsIrradiance
    })
    const approximateHaze = this.haze
      ? createApproximateHaze({
          phaseFunctionOptions,
          bottomRadius,
          coverage: this.parameterUniforms.coverage,
          cameraHeight: this.cameraHeight,
          skyLightScale: this.skyLightScale,
          hazeDensityScale: this.hazeDensityScale,
          hazeExponent: this.hazeExponent,
          hazeScatteringCoefficient: this.hazeScatteringCoefficient,
          hazeAbsorptionCoefficient: this.hazeAbsorptionCoefficient,
          groundIrradiance
        })
      : null

    return Fn(() => {
      const cameraPosition = vCameraPosition.add(altitudeCorrection).toConst()
      const rayDirection = vRayDirection.normalize().toConst()
      const cosTheta = dot(sunDirectionECEF, rayDirection).toConst()

      // getIntersections():
      const ground = rayIntersectsGround(
        cameraPosition,
        rayDirection,
        bottomRadius
      ).toConst()
      const { first, second } = raySpheresIntersections(
        cameraPosition,
        rayDirection,
        add(bottomRadius, vec4(0, minHeight, maxHeight, shadowTopHeight))
      )

      const rayNearFar = getRayNearFar(
        ground,
        first,
        second,
        this.cameraHeight,
        this.cameraNear,
        minHeight,
        maxHeight,
        this.maxRayDistance
      ).toVar()

      const hazeRayNearFar = this.haze
        ? getHazeRayNearFar(
            ground,
            first,
            second,
            this.cameraHeight,
            this.cameraNear,
            maxHeight
          ).toVar()
        : null

      // getRayDistanceToScene(). M2 reads the depth unjittered at the exact
      // target size (targetUvScale = 1, temporalJitter = 0). The scene view Z
      // is derived here again in M4 for the no-hit reprojection:
      const depthNode = this.depthNode
      if (depthNode != null) {
        const depthUv = screenUV
          .mul(this.targetUvScale)
          .add(this.temporalJitter)
        const depth = depthNode.sample(depthUv).r.toConst()
        const rayDistanceToScene = float(0).toVar()
        If(depth.lessThan(1 - 1e-7), () => {
          const viewZ = depthToViewZ(depth, this.cameraNear, this.cameraFar, {
            perspective,
            logarithmic
          })
          rayDistanceToScene.assign(
            viewZ.negate().div(dot(rayDirection, vCameraDirection))
          )
        })
        If(rayDistanceToScene.greaterThan(0), () => {
          rayNearFar.y.assign(min(rayNearFar.y, rayDistanceToScene))
          if (hazeRayNearFar != null) {
            hazeRayNearFar.y.assign(min(hazeRayNearFar.y, rayDistanceToScene))
          }
        })
      }

      const intersectsGround = rayNearFar.lessThan(vec2(0)).any().toConst()
      const intersectsScene = rayNearFar.y.lessThan(rayNearFar.x).toConst()

      const stbn = getSTBN(stbnTexture, this.frame).toConst()

      const color = vec4(0).toVar()
      const frontDepth = rayNearFar.y.toVar()

      // The debug views replicate the early returns of the WebGL version:
      // pixels with the debug output assigned bypass the haze compositing:
      const debug =
        this.debugShow !== 'none'
          ? { output: vec4(0).toVar(), done: bool(false).toVar() }
          : null

      If(intersectsGround.not().and(intersectsScene.not()), () => {
        const rayOrigin = rayDirection
          .mul(rayNearFar.x)
          .add(cameraPosition)
          .toConst()
        const globeUv = getGlobeUv(rayOrigin).toConst()

        if (this.debugShow === 'uv') {
          invariant(debug != null)
          debug.output.assign(
            vec4(
              vec3(
                checker(globeUv, localWeatherRepeat.add(localWeatherOffset))
              ),
              1
            )
          )
          debug.done.assign(bool(true))
        } else {
          const mipLevel = getMipLevel(
            globeUv.mul(localWeatherRepeat),
            this.resolution
          )
            .mul(this.mipLevelScale)
            .toVar()
          mipLevel.assign(
            mix(0, mipLevel, min(1, this.cameraHeight.mul(0.2).div(maxHeight)))
          )

          const sampleCount =
            this.debugShow === 'sampleCount' ? ivec3(0).toVar() : undefined
          const marched = marchClouds(
            rayOrigin,
            rayDirection,
            rayNearFar,
            cosTheta,
            stbn,
            pow(2, mipLevel),
            ...(sampleCount != null ? ([sampleCount] as const) : [])
          ).toConst()
          color.assign(marched.get('color'))

          if (this.debugShow === 'sampleCount') {
            invariant(debug != null && sampleCount != null)
            debug.output.assign(vec4(vec3(sampleCount).div(vec3(500, 5, 5)), 1))
            debug.done.assign(bool(true))
          } else {
            // Front depth will be -1 when no samples are accumulated:
            const marchedFrontDepth = marched.get('frontDepth').toConst()
            If(marchedFrontDepth.greaterThanEqual(0), () => {
              frontDepth.assign(rayNearFar.x.add(marchedFrontDepth))

              // M4 clamps the shadow length ray at the clouds and derives the
              // shadow length before applying the aerial perspective here.

              if (hazeRayNearFar != null) {
                // Clamp the haze ray at the clouds, interpolated by the alpha
                // for smoother edges:
                hazeRayNearFar.y.assign(
                  mix(
                    hazeRayNearFar.y,
                    min(frontDepth, hazeRayNearFar.y),
                    color.a
                  )
                )
              }

              // applyAerialPerspective(). The shadow length is always 0 in
              // M2:
              const frontPosition = rayDirection
                .mul(frontDepth)
                .add(cameraPosition)
                .toConst()
              const luminanceTransfer = getIndirectLuminanceToPoint(
                cameraPosition.mul(worldToUnit),
                frontPosition.mul(worldToUnit),
                float(0),
                sunDirectionECEF
              ).toConst()
              const inscatter = luminanceTransfer.get('luminance')
              const transmittance = luminanceTransfer.get('transmittance')
              color.rgb.assign(
                color.rgb.mul(transmittance).add(inscatter.mul(color.a))
              )

              // M4 derives the depth/velocity MRT output from the front
              // position here.
            })
          }
        }
      })

      // M4 derives the no-hit view-space reprojection velocity here.

      if (this.debugShow === 'frontDepth') {
        invariant(debug != null)
        debug.output.assign(vec4(turbo(frontDepth.div(this.maxRayDistance)), 1))
        debug.done.assign(bool(true))
      }

      if (approximateHaze != null && hazeRayNearFar != null) {
        const haze = approximateHaze(
          rayDirection.mul(this.cameraNear).add(cameraPosition),
          rayDirection,
          hazeRayNearFar.y.sub(hazeRayNearFar.x),
          cosTheta,
          float(0) // The shadow length is always 0 in M2.
        ).toConst()
        color.rgb.assign(mix(color.rgb, haze.rgb, haze.a))
        color.a.assign(color.a.mul(haze.a.oneMinus()).add(haze.a))
      }

      return debug != null ? debug.done.select(debug.output, color) : color
    })()
  }

  override setup(builder: NodeBuilder): unknown {
    const atmosphereContext = getAtmosphereContext(builder)
    this.atmosphereContext = atmosphereContext

    const camera = atmosphereContext.camera ?? builder.camera
    if (camera == null) {
      return super.setup(builder)
    }
    this.camera = camera

    this.material.fragmentNode = this.setupFragmentNode(
      builder,
      atmosphereContext,
      camera
    )
    this.material.needsUpdate = true

    return super.setup(builder)
  }

  override dispose(): void {
    this.renderTarget.dispose()
    this.material.dispose()
    this.mesh.geometry.dispose()
    super.dispose()
  }
}

export const cloudsMarch = (
  ...args: ConstructorParameters<typeof CloudsMarchNode>
): CloudsMarchNode => new CloudsMarchNode(...args)
