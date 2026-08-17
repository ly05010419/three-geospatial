// Based on the following work with slight modifications.
// https://github.com/StrandedKitty/three-csm/
// https://github.com/mrdoob/three.js/tree/r169/examples/jsm/csm

/**
 * MIT License
 *
 * Copyright (c) 2019 vtHawk
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import {
  Vector3,
  WebGPUCoordinateSystem,
  type Camera,
  type Matrix4
} from 'three'

export class FrustumCorners {
  readonly near = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]
  readonly far = [new Vector3(), new Vector3(), new Vector3(), new Vector3()]

  constructor()
  constructor(camera: Camera, far: number)
  constructor(camera?: Camera, far?: number) {
    if (camera != null && far != null) {
      this.setFromCamera(camera, far)
    }
  }

  clone(): FrustumCorners {
    return new FrustumCorners().copy(this)
  }

  copy(other: FrustumCorners): this {
    for (let i = 0; i < 4; ++i) {
      this.near[i].copy(other.near[i])
      this.far[i].copy(other.far[i])
    }
    return this
  }

  setFromCamera(camera: Camera, far: number): this {
    const isOrthographic = camera.isOrthographicCamera === true
    const inverseProjectionMatrix = camera.projectionMatrixInverse

    // 3 --- 0
    // |     |
    // 2 --- 1
    // Clip space spans z from [-1, 1] under the WebGL coordinate system and
    // from [0, 1] under the WebGPU one, while xy spans [-1, 1] in both. The
    // far plane is at z = 1 either way, but the near plane is at z = -1 only
    // under WebGL. Unprojecting -1 with a WebGPU projection matrix places the
    // near corners behind the camera instead, which perturbs every split plane
    // (they are interpolated between the near and far corners) and hence the
    // cascade radii. See CascadedShadowMaps.updateMatrices: the radius scales
    // the texel size that the light-space center is snapped to, so even a
    // relative error of 1e-5 can shift a cascade by a whole texel.
    const nearZ = camera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1
    this.near[0].set(1, 1, nearZ)
    this.near[1].set(1, -1, nearZ)
    this.near[2].set(-1, -1, nearZ)
    this.near[3].set(-1, 1, nearZ)
    for (let i = 0; i < 4; ++i) {
      this.near[i].applyMatrix4(inverseProjectionMatrix)
    }

    this.far[0].set(1, 1, 1)
    this.far[1].set(1, -1, 1)
    this.far[2].set(-1, -1, 1)
    this.far[3].set(-1, 1, 1)
    for (let i = 0; i < 4; ++i) {
      const corner = this.far[i]
      corner.applyMatrix4(inverseProjectionMatrix)
      const absZ = Math.abs(corner.z)
      if (isOrthographic) {
        corner.z *= Math.min(far / absZ, 1)
      } else {
        corner.multiplyScalar(Math.min(far / absZ, 1))
      }
    }
    return this
  }

  split(
    clipDepths: readonly number[],
    result: FrustumCorners[] = []
  ): FrustumCorners[] {
    for (let index = 0; index < clipDepths.length; ++index) {
      const frustum = (result[index] ??= new FrustumCorners())
      if (index === 0) {
        for (let i = 0; i < 4; ++i) {
          frustum.near[i].copy(this.near[i])
        }
      } else {
        for (let i = 0; i < 4; ++i) {
          frustum.near[i].lerpVectors(
            this.near[i],
            this.far[i],
            clipDepths[index - 1]
          )
        }
      }
      if (index === clipDepths.length - 1) {
        for (let i = 0; i < 4; ++i) {
          frustum.far[i].copy(this.far[i])
        }
      } else {
        for (let i = 0; i < 4; ++i) {
          frustum.far[i].lerpVectors(
            this.near[i],
            this.far[i],
            clipDepths[index]
          )
        }
      }
    }
    result.length = clipDepths.length
    return result
  }

  applyMatrix4(matrix: Matrix4): this {
    for (let i = 0; i < 4; ++i) {
      this.near[i].applyMatrix4(matrix)
      this.far[i].applyMatrix4(matrix)
    }
    return this
  }
}
