// Ported from:
// three-geospatial/packages/clouds/src/CloudsResolveMaterial.ts and
// three-geospatial/packages/clouds/src/shaders/cloudsResolve.vert +
// cloudsResolve.frag

import {
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  RenderTarget,
  RGBAFormat,
  Vector2
} from 'three'
import { hash } from 'three/src/nodes/core/NodeUtils.js'
import {
  float,
  Fn,
  If,
  int,
  ivec2,
  mix,
  mrt,
  screenCoordinate,
  screenUV,
  struct,
  texture,
  textureSize,
  uniform,
  vec2,
  vec4
} from 'three/tsl'
import {
  NodeMaterial,
  QuadMesh,
  RendererUtils,
  TempNode,
  type MRTNode,
  type NodeBuilder,
  type NodeFrame,
  type Renderer,
  type TextureNode,
  type UniformNode
} from 'three/webgpu'

import { turbo, type Node } from '@takram/three-geospatial/webgpu'

import { bayerIndex } from './bayer'
import {
  cloudOutputTexture,
  type CloudOutputTextureNode
} from './outputTextures'
import { varianceClipping, varianceClippingUv } from './varianceClipping'

const { resetRendererState, restoreRendererState } = RendererUtils

const neighborOffsets: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 0],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
]

export type CloudsResolveDebugShow = 'none' | 'velocity' | 'shadowLength'

const debugShowValues: readonly CloudsResolveDebugShow[] = [
  'none',
  'velocity',
  'shadowLength'
]

const resolvedCloudsStruct = /*#__PURE__*/ struct(
  {
    output: 'vec4',
    shadowLength: 'float'
  },
  'ResolvedClouds'
)

export interface CloudsResolveNodeParameters {
  colorNode: TextureNode
  depthVelocityNode: TextureNode
  shadowLengthNode: TextureNode
  frame?: UniformNode<number>
}

export class CloudsResolveNode extends TempNode {
  static override get type(): string {
    return 'CloudsResolveNode'
  }

  colorNode: TextureNode
  depthVelocityNode: TextureNode
  shadowLengthNode: TextureNode

  temporalUpscale = true
  lightShafts = true
  debugShow: CloudsResolveDebugShow = 'none'

  readonly frame: UniformNode<number>
  readonly texelSize: UniformNode<Vector2> = uniform(new Vector2()).setName(
    'cloudsResolveTexelSize'
  )
  readonly varianceGamma: UniformNode<number> =
    uniform(2).setName('varianceGamma')
  readonly temporalAlpha: UniformNode<number> =
    uniform(0.1).setName('temporalAlpha')

  private resolveRT = CloudsResolveNode.createRenderTarget()
  private historyRT = CloudsResolveNode.createRenderTarget()
  private readonly material = new NodeMaterial()
  private readonly mesh = new QuadMesh(this.material)
  private rendererState?: RendererUtils.RendererState
  private needsClearHistory = true

  private readonly textureNodes: {
    output: CloudOutputTextureNode
    shadowLength: CloudOutputTextureNode
  }
  private readonly historyColorNode: TextureNode
  private readonly historyShadowLengthNode: TextureNode

  constructor({
    colorNode,
    depthVelocityNode,
    shadowLengthNode,
    frame
  }: CloudsResolveNodeParameters) {
    super(null)
    this.colorNode = colorNode
    this.depthVelocityNode = depthVelocityNode
    this.shadowLengthNode = shadowLengthNode
    this.frame = frame ?? uniform(0, 'int').setName('frame')

    this.material.name = 'CloudsResolveNode.Material'
    this.textureNodes = {
      output: cloudOutputTexture(this, this.resolveRT.textures[0]),
      shadowLength: cloudOutputTexture(this, this.resolveRT.textures[1])
    }
    this.historyColorNode = texture(this.historyRT.textures[0])
    this.historyShadowLengthNode = texture(this.historyRT.textures[1])
  }

  override customCacheKey(): number {
    return hash(
      +this.temporalUpscale,
      +this.lightShafts,
      debugShowValues.indexOf(this.debugShow)
    )
  }

