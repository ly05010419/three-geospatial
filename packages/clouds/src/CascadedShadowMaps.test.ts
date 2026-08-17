import {
  Euler,
  PerspectiveCamera,
  Vector2,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
  type CoordinateSystem
} from 'three'

import { CascadedShadowMaps } from './CascadedShadowMaps'

// The frozen A/B comparison setup shared by the WebGL and WebGPU storybooks
// (storybook/src/clouds/MinimalSetup.stories.tsx and
// storybook-webgpu/src/clouds/Clouds-Basic.tsx):
const FOV = 75
const ASPECT = 16 / 9
const NEAR = 1
const FAR = 4e5
const POSITION: [number, number, number] = [
  4529893.894855564, 2615333.425024031, 3638042.815326614
]
const ROTATION: [number, number, number] = [
  0.6423512931563148, -0.2928348796035058, -0.8344824769956042
]
const SUN_DIRECTION = new Vector3(
  0.2242703391677732,
  0.8929558593112737,
  -0.3902981530717727
)
const LIGHT_DISTANCE = 699335.4391532628

function createCamera(coordinateSystem: CoordinateSystem): PerspectiveCamera {
  const camera = new PerspectiveCamera(FOV, ASPECT, NEAR, FAR)
  camera.coordinateSystem = coordinateSystem
  camera.updateProjectionMatrix()
  camera.position.fromArray(POSITION)
  camera.rotation.copy(new Euler(...ROTATION))
  camera.updateMatrixWorld()
  return camera
}

function createShadowMaps(
  coordinateSystem: CoordinateSystem
): CascadedShadowMaps {
  const shadowMaps = new CascadedShadowMaps({
    cascadeCount: 3,
    mapSize: new Vector2(512, 512),
    splitLambda: 0.6
  })
  shadowMaps.update(
    createCamera(coordinateSystem),
    SUN_DIRECTION,
    LIGHT_DISTANCE
  )
  return shadowMaps
}

describe('CascadedShadowMaps', () => {
  describe('update', () => {
    // updateMatrices snaps the light-space center to whole texel increments,
    // so any error in the cascade radius is quantized into a full texel shift
    // of the shadow map. The near corners used to be unprojected with the
    // WebGL ndc z under WebGPU, which offset cascade 0 by exactly one texel:
    test('yields identical cascades in the WebGL and WebGPU coordinate systems', () => {
      const webGL = createShadowMaps(WebGLCoordinateSystem)
      const webGPU = createShadowMaps(WebGPUCoordinateSystem)
      expect(webGPU.cascadeCount).toBe(webGL.cascadeCount)

      for (let i = 0; i < webGL.cascadeCount; ++i) {
        // The world position at the corner of the cascade's ortho box, which
        // exposes both the scale and the snapped translation of the matrix in
        // meters. One texel of cascade 0 is roughly 330 m here:
        const corner = new Vector3(-1, -1, -1)
        const expected = corner
          .clone()
          .applyMatrix4(webGL.cascades[i].inverseMatrix)
        const actual = corner
          .clone()
          .applyMatrix4(webGPU.cascades[i].inverseMatrix)
        expect(actual.distanceTo(expected)).toBeLessThan(1e-3)
        expect(
          webGPU.cascades[i].interval.distanceTo(webGL.cascades[i].interval)
        ).toBeLessThan(1e-9)
      }
    })
  })
})
