// Ported from:
// three-geospatial/packages/clouds/src/shaders/varianceClipping.glsl
//
// The GLSL source provides overloads over sampler2D/sampler2DArray selected by
// the VARIANCE_SAMPLER_ARRAY define, and a 4 or 9 sample neighborhood selected
// by the VARIANCE_9_SAMPLES define. WGSL has no overloading, so the variants
// become separate exports here:
// - varianceClipping: 2D, texel coordinates, 4-neighborhood. Used by the
//   temporal antialiasing path of the clouds resolve.
// - varianceClippingUv: 2D, bilinear uv coordinates, 4-neighborhood. Used by
//   the temporal upscaling path of the clouds resolve.
// - varianceClippingSlice: 3D slice, texel coordinates, 9-sample neighborhood
//   in xy within the same slice. Used by the BSM temporal resolve, replacing
//   the sampler2DArray variant of the WebGL version (see the D2 design
//   decision in .port-plan.md).
// The gamma parameter is optional and defaults to 1, equivalently to the
// gamma-less overloads of the GLSL source.

import {
  clamp,
  float,
  ivec2,
  ivec3,
  max,
  mix,
  sqrt,
  textureSize,
  vec2,
  vec4
} from 'three/tsl'
import type { Texture3DNode, TextureNode } from 'three/webgpu'

import { FnLayout, FnVar, type Node } from '@takram/three-geospatial/webgpu'

// Offsets of the 4-neighborhood (5 samples including the center), used by the
// 2D variants, ported digit-for-digit from the GLSL source:
const offsets4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0]
]

// Offsets of the 8-neighborhood (9 samples including the center), used by the
// slice variant (VARIANCE_9_SAMPLES in the GLSL source):
const offsets8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0]
]

export const sampleRedBilinear = /*#__PURE__*/ FnVar(
  (textureNode: TextureNode, uv: Node<'vec2'>): Node<'float'> => {
    const size = vec2(textureSize(textureNode)).toConst()
    const maxCoord = ivec2(textureSize(textureNode)).sub(ivec2(1)).toConst()
    const position = uv.mul(size).sub(0.5).toConst()
    const base = position.floor().toConst()
    const fraction = position.sub(base).toConst()
    const coord00 = ivec2(base).clamp(ivec2(0), maxCoord).toConst()
    const coord10 = ivec2(base.add(vec2(1, 0)))
      .clamp(ivec2(0), maxCoord)
      .toConst()
    const coord01 = ivec2(base.add(vec2(0, 1)))
      .clamp(ivec2(0), maxCoord)
      .toConst()
    const coord11 = ivec2(base.add(vec2(1, 1)))
      .clamp(ivec2(0), maxCoord)
      .toConst()
    const x0 = mix(
      textureNode.load(coord00).r,
      textureNode.load(coord10).r,
      fraction.x
    ).toConst()
    const x1 = mix(
      textureNode.load(coord01).r,
      textureNode.load(coord11).r,
      fraction.x
    ).toConst()
    return mix(x0, x1, fraction.y)
  }
)

// Reference: https://github.com/playdeadgames/temporal
// Note the alpha channel of the clipped result comes from the current sample:
export const clipAABB = /*#__PURE__*/ FnLayout({
  name: 'clipAABB',
  type: 'vec4',
  inputs: [
    { name: 'current', type: 'vec4' },
    { name: 'history', type: 'vec4' },
    { name: 'minColor', type: 'vec4' },
    { name: 'maxColor', type: 'vec4' }
  ]
})(([current, history, minColor, maxColor]) => {
  const pClip = maxColor.rgb.add(minColor.rgb).mul(0.5).toConst()
  const eClip = maxColor.rgb.sub(minColor.rgb).mul(0.5).add(1e-7).toConst()
  const vClip = history.sub(vec4(pClip, current.a)).toConst()
  const vUnit = vClip.xyz.div(eClip).toConst()
  const aUnit = vUnit.abs().toConst()
  const maUnit = max(aUnit.x, max(aUnit.y, aUnit.z)).toConst()
  return maUnit
    .greaterThan(1)
    .select(vec4(pClip, current.a).add(vClip.div(maUnit)), history)
})

