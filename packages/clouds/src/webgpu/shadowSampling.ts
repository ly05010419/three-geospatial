// Ported from the BSM (beer shadow map) consumer portion of:
// three-geospatial/packages/clouds/src/shaders/clouds.frag
// and:
// three-geospatial/packages/core/src/shaders/cascadedShadowMaps.glsl
// three-geospatial/packages/core/src/shaders/vogelDisk.glsl
// three-geospatial/packages/core/src/shaders/interleavedGradientNoise.glsl
//
// The WebGL version renders the BSM into a sampler2DArray. The WebGPU version
// stores it in a 3D storage texture with one slice per cascade (see the D2
// design decision in .port-plan.md), so cascade i must be sampled at
// w = (i + 0.5) / cascadeCount with an explicit LOD of 0, which isolates the
// slice exactly under linear filtering while remaining bilinear in xy for PCF.
// The PCF offsets are applied in xy only and never cross cascade slices.
//
// The SHADOW_CASCADE_COUNT and SHADOW_SAMPLE_COUNT defines in the WebGL
// version become the cascadeCount and shadowSampleCount options here, and the
// loops bounded by them are unrolled on the JS side.

import type { ProxiedTuple, ShaderNodeFn } from 'three/src/nodes/TSL.js'
import {
  float,
  If,
  int,
  max,
  min,
  PI2,
  screenCoordinate,
  vec2,
  vec3,
  vec4,
  viewZToOrthographicDepth
} from 'three/tsl'
import type { Texture3DNode } from 'three/webgpu'

import {
  FnLayout,
  FnVar,
  interleavedGradientNoise,
  raySphereIntersection,
  type Node
} from '@takram/three-geospatial/webgpu'

import type { CloudShadowUniforms } from './uniforms'

export interface CloudShadowSamplingOptions {
  // Equivalent to the SHADOW_CASCADE_COUNT define in the WebGL version:
  cascadeCount?: number
  // Equivalent to the SHADOW_SAMPLE_COUNT define in the WebGL version:
  shadowSampleCount?: number
}

const DEFAULT_CASCADE_COUNT = 3
const DEFAULT_SHADOW_SAMPLE_COUNT = 8

function parseCascadeCount(options: CloudShadowSamplingOptions): number {
  const cascadeCount = options.cascadeCount ?? DEFAULT_CASCADE_COUNT
  if (!Number.isInteger(cascadeCount) || cascadeCount < 1 || cascadeCount > 4) {
    throw new Error(
      `cascadeCount must be an integer within [1, 4]: ${cascadeCount}`
    )
  }
  return cascadeCount
}

function parseShadowSampleCount(options: CloudShadowSamplingOptions): number {
  const shadowSampleCount =
    options.shadowSampleCount ?? DEFAULT_SHADOW_SAMPLE_COUNT
  if (
    !Number.isInteger(shadowSampleCount) ||
    shadowSampleCount < 1 ||
    shadowSampleCount > 16
  ) {
    throw new Error(
      `shadowSampleCount must be an integer within [1, 16]: ${shadowSampleCount}`
    )
  }
  return shadowSampleCount
}

// The nodes that the shadow sampling functions depend on besides the shadow
// uniforms. They are owned by CloudsMarchNode and the atmosphere context:
export interface CloudShadowSamplingDependencies {
  // Radius at the bottom of the atmosphere in meters, captured from the
  // atmosphere context at setup:
  bottomRadius: Node<'float'>
  sunDirectionECEF: Node<'vec3'>
  // layerUniforms.shadowTopHeight:
  shadowTopHeight: Node<'float'>
  // context.matrixECEFToWorld:
  matrixECEFToWorld: Node<'mat4'>
  // context.altitudeCorrectionECEF, or vec3(0) when correctAltitude is off:
  altitudeCorrectionECEF: Node<'vec3'>
  viewMatrix: Node<'mat4'>
  cameraNear: Node<'float'>
  temporalJitter: Node<'vec2'>
  resolution: Node<'vec2'>
}

// Reference: https://www.gamedev.net/tutorials/programming/graphics/contact-hardening-soft-shadows-made-fast-r4906/
export const vogelDisk = /*#__PURE__*/ FnLayout({
  name: 'vogelDisk',
  type: 'vec2',
  inputs: [
    { name: 'index', type: 'int' },
    { name: 'sampleCount', type: 'int' },
    { name: 'phi', type: 'float' }
  ]
})(([index, sampleCount, phi]) => {
  // The GLSL source spells 2.39996322972865332, which parses to the same
  // double; the canonical spelling satisfies no-loss-of-precision:
  const goldenAngle = 2.3999632297286535
  const r = float(index).add(0.5).sqrt().div(float(sampleCount).sqrt())
  const theta = float(index).mul(goldenAngle).add(phi)
  return vec2(theta.cos(), theta.sin()).mul(r)
})

