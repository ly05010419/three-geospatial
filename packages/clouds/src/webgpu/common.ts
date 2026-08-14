// Ported from: three-geospatial/packages/clouds/src/shaders/clouds.glsl
// getSphericalUv and textureCatmullRom are not ported because they are unused.

import type { ProxiedTuple, ShaderNodeFn } from 'three/src/nodes/TSL.js'
import {
  add,
  all,
  clamp,
  dFdx,
  dFdy,
  div,
  dot,
  exp,
  If,
  int,
  ivec2,
  ivec3,
  length,
  log2,
  max,
  mix,
  normalize,
  pow,
  remapClamp,
  screenCoordinate,
  sqrt,
  struct,
  sub,
  vec2,
  vec3,
  vec4
} from 'three/tsl'
import type { Texture3DNode, TextureNode } from 'three/webgpu'

import {
  STBN_TEXTURE_DEPTH,
  STBN_TEXTURE_HEIGHT,
  STBN_TEXTURE_WIDTH
} from '@takram/three-geospatial'
import { FnLayout, FnVar, type Node } from '@takram/three-geospatial/webgpu'

import type { CloudLayerUniforms, CloudParameterUniforms } from './uniforms'

export const getSTBN = /*#__PURE__*/ FnVar(
  (stbnTexture: Texture3DNode, frame: Node<'int'>): Node<'float'> => {
    // Use texel fetch instead of normalized-uv sampling in the WebGL version.
    // The coordinates are identical under the repeat wrapping.
    const size = ivec3(
      STBN_TEXTURE_WIDTH,
      STBN_TEXTURE_HEIGHT,
      STBN_TEXTURE_DEPTH
    ).toConst()
    const coord = ivec3(
      ivec2(screenCoordinate).mod(size.xy),
      int(frame).mod(size.z)
    )
    return stbnTexture.load(coord).r
  }
)

export const getCubeSphereUv = /*#__PURE__*/ FnLayout({
  name: 'getCubeSphereUv',
  type: 'vec2',
  inputs: [{ name: 'position', type: 'vec3' }]
})(([position]) => {
  // Cube-sphere relaxation by: http://mathproofs.blogspot.com/2005/07/mapping-cube-to-sphere.html
  // TODO: Tile and fix seams.
  // Possible improvements:
  // https://iquilezles.org/articles/texturerepetition/
  // https://gamedev.stackexchange.com/questions/184388/fragment-shader-map-dot-texture-repeatedly-over-the-sphere
  // https://github.com/mmikk/hextile-demo

  const n = normalize(position).toConst()
  const f = n.abs().toConst()
  const c = n.div(max(f.x, max(f.y, f.z))).toConst()
  const m = vec2().toVar()
  If(all(f.yy.greaterThan(f.xz)), () => {
    m.assign(c.y.greaterThan(0).select(vec2(n.x.negate(), n.z), n.xz))
  })
    .ElseIf(all(f.xx.greaterThan(f.yz)), () => {
      m.assign(c.x.greaterThan(0).select(n.yz, vec2(n.y.negate(), n.z)))
    })
    .Else(() => {
      m.assign(c.z.greaterThan(0).select(n.xy, vec2(n.x, n.y.negate())))
    })

  const m2 = m.mul(m).toConst()
  const q = dot(m2.xy, vec2(-2, 2)).sub(3).toConst()
  const q2 = q.mul(q).toConst()
  const uv = vec2().toVar()
  uv.x.assign(
    sqrt(
      add(1.5, m2.x)
        .sub(m2.y)
        .sub(sqrt(m2.x.mul(-24).add(q2)).mul(0.5))
    ).mul(m.x.greaterThan(0).select(1, -1))
  )
  uv.y.assign(sqrt(div(6, sub(3, uv.x.mul(uv.x)))).mul(m.y))
  return uv.mul(0.5).add(0.5)
})

export const getGlobeUv = /*#__PURE__*/ FnLayout({
  name: 'getGlobeUv',
  type: 'vec2',
  inputs: [{ name: 'position', type: 'vec3' }]
})(([position]) => {
  return getCubeSphereUv(position)
})

export const getMipLevel = /*#__PURE__*/ FnLayout({
  name: 'getMipLevel',
  type: 'float',
  inputs: [
    { name: 'uv', type: 'vec2' },
    { name: 'resolution', type: 'vec2' }
  ]
})(([uv, resolution]) => {
  const mipLevelScale = 0.1
  const coord = uv.mul(resolution).toConst()
  const ddx = dFdx(coord).toConst()
  const ddy = dFdy(coord).toConst()
  const deltaMaxSqr = max(dot(ddx, ddx), dot(ddy, ddy))
    .mul(mipLevelScale)
    .toConst()
  return max(0, log2(max(1, deltaMaxSqr)).mul(0.5))
})

