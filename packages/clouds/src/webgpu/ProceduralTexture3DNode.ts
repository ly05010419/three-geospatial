import {
  LinearFilter,
  NoColorSpace,
  RepeatWrapping,
  UnsignedByteType,
  Vector3
} from 'three'
import {
  Fn,
  If,
  instanceIndex,
  Return,
  textureStore,
  uvec3,
  vec3
} from 'three/tsl'
import {
  Storage3DTexture,
  TempNode,
  type ComputeNode,
  type NodeBuilder,
  type TextureNode
} from 'three/webgpu'

import { outputTexture3D, type Node } from '@takram/three-geospatial/webgpu'

export abstract class ProceduralTexture3DNode extends TempNode {
  static override get type(): string {
    return 'ProceduralTexture3DNode'
  }

  readonly texture = this.createStorage3DTexture()

  private readonly textureNode: TextureNode
  private computeNode?: ComputeNode
  private builder?: NodeBuilder

  constructor(size = new Vector3(1)) {
    super(null)
    this.textureNode = outputTexture3D(this, this.texture)
    this.setSize(size.x, size.y, size.z)
  }

  protected createStorage3DTexture(name?: string): Storage3DTexture {
    const texture = new Storage3DTexture(1, 1, 1)
    texture.type = UnsignedByteType
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.wrapR = RepeatWrapping
    texture.colorSpace = NoColorSpace
    texture.generateMipmaps = false

    const typeName = (this.constructor as typeof Node).type
    texture.name = name != null ? `${typeName}.${name}` : typeName

    return texture
  }

  getTextureNode(): TextureNode {
    return this.textureNode
  }

  setSize(width: number, height: number, depth: number): this {
    if (
      width !== this.texture.width ||
      height !== this.texture.height ||
      depth !== this.texture.depth
    ) {
      this.texture.setSize(width, height, depth)
      this.texture.needsUpdate = true
      if (this.builder != null) {
        this.generateTexture(this.builder)
      }
    }
    return this
  }

  protected abstract setupOutputNode(
    uvw: Node<'vec3'>,
    builder: NodeBuilder
  ): Node

  private generateTexture(builder: NodeBuilder): void {
    const { width, height, depth } = this.texture

    this.computeNode?.dispose()
    this.computeNode = Fn(() => {
      const id = instanceIndex
      const x = id.mod(width)
      const y = id.div(width).mod(height)
      const z = id.div(width * height)
      const size = uvec3(width, height, depth)
      If(uvec3(x, y, z).greaterThanEqual(size).any(), () => {
        Return()
      })
      const textureCoordinate = vec3(x, y, z)
      const uvw = textureCoordinate.add(0.5).div(vec3(width, height, depth))

      textureStore(
        this.texture,
        textureCoordinate,
        this.setupOutputNode(uvw, builder)
      )
    })().compute(width * height * depth, [4, 4, 4])

    void builder.renderer.compute(this.computeNode)
  }

  override setup(builder: NodeBuilder): unknown {
    this.builder = builder
    this.generateTexture(builder)

    return super.setup(builder)
  }

  override dispose(): void {
    this.computeNode?.dispose()
    this.computeNode = undefined
    this.builder = undefined
    this.texture.dispose()
    super.dispose()
  }
}