// Shared moment accumulation and clipping over an arbitrary neighborhood.
// The neighborhood loops are unrolled on the JS side, equivalently to the
// unrollLoops() preprocessing of the WebGL version.
const clipByMoments = (
  current: Node<'vec4'>,
  neighbors: ReadonlyArray<Node<'vec4'>>,
  history: Node<'vec4'>,
  gamma: Node<'float'> | undefined
): Node<'vec4'> => {
  const moment1 = current.toVar()
  const moment2 = current.mul(current).toVar()
  for (const neighbor of neighbors) {
    moment1.addAssign(neighbor)
    moment2.addAssign(neighbor.mul(neighbor))
  }

  const N = neighbors.length + 1
  const mean = moment1.div(N).toConst()
  const variance = sqrt(max(moment2.div(N).sub(mean.mul(mean)), 0))
    .mul(gamma ?? 1)
    .toConst()
  const minColor = mean.sub(variance).toConst()
  const maxColor = mean.add(variance).toConst()
  return clipAABB(clamp(mean, minColor, maxColor), history, minColor, maxColor)
}

// Variance clipping
// Reference: https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf

// The sampler2D + texel coordinate variant of the GLSL source
// (texelFetchOffset), with the 4-neighborhood:
export const varianceClipping = /*#__PURE__*/ FnVar(
  (
    inputNode: TextureNode,
    coord: Node<'ivec2'>,
    current: Node<'vec4'>,
    history: Node<'vec4'>,
    gamma?: Node<'float'>
  ): Node<'vec4'> => {
    const neighbors = offsets4.map(([x, y]) =>
      inputNode.load(coord.add(ivec2(x, y))).toConst()
    )
    return clipByMoments(current, neighbors, history, gamma)
  }
)

// The sampler2D + bilinear uv coordinate variant of the GLSL source
// (textureOffset), with the 4-neighborhood. The texel size of the input
// buffer converts the texel offsets into uv space:
export const varianceClippingUv = /*#__PURE__*/ FnVar(
  (
    inputNode: TextureNode,
    uv: Node<'vec2'>,
    texelSize: Node<'vec2'>,
    current: Node<'vec4'>,
    history: Node<'vec4'>,
    gamma?: Node<'float'>
  ): Node<'vec4'> => {
    const neighbors = offsets4.map(([x, y]) =>
      (inputNode.sample(vec2(x, y).mul(texelSize).add(uv)) as TextureNode)
        .level(float(0))
        .toConst()
    )
    return clipByMoments(current, neighbors, history, gamma)
  }
)

// The RedFormat + half-float shadow-length targets are sampled manually so the
// temporal resolve gets WebGL-equivalent bilinear filtering without requiring
// a filtering sampler for formats WebGPU may treat as unfilterable.
export const varianceClippingRedUv = /*#__PURE__*/ FnVar(
  (
    inputNode: TextureNode,
    uv: Node<'vec2'>,
    texelSize: Node<'vec2'>,
    current: Node<'vec4'>,
    history: Node<'vec4'>,
    gamma?: Node<'float'>
  ): Node<'vec4'> => {
    const neighbors = offsets4.map(([x, y]) =>
      vec4(
        sampleRedBilinear(inputNode, vec2(x, y).mul(texelSize).add(uv)),
        0,
        0,
        1
      ).toConst()
    )
    return clipByMoments(current, neighbors, history, gamma)
  }
)

// The sampler2DArray variant of the GLSL source with VARIANCE_9_SAMPLES,
// operating on a slice of a 3D texture. The offsets apply in xy only and
// never cross the slices:
export const varianceClippingSlice = /*#__PURE__*/ FnVar(
  (
    inputNode: Texture3DNode,
    coord: Node<'ivec3'>,
    current: Node<'vec4'>,
    history: Node<'vec4'>,
    gamma?: Node<'float'>
  ): Node<'vec4'> => {
    const neighbors = offsets8.map(([x, y]) =>
      inputNode.load(coord.add(ivec3(x, y, 0))).toConst()
    )
    return clipByMoments(current, neighbors, history, gamma)
  }
)
