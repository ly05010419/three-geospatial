import {
  PerspectiveCamera,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type CoordinateSystem
} from 'three'

import { FrustumCorners } from './FrustumCorners'

const FOV = 75
const ASPECT = 16 / 9
const NEAR = 1
const FAR = 4e5

function createCamera(coordinateSystem: CoordinateSystem): PerspectiveCamera {
  const camera = new PerspectiveCamera(FOV, ASPECT, NEAR, FAR)
  camera.coordinateSystem = coordinateSystem
  camera.updateProjectionMatrix()
  return camera
}

describe('FrustumCorners', () => {
  describe('setFromCamera', () => {
    // The near corners are unprojected from a different ndc z per coordinate
    // system. Getting it wrong mirrors them behind the camera, which perturbs
    // every split plane and the cascade radii derived from them.
    test('places the near corners on the near plane in both coordinate systems', () => {
      for (const coordinateSystem of [
        WebGLCoordinateSystem,
        WebGPUCoordinateSystem
      ]) {
        const camera = createCamera(coordinateSystem)
        const frustum = new FrustumCorners(camera, FAR)
        for (const corner of frustum.near) {
          expect(corner.z).toBeCloseTo(-NEAR, 9)
        }
        for (const corner of frustum.far) {
          expect(corner.z).toBeCloseTo(-FAR, 3)
        }
      }
    })

    test('agrees between the WebGL and WebGPU coordinate systems', () => {
      const webGL = new FrustumCorners(createCamera(WebGLCoordinateSystem), FAR)
      const webGPU = new FrustumCorners(
        createCamera(WebGPUCoordinateSystem),
        FAR
      )
      for (let i = 0; i < 4; ++i) {
        expect(webGPU.near[i].distanceTo(webGL.near[i])).toBeLessThan(1e-9)
        expect(webGPU.far[i].distanceTo(webGL.far[i])).toBeLessThan(1e-6)
      }
    })
  })
})