  private static createRenderTarget(): RenderTarget {
    const renderTarget = new RenderTarget(1, 1, {
      count: 2,
      depthBuffer: false,
      type: HalfFloatType,
      format: RGBAFormat
    })
    const [color, shadowLength] = renderTarget.textures
    for (const texture of renderTarget.textures) {
      // These resolve targets are only consumed with 1:1 texelFetch-style
      // textureLoad reads in the composite path. Nearest keeps them
      // unfilterable at first build so WebGPU does not allocate sampler slots.
      texture.minFilter = NearestFilter
      texture.magFilter = NearestFilter
      texture.generateMipmaps = false
    }
    color.minFilter = LinearFilter
    color.magFilter = LinearFilter
    color.name = 'output'
    shadowLength.name = 'shadowLength'
    shadowLength.format = RedFormat
    return renderTarget
  }

  getTextureNode(
    name: 'output' | 'shadowLength' = 'output'
  ): CloudOutputTextureNode {
    return this.textureNodes[name]
  }

  setSize(width: number, height: number): this {
    if (width !== this.resolveRT.width || height !== this.resolveRT.height) {
      this.resolveRT.setSize(width, height)
      this.historyRT.setSize(width, height)
      this.texelSize.value.set(1 / width, 1 / height)
      this.needsClearHistory = true
    }
    return this
  }

  resetHistory(): void {
    this.needsClearHistory = true
  }

  private clearHistory(renderer: Renderer): void {
    renderer.setRenderTarget(this.resolveRT)
    renderer.clear()
    renderer.setRenderTarget(this.historyRT)
    renderer.clear()
    this.needsClearHistory = false
  }

  private swapBuffers(): void {
    const { resolveRT, historyRT } = this
    this.resolveRT = historyRT
    this.historyRT = resolveRT

    // Keep the sampled history pointing at the just-written resolve target
    // for the next frame.
    this.historyColorNode.value = this.historyRT.textures[0]
    this.historyShadowLengthNode.value = this.historyRT.textures[1]

    // Output is the just-written target.
    this.textureNodes.output.value = this.historyRT.textures[0]
    this.textureNodes.shadowLength.value = this.historyRT.textures[1]
  }

  override update(frame: NodeFrame): void {
    const { renderer } = frame
    if (renderer == null) {
      return
    }

    this.rendererState = resetRendererState(renderer, this.rendererState)
    if (this.needsClearHistory) {
      this.clearHistory(renderer)
    }

    renderer.setRenderTarget(this.resolveRT)
    this.mesh.render(renderer)

    restoreRendererState(renderer, this.rendererState)
    this.swapBuffers()
  }