type GetCascadeIndexArgs = [
  viewMatrix: Node<'mat4'>,
  worldPosition: Node<'vec3'>,
  cameraNear: Node<'float'>
]

// Reference: https://github.com/mrdoob/three.js/blob/r171/examples/jsm/csm/CSMShader.js
export const getCascadeIndex = (
  shadowUniforms: CloudShadowUniforms,
  options: CloudShadowSamplingOptions = {}
): ShaderNodeFn<ProxiedTuple<GetCascadeIndexArgs>> => {
  const cascadeCount = parseCascadeCount(options)
  const { shadowIntervals, shadowFar } = shadowUniforms

  return FnVar(
    (
      viewMatrix: Node<'mat4'>,
      worldPosition: Node<'vec3'>,
      cameraNear: Node<'float'>
    ): Node<'int'> => {
      const viewPosition = viewMatrix.mul(vec4(worldPosition, 1)).toConst()
      const depth = viewZToOrthographicDepth(
        viewPosition.z,
        cameraNear,
        shadowFar
      ).toConst()

      // The WebGL version returns at the first matching interval in ascending
      // order and falls back to the last cascade. The unrolled loop below
      // iterates in descending order instead so that the last assignment (the
      // smallest matching index) wins, which is equivalent:
      const index = int(cascadeCount - 1).toVar()
      for (let i = cascadeCount - 1; i >= 0; --i) {
        const interval: Node<'vec2'> = shadowIntervals.element(int(i))
        If(
          depth.greaterThanEqual(interval.x).and(depth.lessThan(interval.y)),
          () => {
            index.assign(int(i))
          }
        )
      }
      return index
    }
  )
}

type GetFadedCascadeIndexArgs = [
  viewMatrix: Node<'mat4'>,
  worldPosition: Node<'vec3'>,
  cameraNear: Node<'float'>,
  jitter: Node<'float'>
]

// Dithered version of getCascadeIndex which fades between the cascades.
// Returns -1 when the position is outside of every cascade:
export const getFadedCascadeIndex = (
  shadowUniforms: CloudShadowUniforms,
  options: CloudShadowSamplingOptions = {}
): ShaderNodeFn<ProxiedTuple<GetFadedCascadeIndexArgs>> => {
  const cascadeCount = parseCascadeCount(options)
  const { shadowIntervals, shadowFar } = shadowUniforms

  return FnVar(
    (
      viewMatrix: Node<'mat4'>,
      worldPosition: Node<'vec3'>,
      cameraNear: Node<'float'>,
      jitter: Node<'float'>
    ): Node<'int'> => {
      const viewPosition = viewMatrix.mul(vec4(worldPosition, 1)).toConst()
      const depth = viewZToOrthographicDepth(
        viewPosition.z,
        cameraNear,
        shadowFar
      ).toConst()

      const nextIndex = int(-1).toVar()
      const prevIndex = int(-1).toVar()
      // Note the alpha is uninitialized in the WebGL version. It is
      // initialized to 0 here, which makes the no-match case (nextIndex = -1)
      // deterministic without changing any matched case:
      const alpha = float(0).toVar()

      for (let i = 0; i < cascadeCount; ++i) {
        const interval: Node<'vec2'> = shadowIntervals.element(int(i)).toConst()
        const intervalCenter = interval.x.add(interval.y).mul(0.5).toConst()
        const closestEdge = depth
          .lessThan(intervalCenter)
          .select(interval.x, interval.y)
          .toConst()
        const margin = closestEdge.mul(closestEdge).mul(0.5).toConst()
        const fadedInterval = interval
          .add(margin.mul(vec2(-0.5, 0.5)))
          .toConst()

        if (i < cascadeCount - 1) {
          If(
            depth
              .greaterThanEqual(fadedInterval.x)
              .and(depth.lessThan(fadedInterval.y)),
            () => {
              prevIndex.assign(nextIndex)
              nextIndex.assign(int(i))
              alpha.assign(
                min(depth.sub(fadedInterval.x), fadedInterval.y.sub(depth))
                  .div(margin)
                  .saturate()
              )
            }
          )
        } else {
          // Don't fade out the last cascade:
          If(depth.greaterThanEqual(fadedInterval.x), () => {
            prevIndex.assign(nextIndex)
            nextIndex.assign(int(i))
            alpha.assign(depth.sub(fadedInterval.x).div(margin).saturate())
          })
        }
      }

      return jitter.lessThanEqual(alpha).select(nextIndex, prevIndex)
    }
  )
}

