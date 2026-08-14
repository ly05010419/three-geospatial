// Ported from:
// three-geospatial/packages/clouds/src/ShadowMaterial.ts,
// three-geospatial/packages/clouds/src/ShadowPass.ts,
// three-geospatial/packages/clouds/src/ShadowResolveMaterial.ts and
// three-geospatial/packages/clouds/src/shaders/shadow.vert + shadow.frag +
// shadowResolve.vert + shadowResolve.frag
//
// The WebGL version rasterizes the BSM (beer shadow map) into a
// sampler2DArray via MRT over the array layers (framebufferTextureLayer),
// which has no WebGPU equivalent. Following the D2 design decision in
// .port-plan.md, the BSM becomes two compute passes into Storage3DTexture
// slices instead:
// - The march compute covers [mapSize.x, mapSize.y, cascadeCount] in a single
//   dispatch with globalId.z as the cascade index, writing the marched BSM
//   into bsmCurrent and the texel-space depth velocity into bsmDepthVelocity.
// - The temporal resolve compute rejects or clips the history by the closest
//   fragment velocity and blends with temporalAlpha, ping-ponging between the
//   resolve textures A and B. The WebGL version swaps the render targets and
//   rebinds the history uniform; storage bindings cannot be swapped per frame,
//   so two prebuilt kernels (A reads B, B reads A) alternate instead.
// Consumers sample cascade i of the output at w = (i + 0.5) / cascadeCount
// with an explicit LOD of 0 (see shadowSampling.ts).
//
// This node is the BSM producer: it owns the CascadedShadowMaps (CPU) and the
// consumer-facing CloudShadowUniforms bag. The facade (CloudsNode) drives
// shadowMaps.update() and this node's update() explicitly each frame; this
// node is not independently FRAME-updated (see D1 in .port-plan.md).

