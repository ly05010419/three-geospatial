import { Vector3, type Camera } from 'three'

import { Ellipsoid } from '@takram/three-geospatial'

export interface CameraGroundClampOptions {
  /** Use the local ENU frame, where the ground is the y = 0 plane. */
  localFrame?: boolean
  /** Keep the camera this many meters above the ground surface. */
  clearance?: number
  /** Ellipsoid used by an ECEF camera. */
  ellipsoid?: Ellipsoid
}

export const CAMERA_GROUND_CLEARANCE = 1

const surfaceScratch = new Vector3()
const normalScratch = new Vector3()
const directionScratch = new Vector3()

function getGroundHeight(
  position: Vector3,
  ellipsoid: Ellipsoid,
  surface: Vector3,
  normal: Vector3
): number {
  let projection = ellipsoid.projectOnSurface(position, surface)
  if (projection == null) {
    // At the exact ellipsoid center there is no unique geodetic surface
    // projection. Use the current radial direction as a stable fallback.
    const direction = directionScratch.copy(position)
    if (direction.lengthSq() === 0) direction.set(0, 0, 1)
    direction.normalize()
    const radii = ellipsoid.radii
    const scale = 1 / Math.sqrt(
      (direction.x / radii.x) ** 2 +
        (direction.y / radii.y) ** 2 +
        (direction.z / radii.z) ** 2
    )
    projection = surface.copy(direction).multiplyScalar(scale)
  }

  ellipsoid.getSurfaceNormal(projection, normal)
  return directionScratch.subVectors(position, projection).dot(normal)
}

export function getCameraHeightAboveGround(
  camera: Camera,
  {
    localFrame = false,
    ellipsoid = Ellipsoid.WGS84
  }: CameraGroundClampOptions = {}
): number {
  if (localFrame) return camera.position.y
  return getGroundHeight(camera.position, ellipsoid, surfaceScratch, normalScratch)
}

/**
 * Prevent camera navigation from entering the ground.
 *
 * Returns true when the camera was moved. The helper is intentionally shared
 * by the R3F and vanilla demos so both camera paths enforce the same rule.
 */
export function clampCameraAboveGround(
  camera: Camera,
  {
    localFrame = false,
    clearance = CAMERA_GROUND_CLEARANCE,
    ellipsoid = Ellipsoid.WGS84
  }: CameraGroundClampOptions = {}
): boolean {
  const safeClearance = Math.max(0, clearance)

  if (localFrame) {
    if (camera.position.y >= safeClearance) return false
    camera.position.y = safeClearance
    camera.updateMatrixWorld()
    return true
  }

  const height = getGroundHeight(
    camera.position,
    ellipsoid,
    surfaceScratch,
    normalScratch
  )
  if (height >= safeClearance) return false

  camera.position
    .copy(surfaceScratch)
    .addScaledVector(normalScratch, safeClearance)
  camera.updateMatrixWorld()
  return true
}