type GetShadowUvArgs = [
  worldPosition: Node<'vec3'>,
  cascadeIndex: Node<'int'>
]

// Note the BSM march in CloudShadowNode must unproject the texels using the
// inverse of the same shadow matrices with the identical NDC convention
// (ndc.xy = uv * 2 - 1), which keeps this self-consistent without any y-flip
// per the R2 risk in .port-plan.md:
export const getShadowUv = (
  shadowUniforms: CloudShadowUniforms
): ShaderNodeFn<ProxiedTuple<GetShadowUvArgs>> => {
  const { shadowMatrices } = shadowUniforms

  return FnVar(
    (worldPosition: Node<'vec3'>, cascadeIndex: Node<'int'>): Node<'vec2'> => {
      const clip = shadowMatrices
        .element(cascadeIndex)
        .mul(vec4(worldPosition, 1))
        .toVar()
      clip.divAssign(clip.w)
      return clip.xy.mul(0.5).add(0.5)
    }
  )
}

type GetDistanceToShadowTopArgs = [rayPosition: Node<'vec3'>]

export const getDistanceToShadowTop = (
  dependencies: Pick<
    CloudShadowSamplingDependencies,
    'bottomRadius' | 'shadowTopHeight' | 'sunDirectionECEF'
  >
): ShaderNodeFn<ProxiedTuple<GetDistanceToShadowTopArgs>> => {
  const { bottomRadius, shadowTopHeight, sunDirectionECEF } = dependencies

  return FnVar((rayPosition: Node<'vec3'>): Node<'float'> => {
    // Distance to the top of the shadows along the sun direction, which
    // matches the ray origin of BSM. raySphereIntersection().y is identical
    // to raySphereSecondIntersection() in the WebGL version, returning -1
    // when the ray misses the sphere:
    return raySphereIntersection(
      rayPosition,
      sunDirectionECEF,
      vec3(0),
      bottomRadius.add(shadowTopHeight)
    ).y
  })
}

type ReadShadowOpticalDepthArgs = [
  uv: Node<'vec2'>,
  distanceToTop: Node<'float'>,
  distanceOffset: Node<'float'>,
  cascadeIndex: Node<'int'>
]

export const readShadowOpticalDepth = (
  shadowBuffer: Texture3DNode,
  options: CloudShadowSamplingOptions = {}
): ShaderNodeFn<ProxiedTuple<ReadShadowOpticalDepthArgs>> => {
  const cascadeCount = parseCascadeCount(options)

  return FnVar(
    (
      uv: Node<'vec2'>,
      distanceToTop: Node<'float'>,
      distanceOffset: Node<'float'>,
      cascadeIndex: Node<'int'>
    ): Node<'float'> => {
      // r: frontDepth, g: meanExtinction, b: maxOpticalDepth, a: maxOpticalDepthTail
      // Also see the discussion here: https://x.com/shotamatsuda/status/1885322308908442106
      // Sample the cascade slice at its center in w with an explicit LOD so
      // that the linear filtering never bleeds across the cascades:
      const w = float(cascadeIndex).add(0.5).div(cascadeCount).toConst()
      const shadow = (shadowBuffer.sample(vec3(uv, w)) as Texture3DNode)
        .level(float(0))
        .toConst()
      const distanceToFront = max(
        0,
        distanceToTop.sub(distanceOffset).sub(shadow.r)
      ).toConst()
      return min(shadow.b.add(shadow.a), shadow.g.mul(distanceToFront))
    }
  )
}

type SampleShadowOpticalDepthPCFArgs = [
  worldPosition: Node<'vec3'>,
  distanceToTop: Node<'float'>,
  distanceOffset: Node<'float'>,
  radius: Node<'float'>,
  cascadeIndex: Node<'int'>
]

