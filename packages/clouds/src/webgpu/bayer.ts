// Ported from: packages/clouds/src/shaders/cloudsResolve.frag

import { array, int } from 'three/tsl'

import { FnLayout } from '@takram/three-geospatial/webgpu'

export { bayerIndices, bayerOffsets } from '../bayer'

// The 4×4 Bayer dither indices arranged so that indexing by
// [coord.x % 4][coord.y % 4] matches the GLSL const table in
// cloudsResolve.frag digit-for-digit.
export const bayerIndex = /*#__PURE__*/ FnLayout({
  name: 'bayerIndex',
  type: 'int',
  inputs: [{ name: 'coord', type: 'ivec2' }]
})(([coord]) => {
  // prettier-ignore
  const bayerIndices = array([
    int(0), int(12), int(3), int(15),
    int(8), int(4), int(11), int(7),
    int(2), int(14), int(1), int(13),
    int(10), int(6), int(9), int(5)
  ])
  return int(bayerIndices.element(coord.x.mod(4).mul(4).add(coord.y.mod(4))))
})
