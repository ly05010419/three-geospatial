// Ported from the raymarching portion of:
// three-geospatial/packages/clouds/src/shaders/clouds.frag
// The BSM (beer shadow map) contribution is consumed through the optional
// shadow dependency (see shadowSampling.ts); without it the march renders the
// M2 image with zero shadow optical depth. marchShadowLength is added in M4.
// See CloudsMarchNode for the pass that drives these functions.

import type { Data3DTexture, Texture } from 'three'
import type { ProxiedTuple, ShaderNodeFn } from 'three/src/nodes/TSL.js'
import {
  add,
  Break,
  Continue,
  dot,
  exp,
  float,
  floor,
  If,
  int,
  length,
  log2,
  Loop,
  max,
  min,
  mix,
  mod,
  remap,
  remapClamp,
  sign,
  struct,
  texture,
  texture3D,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import { TextureNode, type Texture3DNode, type UniformNode } from 'three/webgpu'

import {
  getSplitIlluminance,
  getSplitScalarIlluminance
} from '@takram/three-atmosphere/webgpu'
import { FnLayout, FnVar, type Node } from '@takram/three-geospatial/webgpu'

import {
  getGlobeUv,
  insideLayerIntervals,
  type sampleMedia as createSampleMedia,
  type sampleWeather as createSampleWeather
} from './common'
import { phaseFunction, type PhaseFunctionOptions } from './phaseFunction'
import type { sampleShadowOpticalDepth as createSampleShadowOpticalDepth } from './shadowSampling'
import type { CloudLayerUniforms, CloudParameterUniforms } from './uniforms'

const RECIPROCAL_PI = 0.3183098861837907
const RECIPROCAL_PI4 = 0.07957747154594767

export type SampleWeatherFn = ReturnType<typeof createSampleWeather>
export type SampleMediaFn = ReturnType<typeof createSampleMedia>
export type SampleShadowOpticalDepthFn = ReturnType<
  typeof createSampleShadowOpticalDepth
>

// Coerce texture inputs into texture nodes. Plain textures are wrapped;
// texture nodes (e.g. of the procedural texture nodes) pass through:
export const toTextureNode = (value: Texture | TextureNode): TextureNode =>
  (value as TextureNode).isTextureNode === true
    ? (value as TextureNode)
    : texture(value as Texture)

export const toTexture3DNode = (
  value: Data3DTexture | Texture3DNode
): Texture3DNode =>
  (value as Texture3DNode).isTexture3DNode === true
    ? (value as Texture3DNode)
    : texture3D(value as Data3DTexture)

// Ported from: packages/core/src/shaders/generators.glsl in the WebGL version,
// which has no counterpart in the core WebGPU library. Used by the "uv" debug
// view only.
export const checker = /*#__PURE__*/ FnLayout({
  name: 'checker',
  type: 'float',
  inputs: [
    { name: 'uv', type: 'vec2' },
    { name: 'repeats', type: 'vec2' }
  ]
})(([uv, repeats]) => {
  const coord = floor(repeats.mul(uv)).toConst()
  return sign(mod(coord.x.add(coord.y), 2))
})

export const marchedOpticalDepthStruct = /*#__PURE__*/ struct(
  {
    opticalDepth: 'float',
    rayDistance: 'float'
  },
  'MarchedOpticalDepth'
)

export interface MarchOpticalDepthDependencies {
  bottomRadius: Node<'float'> // In meters
  minSecondaryStepSize: UniformNode<number>
  secondaryStepScale: UniformNode<number>
  sampleWeather: SampleWeatherFn
  sampleMedia: SampleMediaFn
}

type MarchOpticalDepthArgs = [
  rayOrigin: Node<'vec3'>,
  rayDirection: Node<'vec3'>,
  maxIterationCount: Node<'int'>,
  mipLevel: Node<'float'>,
  jitter: Node<'float'>
]

// Marches the optical depth of the participating media along the ray. The out
// parameter "rayDistance" of the WebGL version becomes a struct member.
export const createMarchOpticalDepth = ({
  bottomRadius,
  minSecondaryStepSize,
  secondaryStepScale,
  sampleWeather,
  sampleMedia
}: MarchOpticalDepthDependencies): ShaderNodeFn<
  ProxiedTuple<MarchOpticalDepthArgs>
> =>
  FnVar(
    (
      rayOrigin: Node<'vec3'>,
      rayDirection: Node<'vec3'>,
      maxIterationCount: Node<'int'>,
      mipLevel: Node<'float'>,
      jitter: Node<'float'>
    ) => {
      const iterationCount = int(
        max(
          0,
          remap(mipLevel, 0, 1, float(maxIterationCount.add(1)), 1).sub(jitter)
        )
      ).toConst()

      // Fudge factor to approximate the mean optical depth when no iterations
      // are taken, preserved verbatim from the WebGL version.
      const opticalDepth = float(0.5).toVar()
      // Note the WebGL version leaves the out parameter undefined at zero
      // iterations; the caller-initialized value of 0 is returned here.
      const rayDistance = float(0).toVar()

      If(iterationCount.notEqual(0), () => {
        opticalDepth.assign(0)
        const stepSize = minSecondaryStepSize.div(float(iterationCount)).toVar()
        const nextDistance = stepSize.mul(jitter).toVar()
        Loop(iterationCount, () => {
          rayDistance.assign(nextDistance)
          const position = rayDirection
            .mul(rayDistance)
            .add(rayOrigin)
            .toConst()
          const uv = getGlobeUv(position).toConst()
          const height = length(position).sub(bottomRadius).toConst()
          const weather = sampleWeather(uv, height, mipLevel)
          const media = sampleMedia(weather, position, uv, mipLevel, jitter)
          opticalDepth.addAssign(media.get('extinction').mul(stepSize))
          nextDistance.addAssign(stepSize)
          stepSize.mulAssign(secondaryStepScale)
        })
      })
      return marchedOpticalDepthStruct(opticalDepth, rayDistance)
    }
  )

export type MarchOpticalDepthFn = ReturnType<typeof createMarchOpticalDepth>

// Multiple scattering approximation
// See: https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf
// a: attenuation, b: contribution, c: phase attenuation
// The attenuation of every coefficient is the constant 0.5, so the unrolled
// coefficients become compile-time constants here, equivalently to the
// unrolled loop of the WebGL version.
const approximateMultipleScattering = (
  opticalDepth: Node<'float'>,
  cosTheta: Node<'float'>,
  octaves: number,
  phaseFunctionOptions: PhaseFunctionOptions
): Node<'float'> => {
  let scattering: Node<'float'> | undefined
  let a = 1
  let b = 1
  let c = 1
  for (let octave = 0; octave < octaves; ++octave) {
    const beerLambert = exp(opticalDepth.negate().mul(b))
    const term = beerLambert
      .mul(a)
      .mul(phaseFunction(cosTheta, c, phaseFunctionOptions))
    scattering = scattering != null ? scattering.add(term) : term
    a *= 0.5
    b *= 0.5
    c *= 0.5
  }
  if (scattering == null) {
    throw new Error('multiScatteringOctaves must be greater than 0.')
  }
  return scattering
}

export interface SunSkyIrradiance {
  sun: Node<'vec3'>
  sky: Node<'vec3'>
}

export interface CloudsIrradiance {
  minSun: Node<'vec3'>
  minSky: Node<'vec3'>
  maxSun: Node<'vec3'>
  maxSky: Node<'vec3'>
}

export interface SunSkyIrradianceCacheDependencies {
  bottomRadius: Node<'float'> // In meters
  worldToUnit: Node<'float'>
  sunDirectionECEF: Node<'vec3'>
  minHeight: UniformNode<number>
  maxHeight: UniformNode<number>
}

export interface SunSkyIrradianceCache {
  groundIrradiance: SunSkyIrradiance
  cloudsIrradiance: CloudsIrradiance
}

// Irradiance cache, ported from sampleSunSkyIrradiance() in clouds.vert. The
// given position is the camera position in ECEF with the altitude correction
// applied, which is constant across the fullscreen triangle. Keep these values
// in fragment instead of emitting six vec3 varyings; the result is
// mathematically identical for constant inputs and stays within WebGPU's
// inter-stage limit.
export const createSunSkyIrradianceCache = (
  correctedPositionECEF: Node<'vec3'>,
  {
    bottomRadius,
    worldToUnit,
    sunDirectionECEF,
    minHeight,
    maxHeight
  }: SunSkyIrradianceCacheDependencies
): SunSkyIrradianceCache => {
  const groundIlluminance = getSplitScalarIlluminance(
    correctedPositionECEF.mul(worldToUnit),
    sunDirectionECEF
  )
  const surfaceNormal = correctedPositionECEF.normalize()
  const radii = add(bottomRadius, vec2(minHeight, maxHeight)).mul(worldToUnit)
  const minIlluminance = getSplitScalarIlluminance(
    surfaceNormal.mul(radii.x),
    sunDirectionECEF
  )
  const maxIlluminance = getSplitScalarIlluminance(
    surfaceNormal.mul(radii.y),
    sunDirectionECEF
  )
  return {
    groundIrradiance: {
      sun: groundIlluminance.get('direct'),
      sky: groundIlluminance.get('indirect')
    },
    cloudsIrradiance: {
      minSun: minIlluminance.get('direct'),
      minSky: minIlluminance.get('indirect'),
      maxSun: maxIlluminance.get('direct'),
      maxSky: maxIlluminance.get('indirect')
    }
  }
}

export const marchedCloudsStruct = /*#__PURE__*/ struct(
  {
    color: 'vec4',
    frontDepth: 'float'
  },
  'MarchedClouds'
)

export interface MarchCloudsOptions {
  // Equivalent to the MULTI_SCATTERING_OCTAVES define in the WebGL version:
  multiScatteringOctaves: number
  // Equivalent to the ACCURATE_SUN_SKY_LIGHT define in the WebGL version:
  accurateSunSkyLight: boolean
  // Equivalent to the GROUND_BOUNCE define in the WebGL version:
  groundBounce: boolean
  // Equivalent to the POWDER define in the WebGL version:
  powder: boolean
}

export interface MarchCloudsUniforms {
  // Scattering
  skyLightScale: UniformNode<number>
  groundBounceScale: UniformNode<number>
  powderScale: UniformNode<number>
  powderExponent: UniformNode<number>

  // Primary raymarch
  maxIterationCount: UniformNode<number>
  minStepSize: UniformNode<number>
  maxStepSize: UniformNode<number>
  perspectiveStepScale: UniformNode<number>
  minDensity: UniformNode<number>
  minExtinction: UniformNode<number>
  minTransmittance: UniformNode<number>

  // Secondary raymarch
  maxIterationCountToSun: UniformNode<number>
  maxIterationCountToGround: UniformNode<number>

  // Shadow length
  maxShadowLengthIterationCount: UniformNode<number>
  minShadowLengthStepSize: UniformNode<number>
}

// The BSM consumption dependencies. Absent in the M2-only mode (bsm: false on
// CloudsMarchNode), which stubs the shadow optical depth to zero:
export interface MarchCloudsShadowDependencies {
  // The entry point created by sampleShadowOpticalDepth() in shadowSampling.ts
  // over the BSM texture and the shadow uniform bag:
  sampleShadowOpticalDepth: SampleShadowOpticalDepthFn
  // shadowUniforms.maxShadowFilterRadius:
  maxShadowFilterRadius: UniformNode<number>
}

export interface MarchCloudsDependencies {
  options: MarchCloudsOptions
  phaseFunctionOptions: PhaseFunctionOptions
  bottomRadius: Node<'float'> // In meters
  worldToUnit: Node<'float'>
  sunDirectionECEF: Node<'vec3'>
  parameterUniforms: CloudParameterUniforms
  layerUniforms: CloudLayerUniforms
  uniforms: MarchCloudsUniforms
  sampleWeather: SampleWeatherFn
  sampleMedia: SampleMediaFn
  marchOpticalDepth: MarchOpticalDepthFn
  shadow?: MarchCloudsShadowDependencies | null
  // Vertex-stage irradiance cache, used unless accurateSunSkyLight is on:
  groundIrradiance: SunSkyIrradiance
  cloudsIrradiance: CloudsIrradiance
}

type MarchCloudsArgs = [
  rayOrigin: Node<'vec3'>,
  rayDirection: Node<'vec3'>,
  rayNearFar: Node<'vec2'>,
  cosTheta: Node<'float'>,
  jitter: Node<'float'>,
  rayStartTexelsPerPixel: Node<'float'>,
  sampleCount?: Node<'ivec3'>
]

export const createMarchClouds = ({
  options,
  phaseFunctionOptions,
  bottomRadius,
  worldToUnit,
  sunDirectionECEF,
  parameterUniforms: { coverage },
  layerUniforms: {
    minHeight,
    maxHeight,
    shadowTopHeight,
    minIntervalHeights,
    maxIntervalHeights
  },
  uniforms: {
    skyLightScale,
    groundBounceScale,
    powderScale,
    powderExponent,
    maxIterationCount,
    minStepSize,
    maxStepSize,
    perspectiveStepScale,
    minDensity,
    minExtinction,
    minTransmittance,
    maxIterationCountToSun,
    maxIterationCountToGround
  },
  sampleWeather,
  sampleMedia,
  marchOpticalDepth,
  shadow,
  groundIrradiance,
  cloudsIrradiance
}: MarchCloudsDependencies): ShaderNodeFn<ProxiedTuple<MarchCloudsArgs>> => {
  const { multiScatteringOctaves } = options
  if (
    !Number.isInteger(multiScatteringOctaves) ||
    multiScatteringOctaves < 1 ||
    multiScatteringOctaves > 12
  ) {
    throw new Error(
      `multiScatteringOctaves must be an integer within [1, 12]: ${multiScatteringOctaves}`
    )
  }

  // TODO: Construct spherical harmonics of degree 2 using 2 sample points
  // positioned near the horizon occlusion points on the sun direction plane.
  const getGroundSunSkyIlluminance = (
    position: Node<'vec3'>,
    surfaceNormal: Node<'vec3'>,
    height: Node<'float'>
  ): SunSkyIrradiance => {
    if (options.accurateSunSkyLight) {
      const illuminance = getSplitIlluminance(
        position.sub(surfaceNormal.mul(height)).mul(worldToUnit),
        surfaceNormal,
        sunDirectionECEF
      ).toConst()
      return {
        sun: illuminance.get('direct'),
        sky: illuminance.get('indirect')
      }
    }
    return groundIrradiance
  }

  const getCloudsSunSkyIlluminance = (
    position: Node<'vec3'>,
    height: Node<'float'>
  ): SunSkyIrradiance => {
    if (options.accurateSunSkyLight) {
      const illuminance = getSplitScalarIlluminance(
        position.mul(worldToUnit),
        sunDirectionECEF
      ).toConst()
      return {
        sun: illuminance.get('direct'),
        sky: illuminance.get('indirect')
      }
    }
    const alpha = remapClamp(height, minHeight, maxHeight).toConst()
    return {
      sun: mix(cloudsIrradiance.minSun, cloudsIrradiance.maxSun, alpha),
      sky: mix(cloudsIrradiance.minSky, cloudsIrradiance.maxSky, alpha)
    }
  }

  const approximateRadianceFromGround = (
    position: Node<'vec3'>,
    surfaceNormal: Node<'vec3'>,
    height: Node<'float'>,
    mipLevel: Node<'float'>,
    jitter: Node<'float'>
  ): Node<'vec3'> => {
    const opticalDepthToGround = marchOpticalDepth(
      position,
      surfaceNormal.negate(),
      maxIterationCountToGround,
      mipLevel,
      jitter
    ).get('opticalDepth')
    const { sun: sunIrradiance, sky: skyIrradiance } =
      getGroundSunSkyIlluminance(position, surfaceNormal, height)
    const groundAlbedo = 0.3
    const groundIrradianceSum = skyIrradiance.add(
      coverage.oneMinus().mul(sunIrradiance)
    )
    const bouncedRadiance = groundIrradianceSum.mul(
      groundAlbedo * RECIPROCAL_PI
    )
    return bouncedRadiance.mul(exp(opticalDepthToGround.negate()))
  }

  return FnVar(
    (
      rayOrigin: Node<'vec3'>,
      rayDirection: Node<'vec3'>,
      rayNearFar: Node<'vec2'>,
      cosTheta: Node<'float'>,
      jitter: Node<'float'>,
      rayStartTexelsPerPixel: Node<'float'>,
      // Populated only when provided, for the sampleCount debug view:
      sampleCount?: Node<'ivec3'>
    ) => {
      const radianceIntegral = vec3(0).toVar()
      const transmittanceIntegral = float(1).toVar()
      const weightedDistanceSum = float(0).toVar()
      const transmittanceSum = float(0).toVar()

      // Note this shadows the maxRayDistance uniform in the WebGL version:
      const maxRayDistance = rayNearFar.y.sub(rayNearFar.x).toConst()
      const stepSize = minStepSize
        .add(perspectiveStepScale.sub(1).mul(rayNearFar.x))
        .toVar()
      // I don't understand why spatial aliasing remains unless doubling the
      // jitter. [Comment and factor preserved from the WebGL version.]
      const rayDistance = stepSize.mul(jitter).mul(2).toVar()

      Loop(maxIterationCount, () => {
        If(rayDistance.greaterThan(maxRayDistance), () => {
          Break() // Termination
        })

        const position = rayDirection.mul(rayDistance).add(rayOrigin).toConst()
        const height = length(position).sub(bottomRadius).toConst()
        const mipLevel = log2(
          max(1, rayStartTexelsPerPixel.add(rayDistance.mul(1e-5)))
        ).toConst()

        If(
          insideLayerIntervals(height, minIntervalHeights, maxIntervalHeights),
          () => {
            stepSize.mulAssign(perspectiveStepScale)
            rayDistance.addAssign(mix(stepSize, maxStepSize, min(1, mipLevel)))
            Continue()
          }
        )

        // Sample rough weather:
        const uv = getGlobeUv(position).toConst()
        const weather = sampleWeather(uv, height, mipLevel)

        if (sampleCount != null) {
          sampleCount.x.addAssign(1)
        }

        If(
          weather.get('density').greaterThan(vec4(minDensity)).any().not(),
          () => {
            // Step longer in empty space.
            // TODO: This produces banding artifacts.
            stepSize.mulAssign(perspectiveStepScale)
            rayDistance.addAssign(mix(stepSize, maxStepSize, min(1, mipLevel)))
            Continue()
          }
        )

        // Sample detailed participating media:
        const media =
          sampleCount != null
            ? sampleMedia(weather, position, uv, mipLevel, jitter, sampleCount)
            : sampleMedia(weather, position, uv, mipLevel, jitter)

        If(media.get('extinction').greaterThan(minExtinction), () => {
          const { sun: sunIrradiance, sky: skyIrradiance } =
            getCloudsSunSkyIlluminance(position, height)
          const surfaceNormal = position.normalize().toConst()

          // March optical depth to the sun for finer details, which BSM lacks:
          const marchedToSun = marchOpticalDepth(
            position,
            sunDirectionECEF,
            maxIterationCountToSun,
            mipLevel,
            jitter
          ).toConst()
          const opticalDepth = marchedToSun.get('opticalDepth').toVar()

          if (shadow != null) {
            const { sampleShadowOpticalDepth, maxShadowFilterRadius } = shadow
            If(height.lessThan(shadowTopHeight), () => {
              // Obtain the optical depth from the BSM at the ray position:
              opticalDepth.addAssign(
                sampleShadowOpticalDepth(
                  position,
                  // Take account of only positions further than the marched
                  // ray distance:
                  marchedToSun.get('rayDistance'),
                  // Apply PCF only when the sun is close to the horizon:
                  maxShadowFilterRadius.mul(
                    remapClamp(dot(sunDirectionECEF, surfaceNormal), 0.1, 0)
                  ),
                  jitter
                )
              )
            })
          }

          const radiance = sunIrradiance
            .mul(
              approximateMultipleScattering(
                opticalDepth,
                cosTheta,
                multiScatteringOctaves,
                phaseFunctionOptions
              )
            )
            .toVar()

          if (options.groundBounce) {
            // Fudge factor for the irradiance from ground:
            If(
              height.lessThan(shadowTopHeight).and(mipLevel.lessThan(0.5)),
              () => {
                const groundRadiance = approximateRadianceFromGround(
                  position,
                  surfaceNormal,
                  height,
                  mipLevel,
                  jitter
                )
                radiance.addAssign(
                  groundRadiance.mul(RECIPROCAL_PI4).mul(groundBounceScale)
                )
              }
            )
          }

          // Crude approximation of sky gradient. Better than none in the
          // shadows:
          const skyGradient = dot(
            weather.get('heightFraction').mul(0.5).add(0.5),
            media.get('weight')
          ).toConst()
          radiance.addAssign(
            skyIrradiance
              .mul(RECIPROCAL_PI4)
              .mul(skyGradient)
              .mul(skyLightScale)
          )

          // Finally multiply by scattering:
          radiance.mulAssign(media.get('scattering'))

          if (options.powder) {
            radiance.mulAssign(
              powderScale
                .mul(exp(media.get('extinction').negate().mul(powderExponent)))
                .oneMinus()
            )
          }

          // Energy-conserving analytical integration of scattered light
          // See 5.6.3 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
          const transmittance = exp(
            media.get('extinction').negate().mul(stepSize)
          ).toConst()
          const clampedExtinction = max(media.get('extinction'), 1e-7).toConst()
          const scatteringIntegral = radiance
            .sub(radiance.mul(transmittance))
            .div(clampedExtinction)
            .toConst()
          radianceIntegral.addAssign(
            scatteringIntegral.mul(transmittanceIntegral)
          )
          transmittanceIntegral.mulAssign(transmittance)

          // Aerial perspective affecting clouds
          // See 5.9.1 in https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
          weightedDistanceSum.addAssign(rayDistance.mul(transmittanceIntegral))
          transmittanceSum.addAssign(transmittanceIntegral)
        })

        If(transmittanceIntegral.lessThanEqual(minTransmittance), () => {
          Break() // Early termination
        })

        // Take a shorter step because we've already hit the clouds:
        stepSize.mulAssign(perspectiveStepScale)
        rayDistance.addAssign(stepSize)
      })

      // The final product of 5.9.1, which is evaluated in the aerial
      // perspective. Front depth is -1 when no samples are accumulated:
      const frontDepth = transmittanceSum
        .greaterThan(0)
        .select(weightedDistanceSum.div(transmittanceSum), float(-1))
        .toConst()

      return marchedCloudsStruct(
        vec4(
          radianceIntegral,
          remapClamp(transmittanceIntegral, 1, minTransmittance)
        ),
        frontDepth
      )
    }
  )
}

export type MarchCloudsFn = ReturnType<typeof createMarchClouds>

export interface MarchShadowLengthDependencies {
  perspectiveStepScale: UniformNode<number>
  maxShadowLengthIterationCount: UniformNode<number>
  minShadowLengthStepSize: UniformNode<number>
  sampleShadowOpticalDepth: SampleShadowOpticalDepthFn
}

type MarchShadowLengthArgs = [
  rayOrigin: Node<'vec3'>,
  rayDirection: Node<'vec3'>,
  rayNearFar: Node<'vec2'>,
  jitter: Node<'float'>
]

export const createMarchShadowLength = ({
  perspectiveStepScale,
  maxShadowLengthIterationCount,
  minShadowLengthStepSize,
  sampleShadowOpticalDepth
}: MarchShadowLengthDependencies): ShaderNodeFn<
  ProxiedTuple<MarchShadowLengthArgs>
> =>
  FnVar(
    (
      rayOrigin: Node<'vec3'>,
      rayDirection: Node<'vec3'>,
      rayNearFar: Node<'vec2'>,
      jitter: Node<'float'>
    ) => {
      const shadowLength = float(0).toVar()
      const maxRayDistance = rayNearFar.y.sub(rayNearFar.x).toConst()
      const stepSize = minShadowLengthStepSize.toVar()
      const rayDistance = stepSize.mul(jitter).toVar()
      // The WebGL shader declares attenuationFactor/attenuation here but
      // never updates attenuation. Keep the effective attenuation at 1.

      Loop(maxShadowLengthIterationCount, () => {
        If(rayDistance.greaterThan(maxRayDistance), () => {
          Break()
        })
        const position = rayDirection.mul(rayDistance).add(rayOrigin).toConst()
        const opticalDepth = sampleShadowOpticalDepth(
          position,
          float(0),
          float(0),
          jitter
        ).toConst()
        shadowLength.addAssign(
          exp(opticalDepth.negate()).oneMinus().mul(stepSize)
        )
        stepSize.mulAssign(perspectiveStepScale)
        rayDistance.addAssign(stepSize)
      })

      return shadowLength
    }
  )

export interface ApproximateHazeDependencies {
  phaseFunctionOptions: PhaseFunctionOptions
  bottomRadius: Node<'float'> // In meters
  coverage: UniformNode<number>
  cameraHeight: UniformNode<number>
  skyLightScale: UniformNode<number>
  hazeDensityScale: UniformNode<number>
  hazeExponent: UniformNode<number>
  hazeScatteringCoefficient: UniformNode<number>
  hazeAbsorptionCoefficient: UniformNode<number>
  // Vertex-stage irradiance cache at the camera, used regardless of
  // accurateSunSkyLight:
  groundIrradiance: SunSkyIrradiance
}

type ApproximateHazeArgs = [
  rayOrigin: Node<'vec3'>,
  rayDirection: Node<'vec3'>,
  maxRayDistance: Node<'float'>,
  cosTheta: Node<'float'>,
  shadowLength: Node<'float'>
]

export const createApproximateHaze = ({
  phaseFunctionOptions,
  bottomRadius,
  coverage,
  cameraHeight,
  skyLightScale,
  hazeDensityScale,
  hazeExponent,
  hazeScatteringCoefficient,
  hazeAbsorptionCoefficient,
  groundIrradiance
}: ApproximateHazeDependencies): ShaderNodeFn<
  ProxiedTuple<ApproximateHazeArgs>
> =>
  FnVar(
    (
      rayOrigin: Node<'vec3'>,
      rayDirection: Node<'vec3'>,
      maxRayDistance: Node<'float'>,
      cosTheta: Node<'float'>,
      shadowLength: Node<'float'>
    ): Node<'vec4'> => {
      const result = vec4(0).toVar()

      const modulation = remapClamp(coverage, 0.2, 0.4).toConst()
      // The camera height and modulation product test below is preserved
      // verbatim from the WebGL version, quirk included:
      If(cameraHeight.mul(modulation).greaterThanEqual(0), () => {
        const density = modulation
          .mul(hazeDensityScale)
          .mul(exp(cameraHeight.negate().mul(hazeExponent)))
          .toConst()
        // Prevent artifact in views from space:
        If(density.greaterThanEqual(1e-7), () => {
          // Blend two normals by the difference in angle so that normal near
          // the ground becomes that of the origin, and in the sky that of the
          // horizon.
          const normalAtOrigin = rayOrigin.normalize().toConst()
          const normalAtHorizon = rayOrigin
            .sub(rayDirection.mul(dot(rayOrigin, rayDirection)))
            .div(bottomRadius)
            .toConst()
          const alpha = remapClamp(
            dot(normalAtOrigin, normalAtHorizon),
            0.9,
            1
          ).toConst()
          const normal = mix(normalAtOrigin, normalAtHorizon, alpha).toConst()

          // Analytical optical depth where density exponentially decreases
          // with height. Based on: https://iquilezles.org/articles/fog/
          const angle = max(dot(normal, rayDirection), 1e-5).toConst()
          const exponent = angle.mul(hazeExponent).toConst()
          const linearTerm = density.div(hazeExponent).div(angle).toConst()

          // Derive the optical depths separately for with and without shadow
          // length:
          const expTerm = exp(maxRayDistance.negate().mul(exponent))
            .oneMinus()
            .toConst()
          const shadowExpTerm = exp(
            min(maxRayDistance, shadowLength).negate().mul(exponent)
          )
            .oneMinus()
            .toConst()
          const opticalDepth = expTerm.mul(linearTerm).toConst()
          const shadowOpticalDepth = max(
            expTerm.sub(shadowExpTerm).mul(linearTerm),
            0
          ).toConst()
          const transmittance = exp(opticalDepth.negate())
            .oneMinus()
            .saturate()
            .toConst()
          const shadowTransmittance = exp(shadowOpticalDepth.negate())
            .oneMinus()
            .saturate()
            .toConst()

          const inscatter = groundIrradiance.sun
            .mul(phaseFunction(cosTheta, 1, phaseFunctionOptions))
            .mul(shadowTransmittance)
            .toVar()
          inscatter.addAssign(
            groundIrradiance.sky
              .mul(RECIPROCAL_PI4)
              .mul(skyLightScale)
              .mul(transmittance)
          )
          inscatter.mulAssign(
            hazeScatteringCoefficient.div(
              hazeAbsorptionCoefficient.add(hazeScatteringCoefficient)
            )
          )
          result.assign(vec4(inscatter, transmittance))
        })
      })
      return result
    }
  )

export type ApproximateHazeFn = ReturnType<typeof createApproximateHaze>