export const sampleShadowOpticalDepthPCF = (
  shadowBuffer: Texture3DNode,
  shadowUniforms: CloudShadowUniforms,
  dependencies: Pick<
    CloudShadowSamplingDependencies,
    'temporalJitter' | 'resolution'
  >,
  options: CloudShadowSamplingOptions = {}
): ShaderNodeFn<ProxiedTuple<SampleShadowOpticalDepthPCFArgs>> => {
  const shadowSampleCount = parseShadowSampleCount(options)
  const { shadowTexelSize } = shadowUniforms
  const { temporalJitter, resolution } = dependencies
  const getShadowUvFn = getShadowUv(shadowUniforms)
  const readShadowOpticalDepthFn = readShadowOpticalDepth(shadowBuffer, options)

  return FnVar(
    (
      worldPosition: Node<'vec3'>,
      distanceToTop: Node<'float'>,
      distanceOffset: Node<'float'>,
      radius: Node<'float'>,
      cascadeIndex: Node<'int'>
    ): Node<'float'> => {
      const uv = getShadowUvFn(worldPosition, cascadeIndex).toConst()
      const result = float(0).toVar()

      // Return 0 when the uv is outside of the cascade:
      If(
        uv.greaterThanEqual(vec2(0)).all().and(uv.lessThanEqual(vec2(1)).all()),
        () => {
          If(radius.lessThan(0.1), () => {
            result.assign(
              readShadowOpticalDepthFn(
                uv,
                distanceToTop,
                distanceOffset,
                cascadeIndex
              )
            )
          }).Else(() => {
            // The rotation angle is invariant over the taps. The WebGL version
            // derives it inside the unrolled loop, hoisted here (the values
            // are identical):
            const phi = interleavedGradientNoise(
              screenCoordinate.add(temporalJitter.mul(resolution))
            )
              .mul(PI2)
              .toConst()

            const sum = float(0).toVar()
            for (let i = 0; i < shadowSampleCount; ++i) {
              const offset = vogelDisk(
                int(i),
                int(shadowSampleCount),
                phi
              ).toConst()
              sum.addAssign(
                readShadowOpticalDepthFn(
                  // The offsets apply in xy only; the cascade slice in w never
                  // changes across the taps:
                  offset.mul(radius).mul(shadowTexelSize).add(uv),
                  distanceToTop,
                  distanceOffset,
                  cascadeIndex
                )
              )
            }
            result.assign(sum.div(shadowSampleCount))
          })
        }
      )
      return result
    }
  )
}

type SampleShadowOpticalDepthArgs = [
  rayPosition: Node<'vec3'>,
  distanceOffset: Node<'float'>,
  radius: Node<'float'>,
  jitter: Node<'float'>
]

export const sampleShadowOpticalDepth = (
  shadowBuffer: Texture3DNode,
  shadowUniforms: CloudShadowUniforms,
  dependencies: CloudShadowSamplingDependencies,
  options: CloudShadowSamplingOptions = {}
): ShaderNodeFn<ProxiedTuple<SampleShadowOpticalDepthArgs>> => {
  const { matrixECEFToWorld, altitudeCorrectionECEF, viewMatrix, cameraNear } =
    dependencies
  const getDistanceToShadowTopFn = getDistanceToShadowTop(dependencies)
  const getFadedCascadeIndexFn = getFadedCascadeIndex(shadowUniforms, options)
  const sampleShadowOpticalDepthPCFFn = sampleShadowOpticalDepthPCF(
    shadowBuffer,
    shadowUniforms,
    dependencies,
    options
  )

  return FnVar(
    (
      rayPosition: Node<'vec3'>,
      distanceOffset: Node<'float'>,
      radius: Node<'float'>,
      jitter: Node<'float'>
    ): Node<'float'> => {
      const distanceToTop = getDistanceToShadowTopFn(rayPosition).toConst()
      const result = float(0).toVar()
      If(distanceToTop.greaterThan(0), () => {
        // ecefToWorld() in the WebGL version:
        const worldPosition = matrixECEFToWorld
          .mul(vec4(rayPosition.sub(altitudeCorrectionECEF), 1))
          .xyz.toConst()
        const cascadeIndex = getFadedCascadeIndexFn(
          viewMatrix,
          worldPosition,
          cameraNear,
          jitter
        ).toConst()
        If(cascadeIndex.greaterThanEqual(0), () => {
          result.assign(
            sampleShadowOpticalDepthPCFFn(
              worldPosition,
              distanceToTop,
              distanceOffset,
              radius,
              cascadeIndex
            )
          )
        })
      })
      return result
    }
  )
}
