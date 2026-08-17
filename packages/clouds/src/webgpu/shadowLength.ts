// Adapters from the scalar shadow length produced by the clouds march to the
// vec2 shadow length contract of the atmosphere runtime.
//
// The WebGPU atmosphere (SkyNode, AerialPerspectiveNode,
// getIndirectLuminance/getIndirectLuminanceToPoint) takes the shadow length
// as vec2(x, y):
//   x = length of the shadowed segment along the view ray
//   y = distance from the camera to the start of the shadowed segment
// The WebGL Bruneton port only takes the scalar length and fixes the segment
// position per function; these helpers reproduce that placement.

import { vec2 } from 'three/tsl'

import type { Node } from '@takram/three-geospatial/webgpu'

/**
 * Shadow length for the sky (rays escaping to the top atmosphere boundary), as
 * consumed by SkyNode / getIndirectLuminance.
 *
 * Reproduces GetSkyRadiance() of the WebGL version, where the shadowed segment
 * starts at the camera and the scattering along [0, shadowLength] is omitted.
 */
export const shadowLengthFromCamera = (
  shadowLength: Node<'float'>
): Node<'vec2'> => vec2(shadowLength, 0)

/**
 * Shadow length for a ray ending at a point at distanceToPoint from the camera,
 * as consumed by AerialPerspectiveNode / getIndirectLuminanceToPoint.
 *
 * Reproduces GetSkyRadianceToPoint() of the WebGL version, where the last
 * shadowLength of the view ray before the point is shadowed (d = max(d -
 * shadowLength, 0)); the segment therefore starts at max(distanceToPoint -
 * shadowLength, 0).
 */
export const shadowLengthToPoint = (
  shadowLength: Node<'float'>,
  distanceToPoint: Node<'float'>
): Node<'vec2'> => vec2(shadowLength, distanceToPoint.sub(shadowLength).max(0))
