import { Matrix4, PerspectiveCamera, Vector2, Vector3 } from 'three'

import { bayerOffsets } from '../bayer'
import { applyProjectionJitter, getTemporalJitter } from './temporalJitter'

describe('getTemporalJitter', () => {
  test('matches the WebGL CloudsMaterial jitter formula', () => {
    const resolution = new Vector2(32, 32)
    // bayerIndices[0] sits at column 0, row 0: offset (0.125, 0.125).
    expect(getTemporalJitter(0, resolution)).toEqual(
      new Vector2(((0.125 - 0.5) / 32) * 4, ((0.125 - 0.5) / 32) * 4)
    )
    // bayerIndices[1] sits at column 2, row 2: offset (0.625, 0.625).
    expect(getTemporalJitter(1, resolution)).toEqual(
      new Vector2(((0.625 - 0.5) / 32) * 4, ((0.625 - 0.5) / 32) * 4)
    )
    for (let frame = 0; frame < 16; ++frame) {
      const { x, y } = bayerOffsets[frame]
      expect(getTemporalJitter(frame, resolution)).toEqual(
        new Vector2(((x - 0.5) / 32) * 4, ((y - 0.5) / 32) * 4)
      )
    }
  })

  test('cycles every 16 frames and writes into the target', () => {
    const resolution = new Vector2(64, 32)
    const target = new Vector2()
    expect(getTemporalJitter(21, resolution, target)).toBe(target)
    expect(target).toEqual(getTemporalJitter(5, resolution))
  })
})

describe('applyProjectionJitter', () => {
  const camera = new PerspectiveCamera(75, 16 / 9, 1, 4e5)
  const projection = camera.projectionMatrix

  test('offsets the third column by twice the jitter, negating y for top-left rasters', () => {
    const jitter = new Vector2(0.01, 0.02)
    const flipped = applyProjectionJitter(projection.clone(), jitter, true)
    const upright = applyProjectionJitter(projection.clone(), jitter, false)

    for (let i = 0; i < 16; ++i) {
      if (i === 8) {
        expect(flipped.elements[i]).toBeCloseTo(projection.elements[i] + 0.02)
        expect(upright.elements[i]).toBeCloseTo(projection.elements[i] + 0.02)
      } else if (i === 9) {
        expect(flipped.elements[i]).toBeCloseTo(projection.elements[i] - 0.04)
        expect(upright.elements[i]).toBeCloseTo(projection.elements[i] + 0.04)
      } else {
        expect(flipped.elements[i]).toBe(projection.elements[i])
        expect(upright.elements[i]).toBe(projection.elements[i])
      }
    }
  })

  test('returns the jittered matrix itself', () => {
    const matrix = projection.clone()
    expect(applyProjectionJitter(matrix, new Vector2(0.01, 0.02), true)).toBe(
      matrix
    )
  })

  // The march runs at 1/4 resolution, and the resolve reconstructs the
  // full-resolution image by placing the low-resolution texel (cx, cy) of
  // frame f into the full-resolution texel (4cx + col, 4cy + row), where
  // (col, row) is the Bayer slot of the frame — indexed by the top-left
  // screenCoordinate in WebGPU. The jittered inverse projection must
  // therefore make the ray of the low-resolution texel center land exactly on
  // that full-resolution texel:
  const lowResolution = 8
  const resolution = new Vector2(lowResolution * 4, lowResolution * 4)

  const getFullResolutionTexel = (
    frame: number,
    cx: number,
    cy: number,
    flipY: boolean
  ): [number, number] => {
    const jitter = getTemporalJitter(frame, resolution)
    const inverseProjection = applyProjectionJitter(
      projection.clone(),
      jitter,
      flipY
    ).invert()
    const ndc = new Vector3(
      ((cx + 0.5) / lowResolution) * 2 - 1,
      1 - ((cy + 0.5) / lowResolution) * 2,
      0.5
    )
    // The ray of the fragment in view space, then back to unjittered NDC:
    const unjittered = ndc
      .applyMatrix4(inverseProjection)
      .applyMatrix4(projection)
    // Top-left UV, as WebGPU's screenUV:
    const u = unjittered.x * 0.5 + 0.5
    const v = unjittered.y * -0.5 + 0.5
    return [
      Math.floor(u * resolution.x + 1e-6),
      Math.floor(v * resolution.y + 1e-6)
    ]
  }

  const texelCoordinates = [
    [0, 0],
    [3, 5],
    [7, 7],
    [2, 6],
    [5, 1]
  ] as const

  test('lands the low-resolution ray on the Bayer slot of the frame (flipY)', () => {
    for (let frame = 0; frame < 16; ++frame) {
      const offset = bayerOffsets[frame % 16]
      const col = Math.floor(offset.x * 4)
      const row = Math.floor(offset.y * 4)
      for (const [cx, cy] of texelCoordinates) {
        expect(getFullResolutionTexel(frame, cx, cy, true)).toEqual([
          4 * cx + col,
          4 * cy + row
        ])
      }
    }
  })

  test('the WebGL bottom-left formula lands on the mirrored row (documents the old bug)', () => {
    for (let frame = 0; frame < 16; ++frame) {
      const offset = bayerOffsets[frame % 16]
      const col = Math.floor(offset.x * 4)
      const row = Math.floor(offset.y * 4)
      for (const [cx, cy] of texelCoordinates) {
        expect(getFullResolutionTexel(frame, cx, cy, false)).toEqual([
          4 * cx + col,
          4 * cy + 3 - row
        ])
      }
    }
  })

  test('the projection is left untouched by a zero jitter', () => {
    const matrix = projection.clone()
    applyProjectionJitter(matrix, new Vector2(0, 0), true)
    expect(matrix.equals(new Matrix4().copy(projection))).toBe(true)
  })
})
