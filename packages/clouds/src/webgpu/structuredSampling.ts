// Implements Structured Volume Sampling in fragment shader:
// https://github.com/huwb/volsample
// Implementation reference:
// https://www.shadertoy.com/view/ttVfDc

// Ported from structuredSampling.glsl:
// https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/src/shaders/structuredSampling.glsl

import { dot, exp, If, struct, vec3, vec4 } from 'three/tsl'

import { FnLayout, FnVar, type Node } from '@takram/three-geospatial/webgpu'

// GLSL's mod() is floored while WGSL's % operator is truncated. This
// reproduces the GLSL behavior (mod(x, y) = x - y * floor(x / y)) and must be
// used wherever the GLSL source applies mod() to possibly-negative operands.
const modFloor = /*#__PURE__*/ FnLayout({
  name: 'modFloor',
  type: 'float',
  inputs: [
    { name: 'x', type: 'float' },
    { name: 'y', type: 'float' }
  ]
})(([x, y]) => {
  return x.sub(y.mul(x.div(y).floor()))
})

export const icosahedralVerticesStruct = /*#__PURE__*/ struct(
  {
    v1: 'vec3',
    v2: 'vec3',
    v3: 'vec3'
  },
  'IcosahedralVertices'
)

export const getIcosahedralVertices = /*#__PURE__*/ FnVar(
  (direction: Node<'vec3'>) => {
    // Normalization scalers to fit dodecahedron to unit sphere.
    const a = 0.85065080835204 // phi / sqrt(2 + phi)
    const b = 0.5257311121191336 // 1 / sqrt(2 + phi)

    // Derive the vertices of icosahedron where triangle intersects the
    // direction.
    // See: https://www.ppsloan.org/publications/AmbientDice.pdf
    const kT = 0.6180339887498948 // 1 / phi
    const kT2 = 0.38196601125010515 // 1 / phi^2
    const absD = direction.abs().toConst()
    const selector1 = dot(absD, vec3(1, kT2, -kT))
    const selector2 = dot(absD, vec3(-kT, 1, kT2))
    const selector3 = dot(absD, vec3(kT2, -kT, 1))
    const v1 = selector1
      .greaterThan(0)
      .select(vec3(a, b, 0), vec3(-b, 0, a))
      .toVar()
    const v2 = selector2
      .greaterThan(0)
      .select(vec3(0, a, b), vec3(a, -b, 0))
      .toVar()
    const v3 = selector3
      .greaterThan(0)
      .select(vec3(b, 0, a), vec3(0, a, -b))
      .toVar()
    const octantSign = direction.sign().toConst()
    v1.mulAssign(octantSign)
    v2.mulAssign(octantSign)
    v3.mulAssign(octantSign)
    return icosahedralVerticesStruct(v1, v2, v3)
  }
)

// Unlike the GLSL source, this swaps the arguments in place instead of using
// inout parameters. Both "a" and "b" must be variables created via toVar().
export function swapIfBigger(a: Node<'vec4'>, b: Node<'vec4'>): void {
  If(a.w.greaterThan(b.w), () => {
    const t = vec4(a).toConst()
    a.assign(b)
    b.assign(t)
  })
}

export const sortedVerticesStruct = /*#__PURE__*/ struct(
  {
    a: 'vec3',
    b: 'vec3',
    c: 'vec3'
  },
  'SortedVertices'
)

export const sortVertices = /*#__PURE__*/ FnVar(
  (a: Node<'vec3'>, b: Node<'vec3'>, c: Node<'vec3'>) => {
    const base = vec3(0.5, 0.5, 1).toConst()
    const aw = vec4(a, dot(a, base)).toVar()
    const bw = vec4(b, dot(b, base)).toVar()
    const cw = vec4(c, dot(c, base)).toVar()
    swapIfBigger(aw, bw)
    swapIfBigger(bw, cw)
    swapIfBigger(aw, bw)
    return sortedVerticesStruct(aw.xyz, bw.xyz, cw.xyz)
  }
)

export const getPentagonalWeights = /*#__PURE__*/ FnLayout({
  name: 'getPentagonalWeights',
  type: 'vec3',
  inputs: [
    { name: 'direction', type: 'vec3' },
    { name: 'v1', type: 'vec3' },
    { name: 'v2', type: 'vec3' },
    { name: 'v3', type: 'vec3' }
  ]
})(([direction, v1, v2, v3]) => {
  const d1 = dot(v1, direction)
  const d2 = dot(v2, direction)
  const d3 = dot(v3, direction)
  const w = exp(vec3(d1, d2, d3).mul(40)).toConst()
  return w.div(w.x.add(w.y).add(w.z))
})

// The GLSL source defines two overloads of getStructureNormal, one of which
// also outputs the vertices and weights. Only the overload without the output
// parameters is consumed, so the other one is collapsed into this.
export const getStructureNormal = /*#__PURE__*/ FnVar(
  (direction: Node<'vec3'>, jitter: Node<'float'>): Node<'vec3'> => {
    const vertices = getIcosahedralVertices(direction)
    const sorted = sortVertices(
      vertices.get('v1'),
      vertices.get('v2'),
      vertices.get('v3')
    )
    const a = sorted.get('a')
    const b = sorted.get('b')
    const c = sorted.get('c')
    const weights = getPentagonalWeights(direction, a, b, c).toConst()
    return jitter
      .lessThan(weights.x)
      .select(a, jitter.lessThan(weights.x.add(weights.y)).select(b, c))
  }
)

export const structuredPlanesStruct = /*#__PURE__*/ struct(
  {
    stepOffset: 'float',
    stepSize: 'float'
  },
  'StructuredPlanes'
)

// Reference: https://github.com/huwb/volsample/blob/master/src/unity/Assets/Shaders/RayMarchCore.cginc
export const intersectStructuredPlanes = /*#__PURE__*/ FnVar(
  (
    normal: Node<'vec3'>,
    rayOrigin: Node<'vec3'>,
    rayDirection: Node<'vec3'>,
    samplePeriod: Node<'float'>
  ) => {
    const NoD = dot(rayDirection, normal).toConst()
    const stepSize = samplePeriod.div(NoD.abs()).toConst()

    // Skips leftover bit to get from rayOrigin to first strata plane.
    // Note the GLSL source uses mod() here, whose floored behavior on the
    // possibly-negative dot product must be preserved (see modFloor).
    const stepOffset = modFloor(dot(rayOrigin, normal), samplePeriod)
      .negate()
      .div(NoD)
      .toVar()

    // mod() gives different results depending on if the arg is negative or
    // positive. This line makes it consistent, and ensures the first sample is
    // in front of the viewer.
    If(stepOffset.lessThan(0), () => {
      stepOffset.addAssign(stepSize)
    })

    return structuredPlanesStruct(stepOffset, stepSize)
  }
)
