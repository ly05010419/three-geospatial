// Ported from the raymarching portion of:
// three-geospatial/packages/clouds/src/shaders/shadow.frag
// and getClosestFragment() of:
// three-geospatial/packages/clouds/src/shaders/shadowResolve.frag
// See CloudShadowNode for the compute passes that drive these functions.

import type { ProxiedTuple, ShaderNodeFn } from 'three/src/nodes/TSL.js'
import {
  add,
  Break,
  Continue,
  exp,
  float,
  If,
  int,
  ivec3,
  length,
  Loop,
  max,
  min,
  vec2,
  vec4
} from 'three/tsl'
import type { Texture3DNode, UniformNode } from 'three/webgpu'
import type { Vector3 } from 'three'

import {
  STBN_TEXTURE_DEPTH,
  STBN_TEXTURE_HEIGHT,
  STBN_TEXTURE_WIDTH
} from '@takram/three-geospatial'
import { FnLayout, FnVar, type Node } from '@takram/three-geospatial/webgpu'

import { getGlobeUv, insideLayerIntervals } from './common'
import type { SampleMediaFn, SampleWeatherFn } from './marchClouds'
import { raySpheresIntersections } from './rayIntersections'
import {
  getStructureNormal,
  intersectStructuredPlanes
} from './structuredSampling'

// The equivalent of getSTBN() in clouds.glsl for the compute stage, where
// screenCoordinate does not exist; the invoking texel coordinate takes its
// place. Uses texel fetch with the identical coordinates to the repeat-wrapped
// normalized-uv sampling of the WebGL version:
export const getSTBNShadow = /*#__PURE__*/ FnVar(
  (
    stbnTexture: Texture3DNode,
    coord: Node<'ivec2'>,
    frame: Node<'int'>
  ): Node<'float'> => {
    const size = ivec3(
      STBN_TEXTURE_WIDTH,
      STBN_TEXTURE_HEIGHT,
      STBN_TEXTURE_DEPTH
    ).toConst()
    const texel = ivec3(coord.mod(size.xy), int(frame).mod(size.z))
    return stbnTexture.load(texel).r
  }
)

// Ported from getRayNearFar() in shadow.frag. Named distinctly because the
// clouds march emits its own getRayNearFar (rayIntersections.ts) and the
// WGSL function names must not collide. raySpheresIntersections().first is
// identical to raySphereFirstIntersection() of the WebGL core shaders,
// returning -1 on the lanes that miss:
export const getBSMRayNearFar = /*#__PURE__*/ FnLayout({
  name: 'getBSMRayNearFar',
  type: 'vec2',
  inputs: [
    { name: 'sunPosition', type: 'vec3' },
    { name: 'rayDirection', type: 'vec3' },
    { name: 'bottomRadius', type: 'float' },
    { name: 'shadowTopHeight', type: 'float' },
    { name: 'shadowBottomHeight', type: 'float' }
  ]
})(([
  sunPosition,
  rayDirection,
  bottomRadius,
  shadowTopHeight,
  shadowBottomHeight
]) => {
  const { first } = raySpheresIntersections(
    sunPosition,
    rayDirection,
    add(bottomRadius, vec4(shadowTopHeight, shadowBottomHeight, 0, 0))
  )
  const rayNear = max(0, first.x).toConst()
  const rayFar = first.y.lessThan(0).select(float(1e6), first.y).toConst()
  return vec2(rayNear, rayFar)
})

export interface MarchBSMUniforms {
  maxIterationCount: UniformNode<number>
  minStepSize: UniformNode<number>
  maxStepSize: UniformNode<number>
  minDensity: UniformNode<number>
  minExtinction: UniformNode<number>
  minTransmittance: UniformNode<number>
  opticalDepthTailScale: UniformNode<number>
}

export interface MarchBSMDependencies {
  // Equivalent to the TEMPORAL_JITTER define in the WebGL version:
  temporalJitter: boolean
  bottomRadius: Node<'float'> // In meters
  minIntervalHeights: UniformNode<Vector3>
  maxIntervalHeights: UniformNode<Vector3>
  uniforms: MarchBSMUniforms
  sampleWeather: SampleWeatherFn
  sampleMedia: SampleMediaFn
}

type MarchBSMArgs = [
  rayOrigin: Node<'vec3'>,
  rayDirection: Node<'vec3'>,
  maxRayDistance: Node<'float'>,
  jitter: Node<'float'>,
  mipLevel: Node<'float'>
]

