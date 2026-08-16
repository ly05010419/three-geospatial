import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useRef, type ComponentProps, type ComponentRef, type FC } from 'react'
import { Quaternion } from 'three'

import {
  CAMERA_GROUND_CLEARANCE,
  clampCameraAboveGround,
  getCameraHeightAboveGround
} from './cameraGroundClamp'

export interface GroundClampedOrbitControlsProps
  extends ComponentProps<typeof OrbitControls> {
  localFrame?: boolean
  clearance?: number
}

/** OrbitControls that never leaves the camera below the current ground. */
export const GroundClampedOrbitControls: FC<
  GroundClampedOrbitControlsProps
> = ({
  localFrame = false,
  clearance = CAMERA_GROUND_CLEARANCE,
  ...props
}) => {
  const camera = useThree(({ camera }) => camera)
  const rotationBlockedRef = useRef(false)
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const previousQuaternionRef = useRef(new Quaternion())
  const hasPreviousQuaternionRef = useRef(false)

  // Capture the pose before OrbitControls processes this frame's drag. If the
  // drag would enter the ground, the later callback can restore this exact
  // orientation instead of allowing a one-frame pitch/roll-through.
  useFrame(() => {
    if (!rotationBlockedRef.current) {
      previousQuaternionRef.current.copy(camera.quaternion)
      hasPreviousQuaternionRef.current = true
    }
  }, -2)

  // drei updates OrbitControls at priority -1. Running the clamp at the
  // default priority means it is applied after every drag/zoom update and
  // before the frame is rendered.
  useFrame(() => {
    const moved = clampCameraAboveGround(camera, { localFrame, clearance })
    const height = getCameraHeightAboveGround(camera, {
      localFrame
    })
    if (moved) {
      rotationBlockedRef.current = true
      if (hasPreviousQuaternionRef.current) {
        camera.quaternion.copy(previousQuaternionRef.current)
      }
    }
    else if (rotationBlockedRef.current && height > clearance + 0.1) {
      rotationBlockedRef.current = false
    }
    if (controlsRef.current != null) {
      controlsRef.current.enableRotate = !rotationBlockedRef.current
    }
    if (
      rotationBlockedRef.current &&
      hasPreviousQuaternionRef.current
    ) {
      camera.quaternion.copy(previousQuaternionRef.current)
    } else if (!rotationBlockedRef.current) {
      previousQuaternionRef.current.copy(camera.quaternion)
      hasPreviousQuaternionRef.current = true
    }
  })

  return <OrbitControls ref={controlsRef} {...props} />
}