import { Matrix4, Vector2, type Data3DTexture, type Texture } from 'three'
import { hash } from 'three/src/nodes/core/NodeUtils.js'
import {
  float,
  Fn,
  globalId,
  If,
  int,
  ivec2,
  ivec3,
  mix,
  Return,
  texture3D,
  textureStore,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import {
  TempNode,
  type ComputeNode,
  type NodeBuilder,
  type NodeFrame,
  type Renderer,
  type Storage3DTexture,
  type Texture3DNode,
  type TextureNode,
  type UniformNode
} from 'three/webgpu'
import invariant from 'tiny-invariant'

import {
  getAtmosphereContext,
  type AtmosphereContext
} from '@takram/three-atmosphere/webgpu'
import type { Node } from '@takram/three-geospatial/webgpu'

import { CascadedShadowMaps } from '../CascadedShadowMaps'
import { defaults } from '../qualityPresets'
import {
  sampleMedia,
  sampleWeather,
  type CloudSamplingOptions,
  type CloudSamplingTextures,
  type LocalWeatherChannels
} from './common'
import {
  createMarchBSM,
  getBSMRayNearFar,
  getClosestFragment,
  getSTBNShadow
} from './marchBSM'
import { toTexture3DNode, toTextureNode } from './marchClouds'
import {
  createStorage3DTexture,
  setStorage3DTextureSize,
  ShadowOutputTexture3DNode
} from './shadowTextures'
import {
  createCloudShadowUniforms,
  type CloudLayerUniforms,
  type CloudParameterUniforms,
  type CloudShadowUniforms,
  type TypedUniformArrayNode
} from './uniforms'
import { varianceClippingSlice } from './varianceClipping'

export interface CloudShadowNodeParameters {
  parameterUniforms: CloudParameterUniforms
  layerUniforms: CloudLayerUniforms
  localWeatherTexture: Texture | TextureNode
  shapeTexture: Data3DTexture | Texture3DNode
  shapeDetailTexture?: Data3DTexture | Texture3DNode | null
  turbulenceTexture?: Texture | TextureNode | null
  stbnTexture: Data3DTexture | Texture3DNode
  // Frame counter that phases the spatiotemporal blue noise. Provide to share
  // the owner's counter; a new uniform is created otherwise:
  frame?: UniformNode<number>
}

export class CloudShadowNode extends TempNode {
  static override get type(): string {
    return 'CloudShadowNode'
  }

  parameterUniforms: CloudParameterUniforms
  layerUniforms: CloudLayerUniforms
  localWeatherTexture: Texture | TextureNode
  shapeTexture: Data3DTexture | Texture3DNode
  shapeDetailTexture?: Data3DTexture | Texture3DNode | null
  turbulenceTexture?: Texture | TextureNode | null
  stbnTexture: Data3DTexture | Texture3DNode

  // Static options, equivalent to the defines of the WebGL ShadowMaterial.
  // The march and resolve kernels are recreated automatically when they
  // change:
  localWeatherChannels: LocalWeatherChannels = 'rgba'
  shapeDetail: boolean = defaults.shapeDetail
  turbulence: boolean = defaults.turbulence

  // The cascaded shadow maps (CPU). The facade updates them every frame
  // before calling update() on this node, deriving the sun direction and
  // distance itself (ported from CloudsEffect.updateSharedUniforms):
  readonly shadowMaps = new CascadedShadowMaps({
    cascadeCount: defaults.shadow.cascadeCount,
    mapSize: defaults.shadow.mapSize,
    splitLambda: 0.6
  })

  // The consumer-facing uniform bag (see shadowSampling.ts), updated every
  // frame from the cascades. Ported from CloudsPass.copyShadow() and
  // CloudsMaterial.setShadowSize():
  readonly shadowUniforms: CloudShadowUniforms = createCloudShadowUniforms()

  // Per-cascade matrices of the march, updated in update() from the cascades.
  // Ported from ShadowPass.copyShadow() and ShadowPass.copyReprojection():
  readonly inverseShadowMatrices = uniformArray(
    Array.from({ length: 4 }, () => new Matrix4()), // Populate the max number of elements
    'mat4'
  ).setName('inverseShadowMatrices') as TypedUniformArrayNode<Matrix4>
  readonly reprojectionMatrices = uniformArray(
    Array.from({ length: 4 }, () => new Matrix4()), // Populate the max number of elements
    'mat4'
  ).setName('reprojectionMatrices') as TypedUniformArrayNode<Matrix4>

  readonly resolution: UniformNode<Vector2> = uniform(new Vector2()).setName(
    'shadowResolution'
  )
  // Set this before calling update(). CloudsNode drives it with its frame
  // counter, which phases the spatiotemporal blue noise:
  readonly frame: UniformNode<number>

  // Primary raymarch
  readonly maxIterationCount: UniformNode<number> = uniform(
    defaults.shadow.maxIterationCount,
    'int'
  ).setName('maxIterationCount')
  readonly minStepSize: UniformNode<number> = uniform(
    defaults.shadow.minStepSize
  ).setName('minStepSize')
  readonly maxStepSize: UniformNode<number> = uniform(
    defaults.shadow.maxStepSize
  ).setName('maxStepSize')
  readonly minDensity: UniformNode<number> = uniform(
    defaults.shadow.minDensity
  ).setName('minDensity')
  readonly minExtinction: UniformNode<number> = uniform(
    defaults.shadow.minExtinction
  ).setName('minExtinction')
  readonly minTransmittance: UniformNode<number> = uniform(
    defaults.shadow.minTransmittance
  ).setName('minTransmittance')
  readonly opticalDepthTailScale: UniformNode<number> = uniform(2).setName(
    'opticalDepthTailScale'
  )

  // Temporal resolve, ported from the ShadowResolveMaterial uniforms:
  readonly varianceGamma: UniformNode<number> =
    uniform(1).setName('varianceGamma')
  // Use a very slow alpha because a single flickering pixel can be highly
  // noticeable in shadow maps. This value can be increased if temporal jitter
  // is turned off in the shadows rendering, but it will suffer from spatial
  // aliasing.
  readonly temporalAlpha: UniformNode<number> =
    uniform(0.01).setName('temporalAlpha')

  private readonly texelSize: UniformNode<Vector2> = uniform(
    new Vector2()
  ).setName('shadowResolveTexelSize')

  // BSM storage textures per the D2 design decision. The instances stay
  // stable for the lifetime of this node; only their sizes change:
  private readonly currentTexture = createStorage3DTexture(
    'CloudShadowNode.Shadow'
  )
  private readonly depthVelocityTexture = createStorage3DTexture(
    'CloudShadowNode.DepthVelocity'
  )
  private readonly resolveTextureA = createStorage3DTexture(
    'CloudShadowNode.Shadow.A'
  )
  private readonly resolveTextureB = createStorage3DTexture(
    'CloudShadowNode.Shadow.B'
  )

  private readonly outputTextureNode: Texture3DNode
  private readonly currentTextureNode: Texture3DNode
  private readonly depthVelocityTextureNode: Texture3DNode

  private _temporalPass = true
  private _temporalJitter = true

  private marchComputeNode?: ComputeNode
  private resolveComputeNodeA?: ComputeNode
  private resolveComputeNodeB?: ComputeNode
  private clearComputeNode?: ComputeNode
  private computeCacheKey?: number

  // Ping-pong state: the kernel writing into A reads the history from B and
  // vice versa. The equivalent of the render target swap in ShadowPass:
  private writeToA = true
  private needsClearHistory = false

  private width = 0
  private height = 0
  private depth = 0

  // Captured in setup() for use in update():
  private atmosphereContext?: AtmosphereContext

  constructor({
    parameterUniforms,
    layerUniforms,
    localWeatherTexture,
    shapeTexture,
    shapeDetailTexture,
    turbulenceTexture,
    stbnTexture,
    frame
  }: CloudShadowNodeParameters) {
    super(null)
    this.parameterUniforms = parameterUniforms
    this.layerUniforms = layerUniforms
    this.localWeatherTexture = localWeatherTexture
    this.shapeTexture = shapeTexture
    this.shapeDetailTexture = shapeDetailTexture
    this.turbulenceTexture = turbulenceTexture
    this.stbnTexture = stbnTexture
    this.frame = frame ?? uniform(0, 'int').setName('frame')

    // Equivalent to the outputBuffer of the WebGL ShadowPass; the value swaps
    // to the just-written resolve texture every frame:
    this.outputTextureNode = new ShadowOutputTexture3DNode(
      this,
      this.resolveTextureA
    )
    this.currentTextureNode = new ShadowOutputTexture3DNode(
      this,
      this.currentTexture
    )
    this.depthVelocityTextureNode = new ShadowOutputTexture3DNode(
      this,
      this.depthVelocityTexture
    )
  }

  override customCacheKey(): number {
    return hash(
      +this.temporalPass,
      +this.temporalJitter,
      +this.shapeDetail,
      +this.turbulence,
      this.cascadeCount,
      // The hash function coerces parameters to int32, thus strings must be
      // encoded manually:
      ...[...this.localWeatherChannels].map(char => 'rgba'.indexOf(char))
    )
  }

  // Equivalent to the TEMPORAL_PASS define in the WebGL version. Toggling
  // reallocates the textures and recreates the kernels, like
  // ShadowPass.initRenderTargets():
  get temporalPass(): boolean {
    return this._temporalPass
  }

  set temporalPass(value: boolean) {
    if (value !== this._temporalPass) {
      this._temporalPass = value
      this.disposeComputeNodes()
      this.writeToA = true
      this.needsClearHistory = true
      this.outputTextureNode.value = value
        ? this.resolveTextureA
        : this.currentTexture
      // Force the reallocation of the textures on the next update:
      this.width = 0
      this.height = 0
      this.depth = 0
    }
  }

  // Equivalent to the TEMPORAL_JITTER define in the WebGL version:
  get temporalJitter(): boolean {
    return this._temporalJitter
  }

  set temporalJitter(value: boolean) {
    if (value !== this._temporalJitter) {
      this._temporalJitter = value
      this.disposeComputeNodes()
    }
  }

  // Equivalent to the CASCADE_COUNT define in the WebGL version, stored on
  // the shadow maps. Note the consumers (shadowSampling.ts) unroll their
  // loops by it, so changing it also requires rebuilding the node graph:
  get cascadeCount(): number {
    return this.shadowMaps.cascadeCount
  }

  set cascadeCount(value: number) {
    this.shadowMaps.cascadeCount = value
  }

  getTextureNode(
    name: 'output' | 'current' | 'depthVelocity' = 'output'
  ): Texture3DNode {
    switch (name) {
      case 'output':
        // The resolved BSM, or the current BSM when the temporal pass is off:
        return this.outputTextureNode
      case 'current':
        return this.currentTextureNode
      case 'depthVelocity':
        return this.depthVelocityTextureNode
    }
    throw new Error(`Unknown texture name: ${name as string}`)
  }

  // Ported from ShadowPass.setSize(), ShadowMaterial.setSize(),
  // ShadowResolveMaterial.setSize() and CloudsMaterial.setShadowSize().
  // update() calls this automatically when the shadow maps change:
  setSize(width: number, height: number, depth = this.cascadeCount): this {
    this.width = width
    this.height = height
    this.depth = depth

    this.resolution.value.set(width, height)
    this.texelSize.value.set(1 / width, 1 / height)
    this.shadowUniforms.shadowTexelSize.value.set(1 / width, 1 / height)

    // Note setSize() alone doesn't bump the texture version, and the bindings
    // would keep referring to the stale GPU texture; needsUpdate makes every
    // binding recreate it at the new size (see ScreenSpaceShadowNode.setSize):
    setStorage3DTextureSize(this.currentTexture, width, height, depth)
    if (this.temporalPass) {
      setStorage3DTextureSize(this.depthVelocityTexture, width, height, depth)
      setStorage3DTextureSize(this.resolveTextureA, width, height, depth)
      setStorage3DTextureSize(this.resolveTextureB, width, height, depth)
    } else {
      // Deallocate the unused textures down to a single texel:
      setStorage3DTextureSize(this.depthVelocityTexture, 1, 1, 1)
      setStorage3DTextureSize(this.resolveTextureA, 1, 1, 1)
      setStorage3DTextureSize(this.resolveTextureB, 1, 1, 1)
    }
    this.needsClearHistory = true
    return this
  }

  // Clears the temporal history so that the resolve restarts from the current
  // frame. update() invokes this automatically on resize and toggles:
  resetHistory(): void {
    this.needsClearHistory = true
  }

  // Ported from ShadowPass.copyShadow() (the inverse matrices of the march)
  // and CloudsPass.copyShadow() (the consumer bag):
  private copyShadow(): void {
    const { shadowMaps, shadowUniforms } = this
    const inverseShadowMatrices = this.inverseShadowMatrices.array
    const shadowIntervals = shadowUniforms.shadowIntervals.array
    const shadowMatrices = shadowUniforms.shadowMatrices.array
    for (let i = 0; i < shadowMaps.cascadeCount; ++i) {
      const cascade = shadowMaps.cascades[i]
      inverseShadowMatrices[i].copy(cascade.inverseMatrix)
      shadowIntervals[i].copy(cascade.interval)
      shadowMatrices[i].copy(cascade.matrix)
    }
    shadowUniforms.shadowFar.value = shadowMaps.far
  }

  // Stores the current shadow matrices for the next reprojection. Ported from
  // ShadowPass.copyReprojection():
  private copyReprojection(): void {
    const { shadowMaps } = this
    const reprojectionMatrices = this.reprojectionMatrices.array
    for (let i = 0; i < shadowMaps.cascadeCount; ++i) {
      reprojectionMatrices[i].copy(shadowMaps.cascades[i].matrix)
    }
  }

  // Ported from ShadowPass.swapBuffers(). The kernels alternate instead of
  // the render targets; only the output pointer and the phase flip here:
  private swapBuffers(): void {
    const written = this.writeToA ? this.resolveTextureA : this.resolveTextureB
    // Resolve and history are already swapped in the WebGL version when its
    // outputBuffer is read; the just-written texture is the output:
    this.outputTextureNode.value = written
    this.writeToA = !this.writeToA
  }

  private clearHistory(
    renderer: Renderer,
    dispatchSize: readonly [number, number, number]
  ): void {
    if (this.temporalPass) {
      this.clearComputeNode ??= this.createClearComputeNode()
      void renderer.compute(this.clearComputeNode, [...dispatchSize])
    }
    this.needsClearHistory = false
  }

  private disposeComputeNodes(): void {
    this.marchComputeNode?.dispose()
    this.resolveComputeNodeA?.dispose()
    this.resolveComputeNodeB?.dispose()
    this.marchComputeNode = undefined
    this.resolveComputeNodeA = undefined
    this.resolveComputeNodeB = undefined
  }

  // Ported from the cascade() and main() functions of shadow.frag. One
  // dispatch covers [mapSize.x, mapSize.y, cascadeCount]; globalId.z is the
  // cascade index, replacing the unrolled per-attachment loop of the WebGL
  // version:
  private createMarchComputeNode(context: AtmosphereContext): ComputeNode {
    const { matrixWorldToECEF, matrixECEFToWorld, sunDirectionECEF } = context
    const bottomRadius = float(context.parameters.bottomRadius)
    const altitudeCorrection: Node<'vec3'> = context.correctAltitude
      ? context.altitudeCorrectionECEF
      : vec3(0)
    const {
      shadowTopHeight,
      shadowBottomHeight,
      minIntervalHeights,
      maxIntervalHeights
    } = this.layerUniforms

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
    // Equivalent to the SHADOW define of the WebGL version, which masks the
    // weather by the shadow layer mask:
    const samplingOptions: CloudSamplingOptions = {
      shadow: true,
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
    const stbnTextureNode = toTexture3DNode(this.stbnTexture)

    const marchBSM = createMarchBSM({
      temporalJitter: this.temporalJitter,
      bottomRadius,
      minIntervalHeights,
      maxIntervalHeights,
      uniforms: this,
      sampleWeather: sampleWeatherFn,
      sampleMedia: sampleMediaFn
    })

    const temporalPass = this.temporalPass
    const currentTexture = this.currentTexture
    const depthVelocityTexture = this.depthVelocityTexture

    return Fn(() => {
      If(
        ivec2(globalId.xy).greaterThanEqual(ivec2(this.resolution)).any(),
        () => {
          Return()
        }
      )
      const cascadeIndex = int(globalId.z).toConst()
      // TODO: Calculate from the main camera frustum perhaps?
      // [Comment and values preserved from shadow.frag.]
      const mipLevels = vec4(0, 0.5, 1, 2).toVar()
      const mipLevel = mipLevels.element(cascadeIndex).toConst()

      // The uv at the texel center, identical to the vUv varying rasterized
      // by shadow.vert:
      const uv = vec2(globalId.xy).add(0.5).div(this.resolution).toConst()
      const clip = uv.mul(2).sub(1).toConst()
      const point = this.inverseShadowMatrices
        .element(cascadeIndex)
        .mul(vec4(clip, -1, 1))
        .toVar()
      point.divAssign(point.w)
      const sunPosition = matrixWorldToECEF
        .mul(vec4(point.xyz, 1))
        .xyz.add(altitudeCorrection)
        .toConst()

      const rayDirection = sunDirectionECEF.negate().normalize().toConst()
      const nearFar = getBSMRayNearFar(
        sunPosition,
        rayDirection,
        bottomRadius,
        shadowTopHeight,
        shadowBottomHeight
      ).toConst()

      const rayOrigin = rayDirection.mul(nearFar.x).add(sunPosition).toConst()
      const stbn = getSTBNShadow(
        stbnTextureNode,
        ivec2(globalId.xy),
        this.frame
      ).toConst()
      const color = marchBSM(
        rayOrigin,
        rayDirection,
        nearFar.y.sub(nearFar.x),
        stbn,
        mipLevel
      ).toConst()
      textureStore(currentTexture, globalId, color)

      if (temporalPass) {
        // Velocity for temporal resolution:
        const frontPosition = rayDirection.mul(color.x).add(rayOrigin).toConst()
        const frontPositionWorld = matrixECEFToWorld
          .mul(vec4(frontPosition.sub(altitudeCorrection), 1))
          .xyz.toConst()
        const prevClip = this.reprojectionMatrices
          .element(cascadeIndex)
          .mul(vec4(frontPositionWorld, 1))
          .toVar()
        prevClip.divAssign(prevClip.w)
        const prevUv = prevClip.xy.mul(0.5).add(0.5).toConst()
        const velocity = uv.sub(prevUv).mul(this.resolution).toConst()
        textureStore(depthVelocityTexture, globalId, vec4(color.x, velocity, 0))
      }
    })()
      // update() supplies the full three-dimensional dispatch. computeKernel
      // deliberately has no scalar count: compute(1, ...) would permanently
      // compile an instanceIndex < 1 guard, so only the first texel could be
      // written even when renderer.compute() receives a larger dispatch.
      .computeKernel([8, 8, 1])
      .setName('CloudShadowNode.March')
  }

  // Ported from shadowResolve.frag. The kernel writing into writeTexture
  // reads the history from historyTexture; two instances alternate to
  // implement the ping-pong (see swapBuffers):
  private createResolveComputeNode(
    writeTexture: Storage3DTexture,
    historyTexture: Storage3DTexture
  ): ComputeNode {
    const cascadeCount = this.cascadeCount
    const inputNode = texture3D(this.currentTexture)
    const depthVelocityNode = texture3D(this.depthVelocityTexture)
    const historyNode = texture3D(historyTexture)

    return Fn(() => {
      If(
        ivec2(globalId.xy).greaterThanEqual(ivec2(this.resolution)).any(),
        () => {
          Return()
        }
      )
      const coord = ivec3(globalId).toConst()
      const cascadeIndex = int(globalId.z).toConst()
      const uv = vec2(globalId.xy).add(0.5).mul(this.texelSize).toConst()

      const current = inputNode.load(coord).toConst()
      const outputColor = current.toVar()

      const depthVelocity = getClosestFragment(
        depthVelocityNode,
        coord
      ).toConst()
      const velocity = depthVelocity.gb.mul(this.texelSize).toConst()
      const prevUv = uv.sub(velocity).toConst()

      // Rejection: retain the current sample when the previous uv falls
      // outside of the cascade:
      If(
        prevUv
          .greaterThanEqual(vec2(0))
          .all()
          .and(prevUv.lessThanEqual(vec2(1)).all()),
        () => {
          // Sample the history slice at its center in w with an explicit LOD
          // so that the linear filtering never bleeds across the cascades,
          // while remaining bilinear in xy:
          const w = float(cascadeIndex).add(0.5).div(cascadeCount).toConst()
          const history = (historyNode.sample(vec3(prevUv, w)) as Texture3DNode)
            .level(float(0))
            .toConst()
          const clippedHistory = varianceClippingSlice(
            inputNode,
            coord,
            current,
            history,
            this.varianceGamma
          ).toConst()
          outputColor.assign(mix(clippedHistory, current, this.temporalAlpha))
        }
      )

      textureStore(writeTexture, globalId, outputColor)
    })()
      .computeKernel([8, 8, 1])
      .setName('CloudShadowNode.Resolve')
  }

  private createClearComputeNode(): ComputeNode {
    const resolveTextureA = this.resolveTextureA
    const resolveTextureB = this.resolveTextureB
    return Fn(() => {
      If(
        ivec2(globalId.xy).greaterThanEqual(ivec2(this.resolution)).any(),
        () => {
          Return()
        }
      )
      textureStore(resolveTextureA, globalId, vec4(0))
      textureStore(resolveTextureB, globalId, vec4(0))
    })()
      .computeKernel([8, 8, 1])
      .setName('CloudShadowNode.ClearHistory')
  }

  // Renders the BSM march and resolve. This node is not updated by the frame
  // loop; CloudsNode drives it explicitly to guarantee the pass ordering,
  // after updating the shadow maps (CascadedShadowMaps.update) and the frame
  // uniform. Ported from ShadowPass.update() and the shadow map size sync of
  // CloudsEffect.update():
  override update(frame: NodeFrame): void {
    const { renderer } = frame
    const atmosphereContext = this.atmosphereContext
    if (renderer == null || atmosphereContext == null) {
      // The compute kernels depend on the atmosphere context captured at
      // setup, which runs when a consumer of the output texture builds:
      return
    }

    const { shadowMaps } = this
    const { width, height } = shadowMaps.mapSize
    const depth = shadowMaps.cascadeCount
    if (width <= 0 || height <= 0 || depth <= 0) {
      return
    }
    const computeCacheKey = this.customCacheKey()
    if (computeCacheKey !== this.computeCacheKey) {
      this.disposeComputeNodes()
      this.computeCacheKey = computeCacheKey
      this.needsClearHistory = true
    }
    if (
      width !== this.width ||
      height !== this.height ||
      depth !== this.depth
    ) {
      if (depth !== this.depth) {
        // The resolve kernel bakes the cascade count:
        this.disposeComputeNodes()
      }
      this.setSize(width, height, depth)
    }

    this.copyShadow()

    this.marchComputeNode ??= this.createMarchComputeNode(atmosphereContext)
    if (this.temporalPass) {
      this.resolveComputeNodeA ??= this.createResolveComputeNode(
        this.resolveTextureA,
        this.resolveTextureB
      )
      this.resolveComputeNodeB ??= this.createResolveComputeNode(
        this.resolveTextureB,
        this.resolveTextureA
      )
    }

    const dispatchSize: [number, number, number] = [
      Math.ceil(width / 8),
      Math.ceil(height / 8),
      depth
    ]

    if (this.needsClearHistory) {
      this.clearHistory(renderer, dispatchSize)
    }

    void renderer.compute(this.marchComputeNode, dispatchSize)

    if (this.temporalPass) {
      const resolveComputeNode = this.writeToA
        ? this.resolveComputeNodeA
        : this.resolveComputeNodeB
      invariant(resolveComputeNode != null)
      void renderer.compute(resolveComputeNode, dispatchSize)

      // Store the current shadow matrices for the next reprojection:
      this.copyReprojection()

      // Swap resolve and history for the next render:
      this.swapBuffers()
    }
  }

  override setup(builder: NodeBuilder): unknown {
    this.atmosphereContext = getAtmosphereContext(builder)
    // The kernels bake the static options and the sampling texture nodes.
    // Recreate them when the node graph rebuilds so that changed static
    // options take effect (see D7 in .port-plan.md):
    this.disposeComputeNodes()
    this.computeCacheKey = undefined
    return super.setup(builder)
  }

  override dispose(): void {
    this.disposeComputeNodes()
    this.clearComputeNode?.dispose()
    this.clearComputeNode = undefined
    this.currentTexture.dispose()
    this.depthVelocityTexture.dispose()
    this.resolveTextureA.dispose()
    this.resolveTextureB.dispose()
    super.dispose()
  }
}

export const cloudShadow = (
  ...args: ConstructorParameters<typeof CloudShadowNode>
): CloudShadowNode => new CloudShadowNode(...args)
