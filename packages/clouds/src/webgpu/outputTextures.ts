import type { Texture } from 'three'

import { reinterpretType } from '@takram/three-geospatial'
import { OutputTextureNode } from '@takram/three-geospatial/webgpu'

// OutputTextureNode.clone() in three r183 drops sampling state that is added
// by chained calls such as sample(uv).level(0). The clouds resolve pass needs
// those chains on produced 2D render targets, so keep the extra fields across
// clones while still letting the owner update the node value for ping-pong.
export class CloudOutputTextureNode extends OutputTextureNode {
  static override get type(): string {
    return 'CloudOutputTextureNode'
  }

  override clone(): this {
    const clone = new (this.constructor as new (
      ...args: ConstructorParameters<typeof CloudOutputTextureNode>
    ) => this)(this.owner, this.value)
    clone.uvNode = this.uvNode
    clone.levelNode = this.levelNode
    clone.biasNode = this.biasNode
    clone.sampler = this.sampler
    clone.depthNode = this.depthNode
    clone.compareNode = this.compareNode
    clone.gradNode = this.gradNode
    reinterpretType<typeof this & { offsetNode: unknown }>(this)
    reinterpretType<{ offsetNode: unknown }>(clone)
    clone.offsetNode = this.offsetNode
    return clone as this
  }
}

export const cloudOutputTexture = (
  owner: ConstructorParameters<typeof CloudOutputTextureNode>[0],
  texture: Texture
): CloudOutputTextureNode => new CloudOutputTextureNode(owner, texture)