export const insideLayerIntervals = /*#__PURE__*/ FnLayout({
  name: 'insideLayerIntervals',
  type: 'bool',
  inputs: [
    { name: 'height', type: 'float' },
    { name: 'minIntervalHeights', type: 'vec3' },
    { name: 'maxIntervalHeights', type: 'vec3' }
  ]
})(([height, minIntervalHeights, maxIntervalHeights]) => {
  const gt = vec3(height).greaterThan(minIntervalHeights).toConst()
  const lt = vec3(height).lessThan(maxIntervalHeights).toConst()
  // any(bvec3(...)) in the WebGL version, written as a disjunction here:
  return gt.x.and(lt.x).or(gt.y.and(lt.y)).or(gt.z.and(lt.z))
})

export const weatherSampleStruct = /*#__PURE__*/ struct(
  {
    heightFraction: 'vec4', // Normalized height of each layer
    density: 'vec4'
  },
  'WeatherSample'
)

export const shapeAlteringFunction = /*#__PURE__*/ FnLayout({
  name: 'shapeAlteringFunction',
  type: 'vec4',
  inputs: [
    { name: 'heightFraction', type: 'vec4' },
    { name: 'bias', type: 'vec4' }
  ]
})(([heightFraction, bias]) => {
  // Apply a semi-circle transform to round the clouds towards the top.
  const biased = pow(heightFraction, bias)
  const x = clamp(biased.mul(2).sub(1), -1, 1).toConst()
  return x.mul(x).oneMinus()
})

type RGBACharacter = 'r' | 'g' | 'b' | 'a'

export type LocalWeatherChannels =
  `${RGBACharacter}${RGBACharacter}${RGBACharacter}${RGBACharacter}`

export interface CloudSamplingTextures {
  localWeatherTexture: TextureNode
  shapeTexture: Texture3DNode
  shapeDetailTexture?: Texture3DNode | null
  turbulenceTexture?: TextureNode | null
}

export interface CloudSamplingOptions {
  // Equivalent to the SHADOW define in the WebGL version:
  shadow?: boolean
  // Equivalent to the LOCAL_WEATHER_CHANNELS define in the WebGL version:
  channels?: string
  // Equivalent to the SHAPE_DETAIL define in the WebGL version:
  shapeDetail?: boolean
  // Equivalent to the TURBULENCE define in the WebGL version:
  turbulence?: boolean
}

type SampleWeatherArgs = [
  uv: Node<'vec2'>,
  height: Node<'float'>,
  mipLevel: Node<'float'>
]

type SampleMediaArgs = [
  weather: ReturnType<typeof weatherSampleStruct>,
  position: Node<'vec3'>,
  uv: Node<'vec2'>,
  mipLevel: Node<'float'>,
  jitter: Node<'float'>,
  sampleCount?: Node<'ivec3'>
]

function parseChannels(channels: string): LocalWeatherChannels {
  if (!/^[rgba]{4}$/.test(channels)) {
    throw new Error(`Invalid local weather channels: ${channels}`)
  }
  return channels as LocalWeatherChannels
}

export const sampleWeather = (
  parameterUniforms: CloudParameterUniforms,
  layerUniforms: CloudLayerUniforms,
  textures: CloudSamplingTextures,
  options: CloudSamplingOptions = {}
): ShaderNodeFn<ProxiedTuple<SampleWeatherArgs>> => {
  const { shadow = false } = options
  const channels = parseChannels(options.channels ?? 'rgba')
  const { coverage, localWeatherRepeat, localWeatherOffset } = parameterUniforms
  const {
    minLayerHeights,
    maxLayerHeights,
    weatherExponents,
    shapeAlteringBiases,
    coverageFilterWidths,
    shadowLayerMask
  } = layerUniforms
  const { localWeatherTexture } = textures

  return FnVar(
    (uv: Node<'vec2'>, height: Node<'float'>, mipLevel: Node<'float'>) => {
      const heightFraction = remapClamp(
        vec4(height),
        minLayerHeights,
        maxLayerHeights
      ).toConst()

      const localWeather = pow(
        localWeatherTexture
          .sample(uv.mul(localWeatherRepeat).add(localWeatherOffset))
          .level(mipLevel)[channels],
        weatherExponents
      ).toVar()
      if (shadow) {
        localWeather.mulAssign(shadowLayerMask)
      }

      const heightScale = shapeAlteringFunction(
        heightFraction,
        shapeAlteringBiases
      ).toConst()

      // Modulation to control weather by coverage parameter.
      // Reference: https://github.com/Prograda/Skybolt/blob/master/Assets/Core/Shaders/Clouds.h#L63
      const factor = coverage.mul(heightScale).oneMinus().toConst()
      const density = remapClamp(
        mix(localWeather, vec4(1), coverageFilterWidths),
        factor,
        factor.add(coverageFilterWidths)
      )

      return weatherSampleStruct(heightFraction, density)
    }
  )
}

export const getLayerDensity = /*#__PURE__*/ FnLayout({
  // Keep the generated WGSL symbol distinct from atmosphere/common's scalar
  // getLayerDensity. WGSL does not support function overloading, so using the
  // same symbol name makes any pipeline combining clouds and atmosphere fail.
  name: 'getCloudLayerDensity',
  type: 'vec4',
  inputs: [
    { name: 'heightFraction', type: 'vec4' },
    { name: 'expTerms', type: 'vec4' },
    { name: 'exponents', type: 'vec4' },
    { name: 'linearTerms', type: 'vec4' },
    { name: 'constantTerms', type: 'vec4' }
  ]
})(([heightFraction, expTerms, exponents, linearTerms, constantTerms]) => {
  return expTerms
    .mul(exp(exponents.mul(heightFraction)))
    .add(linearTerms.mul(heightFraction))
    .add(constantTerms)
})

