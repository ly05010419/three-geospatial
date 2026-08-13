// Storage texture plumbing of the BSM (beer shadow map) producer. See
// CloudShadowNode for the passes that write these textures.

import { HalfFloatType, LinearFilter, NoColorSpace } from 'three'
import { Storage3DTexture } from 'three/webgpu'

import { reinterpretType } from '@takram/three-geospatial'
import { OutputTexture3DNode } from '@takram/three-geospatial/webgpu'

// The BSM consumers sample the output through chains like
// sample(uvw).level(0) (see shadowSampling.ts), where every step clones the
// texture node. OutputTexture3DNode.clone() in the core package reconstructs
// from the owner and value only, silently dropping the uv/level/bias nodes
// assigned by the previous step of the chain, which collapses the sampling to
// the default coordinates. This subclass carries them over. The clones keep
// referring to the base node's value, so the ping-pong swap of the output
// texture still propagates:
export class ShadowOutputTexture3DNode extends OutputTexture3DNode {
  static override get type(): string {
    return 'ShadowOutputTexture3DNode'
  }

  override clone(): this {
    const clone = new (this.constructor as new (
      ...args: ConstructorParameters<typeof ShadowOutputTexture3DNode>
    ) => this)(this.owner, this.value)
    clone.uvNode = this.uvNode
    clone.levelNode = this.levelNode
    clone.biasNode = this.biasNode
    clone.sampler = this.sampler
    clone.depthNode = this.depthNode
    clone.compareNode = this.compareNode
    clone.gradNode = this.gradNode
    // WORKAROUND: Missing property in the type declarations as of r183:
    reinterpretType<typeof this & { offsetNode: unknown }>(this)
    reinterpretType<{ offsetNode: unknown }>(clone)
    clone.offsetNode = this.offsetNode
    return clone as this
  }
}

// Note setSize() alone doesn't bump the texture version, and the bindings
// would keep referring to the stale GPU texture; needsUpdate makes every
// binding recreate it at the new size (see ScreenSpaceShadowNode.setSize):
export function setStorage3DTextureSize(
  texture: Storage3DTexture,
  width: number,
  height: number,
  depth: number
): void {
  const image: unknown = texture.image
  reinterpretType<{ width: number; height: number; depth: number }>(image)
  if (
    width !== image.width ||
    height !== image.height ||
    depth !== image.depth
  ) {
    texture.setSize(width, height, depth)
    texture.needsUpdate = true
  }
}

export function createStorage3DTexture(name: string): Storage3DTexture {
  const texture = new Storage3DTexture(1, 1, 1)
  texture.type = HalfFloatType
  // The same sampler state as the WebGL array render targets: linear
  // filtering for the bilinear xy taps of the PCF, and the default
  // clamp-to-edge wrapping:
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.colorSpace = NoColorSpace
  texture.generateMipmaps = false
  texture.name = name
  return texture
}
