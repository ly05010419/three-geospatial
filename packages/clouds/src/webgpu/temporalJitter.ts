// The Bayer sub-texel jitter of the temporal upscaling, ported from
// CloudsMaterial.copyCameraSettings() of the WebGL version.
//
// The march renders at 1/4 resolution. Each frame, the ray of a low-resolution
// texel is offset so that it samples the full-resolution texel of the Bayer
// slot of the frame (bayerOffsets[frame % 16]), which is where the resolve
// pass (bayerIndex in bayer.ts) places the fresh sample.

import { Vector2, type Matrix4 } from 'three'

import { bayerOffsets } from '../bayer'

/**
 * Full-resolution UV jitter of the Bayer sub-texel for the frame, using the
 * same formula as the WebGL CloudsMaterial. The resolution is the
 * full-resolution size (the low-resolution size × 4).
 */
export function getTemporalJitter(
  frame: number,
  resolution: Vector2,
  target = new Vector2()
): Vector2 {
  const offset = bayerOffsets[frame % 16]
  return target.set(
    ((offset.x - 0.5) / resolution.x) * 4,
    ((offset.y - 0.5) / resolution.y) * 4
  )
}

/**
 * Jitters a projection matrix in place by a UV offset (elements 8 and 9 are the
 * third column of the column-major matrix, which shifts the NDC by twice the UV
 * offset after the perspective divide).
 *
 * NDC y points up while top-left rasters (WebGPU screenUV / screenCoordinate,
 * used for the scene depth read and the Bayer slot of the resolve) grow
 * downward, so flipY = true negates the y term. flipY = false reproduces the
 * WebGL CloudsMaterial (bottom-left gl_FragCoord).
 */
export function applyProjectionJitter(
  projection: Matrix4,
  jitter: Vector2,
  flipY: boolean
): Matrix4 {
  const { elements } = projection
  elements[8] += jitter.x * 2
  elements[9] += (flipY ? -jitter.y : jitter.y) * 2
  return projection
}