// Note that the "density" member in the WebGL version is omitted because it is
// unused.
export const mediaSampleStruct = /*#__PURE__*/ struct(
  {
    weight: 'vec4',
    scattering: 'float',
    extinction: 'float'
  },
  'MediaSample'
)

export const sampleMedia = (
  parameterUniforms: CloudParameterUniforms,
  layerUniforms: CloudLayerUniforms,
  textures: CloudSamplingTextures,
  options: CloudSamplingOptions = {}
): ShaderNodeFn<ProxiedTuple<SampleMediaArgs>> => {
  const { shapeDetail = true, turbulence = true } = options
  const {
    scatteringCoefficient,
    absorptionCoefficient,
    localWeatherRepeat,
    localWeatherOffset,
    shapeRepeat,
    shapeOffset,
    shapeDetailRepeat,
    shapeDetailOffset,
    turbulenceRepeat,
    turbulenceDisplacement
  } = parameterUniforms
  const { densityScales, shapeAmounts, shapeDetailAmounts, densityProfile } =
    layerUniforms
  const { shapeTexture, shapeDetailTexture, turbulenceTexture } = textures
  if (shapeDetail && shapeDetailTexture == null) {
    throw new Error(
      'shapeDetailTexture is required when the shapeDetail option is enabled.'
    )
  }
  if (turbulence && turbulenceTexture == null) {
    throw new Error(
      'turbulenceTexture is required when the turbulence option is enabled.'
    )
  }

  return FnVar(
    (
      weather: ReturnType<typeof weatherSampleStruct>,
      position: Node<'vec3'>,
      uv: Node<'vec2'>,
      mipLevel: Node<'float'>,
      jitter: Node<'float'>,
      sampleCount?: Node<'ivec3'>
    ) => {
      const heightFraction = weather.get('heightFraction').toConst()
      const density = weather.get('density').toVar()

      // TODO: Define in physical length.
      const surfaceNormal = normalize(position).toConst()
      const localWeatherSpeed = length(localWeatherOffset).toConst()
      const evolution = surfaceNormal
        .negate()
        .mul(localWeatherSpeed)
        .mul(2e4)
        .toConst()

      let turbulenceNode: Node<'vec3'> = vec3(0)
      if (turbulence && turbulenceTexture != null) {
        const turbulenceUv = uv.mul(localWeatherRepeat).mul(turbulenceRepeat)
        turbulenceNode = turbulenceDisplacement
          .mul(turbulenceTexture.sample(turbulenceUv).rgb.mul(2).sub(1))
          .mul(dot(density, remapClamp(heightFraction, vec4(0.3), vec4(0))))
          .toConst()
      }

      const shapePosition = position
        .add(evolution)
        .add(turbulenceNode)
        .mul(shapeRepeat)
        .add(shapeOffset)
        .toConst()
      const shape = shapeTexture.sample(shapePosition).r.toConst()
      density.assign(
        remapClamp(density, vec4(shape.oneMinus()).mul(shapeAmounts), vec4(1))
      )

      if (sampleCount != null) {
        sampleCount.y.addAssign(1)
      }

      if (shapeDetail && shapeDetailTexture != null) {
        If(
          mipLevel.mul(0.5).add(jitter.sub(0.5).mul(0.5)).lessThan(0.5),
          () => {
            const detailPosition = position
              .add(turbulenceNode)
              .mul(shapeDetailRepeat)
              .add(shapeDetailOffset)
              .toConst()
            const detail = shapeDetailTexture.sample(detailPosition).r.toConst()
            // Fluffy at the top and whippy at the bottom.
            const modifier = mix(
              vec4(pow(detail, 6)),
              vec4(detail.oneMinus()),
              remapClamp(heightFraction, vec4(0.2), vec4(0.4))
            ).toVar()
            modifier.assign(mix(vec4(0), modifier, shapeDetailAmounts))
            density.assign(
              remapClamp(density.mul(2), modifier.mul(0.5), vec4(1))
            )

            if (sampleCount != null) {
              sampleCount.z.addAssign(1)
            }
          }
        )
      }

      // Apply the density profiles.
      density.assign(
        density
          .mul(densityScales)
          .mul(
            getLayerDensity(
              heightFraction,
              densityProfile.expTerms,
              densityProfile.exponents,
              densityProfile.linearTerms,
              densityProfile.constantTerms
            )
          )
          .saturate()
      )

      const densitySum = density.x
        .add(density.y)
        .add(density.z)
        .add(density.w)
        .toConst()
      const weight = density.div(densitySum)
      const scattering = densitySum.mul(scatteringCoefficient).toConst()
      const extinction = densitySum.mul(absorptionCoefficient).add(scattering)
      return mediaSampleStruct(weight, scattering, extinction)
    }
  )
}
