// Ported from the ray-spheres intersection portion of:
// three-geospatial/packages/clouds/src/shaders/clouds.frag
// (rayIntersectsGround, getIntersections, getRayNearFar, getHazeRayNearFar)
// and the vec4-radii overloads of:
// three-geospatial/packages/core/src/shaders/raySphereIntersection.glsl
// getShadowRayNearFar arrives with the shadow length support at M4.

import {
  dot,
  If,
  length,
  max,
  min,
  mix,
  sqrt,
  step,
  vec2,
  vec4
} from 'three/tsl'

import { FnLayout, type Node } from '@takram/three-geospatial/webgpu'

// The WGSL function name must not be "rayIntersectsGround": the atmosphere
// runtime already emits a function of that name into the same shader module
// (in GLSL the Bruneton counterpart is "RayIntersectsGround", so the WebGL
// shaders never collided).
export const rayIntersectsGround = /*#__PURE__*/ FnLayout({
  name: 'cloudsRayIntersectsGround',
  type: 'bool',
  inputs: [
    { name: 'cameraPosition', type: 'vec3' },
    { name: 'rayDirection', type: 'vec3' },
    { name: 'bottomRadius', type: 'float' }
  ]
})(([cameraPosition, rayDirection, bottomRadius]) => {
  const r = length(cameraPosition).toConst()
  const mu = dot(cameraPosition, rayDirection).div(r).toConst()
  return mu
    .lessThan(0)
    .and(
      r
        .mul(r)
        .mul(mu.mul(mu).sub(1))
        .add(bottomRadius.mul(bottomRadius))
        .greaterThanEqual(0)
    )
})

export interface RaySpheresIntersections {
  first: Node<'vec4'>
  second: Node<'vec4'>
}

// Note that this cannot use raySpheresIntersections in the core WebGPU library
// because it guards the whole result by the vec4 discriminant in a single If,
// which does not evaluate per lane. The clouds ray usually misses the
// innermost (ground) sphere while hitting the cloud layer spheres, so the
// per-lane masked version of the WebGL core raySphereIntersection.glsl is
// ported verbatim here instead.
export const raySpheresIntersections = (
  rayOrigin: Node<'vec3'>,
  rayDirection: Node<'vec3'>,
  radii: Node<'vec4'>
): RaySpheresIntersections => {
  const b = dot(rayDirection, rayOrigin).mul(2).toConst()
  const c = dot(rayOrigin, rayOrigin).sub(radii.mul(radii)).toConst()
  const discriminant = b.mul(b).sub(c.mul(4)).toConst()
  const mask = step(discriminant, vec4(0)).toConst()
  const Q = sqrt(max(vec4(0), discriminant)).toConst()
  return {
    first: mix(b.negate().sub(Q).mul(0.5), vec4(-1), mask).toConst(),
    second: mix(b.negate().add(Q).mul(0.5), vec4(-1), mask).toConst()
  }
}

// The radii of the intersection lanes are:
// bottomRadius + (0, minHeight, maxHeight, shadowTopHeight),
// thus x = ground, y = the bottom of the total cloud layer, z = the top of the
// total cloud layer, w = the top of the shadow layers.

export const getRayNearFar = /*#__PURE__*/ FnLayout({
  name: 'getRayNearFar',
  type: 'vec2',
  inputs: [
    { name: 'ground', type: 'bool' },
    { name: 'first', type: 'vec4' },
    { name: 'second', type: 'vec4' },
    { name: 'cameraHeight', type: 'float' },
    { name: 'cameraNear', type: 'float' },
    { name: 'minHeight', type: 'float' },
    { name: 'maxHeight', type: 'float' },
    { name: 'maxRayDistance', type: 'float' }
  ]
})(([
  ground,
  first,
  second,
  cameraHeight,
  cameraNear,
  minHeight,
  maxHeight,
  maxRayDistance
]) => {
  const nearFar = vec2().toVar()
  If(cameraHeight.lessThan(minHeight), () => {
    // View below the clouds:
    If(ground, () => {
      nearFar.assign(vec2(-1)) // No clouds to the ground
    }).Else(() => {
      nearFar.assign(vec2(second.y, min(second.z, maxRayDistance)))
    })
  })
    .ElseIf(cameraHeight.lessThan(maxHeight), () => {
      // View inside the total cloud layer:
      If(ground, () => {
        nearFar.assign(vec2(cameraNear, first.y))
      }).Else(() => {
        nearFar.assign(vec2(cameraNear, second.z))
      })
    })
    .Else(() => {
      // View above the clouds:
      nearFar.assign(vec2(first.z, second.z))
      If(ground, () => {
        // Clamp the ray at the min height:
        nearFar.y.assign(first.y)
      })
    })
  return nearFar
})

export const getHazeRayNearFar = /*#__PURE__*/ FnLayout({
  name: 'getHazeRayNearFar',
  type: 'vec2',
  inputs: [
    { name: 'ground', type: 'bool' },
    { name: 'first', type: 'vec4' },
    { name: 'second', type: 'vec4' },
    { name: 'cameraHeight', type: 'float' },
    { name: 'cameraNear', type: 'float' },
    { name: 'maxHeight', type: 'float' }
  ]
})(([ground, first, second, cameraHeight, cameraNear, maxHeight]) => {
  const nearFar = vec2().toVar()
  If(cameraHeight.lessThan(maxHeight), () => {
    If(ground, () => {
      nearFar.assign(vec2(cameraNear, first.x))
    }).Else(() => {
      nearFar.assign(vec2(cameraNear, second.z))
    })
  }).Else(() => {
    nearFar.assign(vec2(cameraNear, second.z))
    If(ground, () => {
      // Clamp the ray at the ground:
      nearFar.y.assign(first.x)
    })
  })
  return nearFar
})