// Ported from marchClouds() in shadow.frag, renamed to marchBSM to
// disambiguate from the primary raymarch in marchClouds.ts.
export const createMarchBSM = ({
  temporalJitter,
  bottomRadius,
  minIntervalHeights,
  maxIntervalHeights,
  uniforms: {
    maxIterationCount,
    minStepSize,
    maxStepSize,
    minDensity,
    minExtinction,
    minTransmittance,
    opticalDepthTailScale
  },
  sampleWeather,
  sampleMedia
}: MarchBSMDependencies): ShaderNodeFn<ProxiedTuple<MarchBSMArgs>> =>
  FnVar(
    (
      rayOrigin: Node<'vec3'>,
      rayDirection: Node<'vec3'>,
      maxRayDistance: Node<'float'>,
      jitter: Node<'float'>,
      mipLevel: Node<'float'>
    ): Node<'vec4'> => {
      // Setup structured volume sampling (SVS).
      // While SVS introduces spatial aliasing, it is indeed temporally stable,
      // which is important for lower-resolution shadow maps where a flickering
      // single pixel can be highly noticeable.
      const normal = getStructureNormal(rayDirection, jitter)
      const planes = intersectStructuredPlanes(
        normal,
        rayOrigin,
        rayDirection,
        maxRayDistance
          .div(float(maxIterationCount))
          .clamp(minStepSize, maxStepSize)
      )
      const rayDistance = planes.get('stepOffset').toVar()
      const stepSize = planes.get('stepSize').toConst()

      if (temporalJitter) {
        rayDistance.subAssign(stepSize.mul(jitter))
      }

      const extinctionSum = float(0).toVar()
      const maxOpticalDepth = float(0).toVar()
      const maxOpticalDepthTail = float(0).toVar()
      const transmittanceIntegral = float(1).toVar()
      const weightedDistanceSum = float(0).toVar()
      const transmittanceSum = float(0).toVar()

      const sampleCount = int(0).toVar()
      Loop(maxIterationCount, () => {
        If(rayDistance.greaterThan(maxRayDistance), () => {
          Break() // Termination
        })

        const position = rayDirection.mul(rayDistance).add(rayOrigin).toConst()
        const height = length(position).sub(bottomRadius).toConst()

        If(
          insideLayerIntervals(height, minIntervalHeights, maxIntervalHeights),
          () => {
            rayDistance.addAssign(stepSize)
            Continue()
          }
        )

        // Sample rough weather:
        const uv = getGlobeUv(position).toConst()
        const weather = sampleWeather(uv, height, mipLevel)

        If(weather.get('density').greaterThan(vec4(minDensity)).any(), () => {
          // Sample detailed participating media.
          // Note this assumes an homogeneous medium.
          const media = sampleMedia(weather, position, uv, mipLevel, jitter)
          const extinction = media.get('extinction').toConst()
          If(extinction.greaterThan(minExtinction), () => {
            extinctionSum.addAssign(extinction)
            maxOpticalDepth.addAssign(extinction.mul(stepSize))
            transmittanceIntegral.mulAssign(
              exp(extinction.negate().mul(stepSize))
            )
            weightedDistanceSum.addAssign(
              rayDistance.mul(transmittanceIntegral)
            )
            transmittanceSum.addAssign(transmittanceIntegral)
            sampleCount.addAssign(1)
          })
        })

        If(transmittanceIntegral.lessThanEqual(minTransmittance), () => {
          // A large amount of optical depth accumulates in the tail, beyond
          // the point of minimum transmittance. The expected optical depth
          // seems to decrease exponentially with the number of samples taken
          // before reaching the minimum transmittance.
          // See the discussion here: https://x.com/shotamatsuda/status/1886259549931520437
          maxOpticalDepthTail.assign(
            min(
              opticalDepthTailScale
                .mul(stepSize)
                .mul(exp(float(int(1).sub(sampleCount)))),
              stepSize.mul(0.5) // Excessive optical depth only introduces aliasing.
            )
          )
          Break() // Early termination
        })
        rayDistance.addAssign(stepSize)
      })

      // Rays that accumulated no samples encode the empty result
      // vec4(maxRayDistance, 0, 0, 0), preserved verbatim:
      const result = vec4(maxRayDistance, 0, 0, 0).toVar()
      If(sampleCount.notEqual(0), () => {
        const frontDepth = min(
          weightedDistanceSum.div(transmittanceSum),
          maxRayDistance
        ).toConst()
        const meanExtinction = extinctionSum.div(float(sampleCount)).toConst()
        result.assign(
          vec4(frontDepth, meanExtinction, maxOpticalDepth, maxOpticalDepthTail)
        )
      })
      return result
    }
  )

export type MarchBSMFn = ReturnType<typeof createMarchBSM>

// Offsets of the 3×3 neighborhood in getClosestFragment(), ported
// digit-for-digit from shadowResolve.frag:
const neighborOffsets: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 0],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
]

// Ported from getClosestFragment() in shadowResolve.frag. The depth velocity
// lives in its own texture with slices [0, cascadeCount) instead of the upper
// layers of the input buffer in the WebGL version; the offsets apply in xy
// only within the same slice:
export const getClosestFragment = /*#__PURE__*/ FnVar(
  (depthVelocityNode: Texture3DNode, coord: Node<'ivec3'>): Node<'vec4'> => {
    const result = vec4(1e7, 0, 0, 0).toVar()
    for (const [x, y] of neighborOffsets) {
      const neighbor = depthVelocityNode
        .load(coord.add(ivec3(x, y, 0)))
        .toConst()
      If(neighbor.r.lessThan(result.r), () => {
        result.assign(neighbor)
      })
    }
    return result
  }
)