  private setupResolveNode(): MRTNode {
    const getClosestFragment = (coord: Node<'ivec2'>): Node<'vec4'> => {
      const result = vec4(1e7, 0, 0, 0).toVar()
      for (const [x, y] of neighborOffsets) {
        const neighbor = this.depthVelocityNode
          .load(coord.add(ivec2(x, y)))
          .toConst()
        If(neighbor.r.lessThan(result.r), () => {
          result.assign(neighbor)
        })
      }
      return result
    }

    const resolved = Fn(() => {
      const coord = ivec2(screenCoordinate.xy).toConst()
      const currentColor = vec4(0).toVar()
      const outputColor = vec4(0).toVar()
      const currentShadowLength = vec4(0, 0, 0, 1).toVar()
      const outputShadowLength = float(0).toVar()

      if (this.temporalUpscale) {
        const lowResCoord = ivec2(coord.div(4)).toConst()
        currentColor.assign(this.colorNode.load(lowResCoord))
        currentShadowLength.assign(
          vec4(this.shadowLengthNode.load(lowResCoord).r, 0, 0, 1)
        )

        const currentFrame = bayerIndex(coord).equal(int(this.frame).mod(16))
        If(currentFrame, () => {
          outputColor.assign(currentColor)
          outputShadowLength.assign(currentShadowLength.r)
        }).Else(() => {
          const depthVelocity = getClosestFragment(lowResCoord).toConst()
          const velocity = depthVelocity.gb.toConst()
          const prevUv = screenUV.sub(velocity).toConst()
          If(
            prevUv
              .greaterThanEqual(vec2(0))
              .all()
              .and(prevUv.lessThanEqual(vec2(1)).all()),
            () => {
              const historyColor = this.historyColorNode
                .sample(prevUv)
                .toConst()
              const sourceTexelSize = float(1)
                .div(vec2(textureSize(this.colorNode)))
                .toConst()
              outputColor.assign(
                varianceClippingUv(
                  this.colorNode,
                  screenUV,
                  sourceTexelSize,
                  currentColor,
                  historyColor,
                  this.varianceGamma
                )
              )

              if (this.lightShafts) {
                const historyShadowLength = vec4(
                  this.historyShadowLengthNode.sample(prevUv).r,
                  0,
                  0,
                  1
                ).toConst()
                outputShadowLength.assign(
                  varianceClippingUv(
                    this.shadowLengthNode,
                    screenUV,
                    sourceTexelSize,
                    currentShadowLength,
                    historyShadowLength,
                    this.varianceGamma
                  ).r
                )
              }
            }
          ).Else(() => {
            outputColor.assign(currentColor)
            outputShadowLength.assign(currentShadowLength.r)
          })
        })
      } else {
        currentColor.assign(this.colorNode.load(coord))
        currentShadowLength.assign(
          vec4(this.shadowLengthNode.load(coord).r, 0, 0, 1)
        )

        const depthVelocity = getClosestFragment(coord).toConst()
        const velocity = depthVelocity.gb.toConst()
        const prevUv = screenUV.sub(velocity).toConst()
        If(
          prevUv
            .greaterThanEqual(vec2(0))
            .all()
            .and(prevUv.lessThanEqual(vec2(1)).all()),
          () => {
            const historyColor = this.historyColorNode.sample(prevUv).toConst()
            const clippedColor = varianceClipping(
              this.colorNode,
              coord,
              currentColor,
              historyColor
            ).toConst()
            outputColor.assign(
              mix(clippedColor, currentColor, this.temporalAlpha)
            )

            if (this.lightShafts) {
              const historyShadowLength = vec4(
                this.historyShadowLengthNode.sample(prevUv).r,
                0,
                0,
                1
              ).toConst()
              const clippedShadowLength = varianceClipping(
                this.shadowLengthNode,
                coord,
                currentShadowLength,
                historyShadowLength
              ).toConst()
              outputShadowLength.assign(
                mix(
                  clippedShadowLength.r,
                  currentShadowLength.r,
                  this.temporalAlpha
                )
              )
            }
          }
        ).Else(() => {
          outputColor.assign(currentColor)
          outputShadowLength.assign(currentShadowLength.r)
        })
      }

      let debugColor: Node<'vec4'> = outputColor
      if (this.debugShow === 'shadowLength') {
        debugColor = vec4(turbo(outputShadowLength.mul(0.05)), 1)
      } else if (this.debugShow === 'velocity') {
        const velocity = this.depthVelocityNode
          .sample(screenUV)
          .gb.abs()
          .mul(10)
        debugColor = vec4(
          outputColor.rgb.add(vec4(velocity, 0, 0).rgb),
          outputColor.a
        )
      }

      return resolvedCloudsStruct(debugColor, outputShadowLength)
    })().toConst()

    return mrt({
      output: resolved.get('output'),
      shadowLength: vec4(
        this.lightShafts ? resolved.get('shadowLength') : float(0),
        0,
        0,
        1
      )
    })
  }

  override setup(builder: NodeBuilder): unknown {
    this.material.mrtNode = this.setupResolveNode()
    this.material.needsUpdate = true
    return super.setup(builder)
  }

  override dispose(): void {
    this.resolveRT.dispose()
    this.historyRT.dispose()
    this.material.dispose()
    this.mesh.geometry.dispose()
    super.dispose()
  }
}

export const cloudsResolve = (
  ...args: ConstructorParameters<typeof CloudsResolveNode>
): CloudsResolveNode => new CloudsResolveNode(...args)
