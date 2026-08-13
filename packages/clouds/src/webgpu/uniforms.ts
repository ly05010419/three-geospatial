import { Matrix4, Vector2, Vector3, Vector4 } from 'three'
import { uniform, uniformArray } from 'three/tsl'
import type { UniformArrayNode, UniformNode } from 'three/webgpu'
import invariant from 'tiny-invariant'
import type { Primitive } from 'type-fest'

import type { CloudLayers } from '../CloudLayers'

export interface TypedUniformArrayNode<T> extends UniformArrayNode {
  array: T[]
}

export interface CloudParameterUniforms {
  // Participating medium
  scatteringCoefficient: UniformNode<number>
  absorptionCoefficient: UniformNode<number>

  // Weather and shape
  coverage: UniformNode<number>
  localWeatherRepeat: UniformNode<Vector2>
  localWeatherOffset: UniformNode<Vector2>
  shapeRepeat: UniformNode<Vector3>
  shapeOffset: UniformNode<Vector3>
  shapeDetailRepeat: UniformNode<Vector3>
  shapeDetailOffset: UniformNode<Vector3>
  turbulenceRepeat: UniformNode<Vector2>
  turbulenceDisplacement: UniformNode<number>
}

// prettier-ignore
export type CloudParameterUniformInstances = {
  [K in keyof CloudParameterUniforms as
    CloudParameterUniforms[K] extends UniformNode<infer V>
      ? V extends Primitive ? never : K
      : never
  ]: CloudParameterUniforms[K] extends UniformNode<infer V> ? V : never
}

export function createCloudParameterUniforms(
  instances: CloudParameterUniformInstances
): CloudParameterUniforms {
  return {
    // Participating medium
    scatteringCoefficient: uniform(1).setName('scatteringCoefficient'),
    absorptionCoefficient: uniform(0).setName('absorptionCoefficient'),

    // Weather and shape
    coverage: uniform(0.3).setName('coverage'),
    localWeatherRepeat: uniform(instances.localWeatherRepeat).setName(
      'localWeatherRepeat'
    ),
    localWeatherOffset: uniform(instances.localWeatherOffset).setName(
      'localWeatherOffset'
    ),
    shapeRepeat: uniform(instances.shapeRepeat).setName('shapeRepeat'),
    shapeOffset: uniform(instances.shapeOffset).setName('shapeOffset'),
    shapeDetailRepeat: uniform(instances.shapeDetailRepeat).setName(
      'shapeDetailRepeat'
    ),
    shapeDetailOffset: uniform(instances.shapeDetailOffset).setName(
      'shapeDetailOffset'
    ),
    turbulenceRepeat: uniform(instances.turbulenceRepeat).setName(
      'turbulenceRepeat'
    ),
    turbulenceDisplacement: uniform(350).setName('turbulenceDisplacement')
  }
}

// The DensityProfile struct uniform in the WebGL implementation becomes 4
// plain vec4 uniforms, as TSL doesn't support struct uniforms.
export interface DensityProfileUniforms {
  expTerms: UniformNode<Vector4>
  exponents: UniformNode<Vector4>
  linearTerms: UniformNode<Vector4>
  constantTerms: UniformNode<Vector4>
}

export interface CloudLayerUniforms {
  minLayerHeights: UniformNode<Vector4>
  maxLayerHeights: UniformNode<Vector4>
  minIntervalHeights: UniformNode<Vector3>
  maxIntervalHeights: UniformNode<Vector3>
  densityScales: UniformNode<Vector4>
  shapeAmounts: UniformNode<Vector4>
  shapeDetailAmounts: UniformNode<Vector4>
  weatherExponents: UniformNode<Vector4>
  shapeAlteringBiases: UniformNode<Vector4>
  coverageFilterWidths: UniformNode<Vector4>
  minHeight: UniformNode<number>
  maxHeight: UniformNode<number>
  shadowTopHeight: UniformNode<number>
  shadowBottomHeight: UniformNode<number>
  shadowLayerMask: UniformNode<Vector4>
  densityProfile: DensityProfileUniforms
}

export function createCloudLayerUniforms(): CloudLayerUniforms {
  return {
    minLayerHeights: uniform(new Vector4()).setName('minLayerHeights'),
    maxLayerHeights: uniform(new Vector4()).setName('maxLayerHeights'),
    minIntervalHeights: uniform(new Vector3()).setName('minIntervalHeights'),
    maxIntervalHeights: uniform(new Vector3()).setName('maxIntervalHeights'),
    densityScales: uniform(new Vector4()).setName('densityScales'),
    shapeAmounts: uniform(new Vector4()).setName('shapeAmounts'),
    shapeDetailAmounts: uniform(new Vector4()).setName('shapeDetailAmounts'),
    weatherExponents: uniform(new Vector4()).setName('weatherExponents'),
    shapeAlteringBiases: uniform(new Vector4()).setName('shapeAlteringBiases'),
    coverageFilterWidths: uniform(new Vector4()).setName(
      'coverageFilterWidths'
    ),
    minHeight: uniform(0).setName('minHeight'),
    maxHeight: uniform(0).setName('maxHeight'),
    shadowTopHeight: uniform(0).setName('shadowTopHeight'),
    shadowBottomHeight: uniform(0).setName('shadowBottomHeight'),
    shadowLayerMask: uniform(new Vector4()).setName('shadowLayerMask'),
    densityProfile: {
      expTerms: uniform(new Vector4()).setName('densityProfileExpTerms'),
      exponents: uniform(new Vector4()).setName('densityProfileExponents'),
      linearTerms: uniform(new Vector4()).setName('densityProfileLinearTerms'),
      constantTerms: uniform(new Vector4()).setName(
        'densityProfileConstantTerms'
      )
    }
  }
}

const shadowLayerMask = [0, 0, 0, 0]

export function updateCloudLayerUniforms(
  uniforms: CloudLayerUniforms,
  layers: CloudLayers
): void {
  layers.packValues('altitude', uniforms.minLayerHeights.value)
  layers.packSums('altitude', 'height', uniforms.maxLayerHeights.value)
  layers.packIntervalHeights(
    uniforms.minIntervalHeights.value,
    uniforms.maxIntervalHeights.value
  )
  layers.packValues('densityScale', uniforms.densityScales.value)
  layers.packValues('shapeAmount', uniforms.shapeAmounts.value)
  layers.packValues('shapeDetailAmount', uniforms.shapeDetailAmounts.value)
  layers.packValues('weatherExponent', uniforms.weatherExponents.value)
  layers.packValues('shapeAlteringBias', uniforms.shapeAlteringBiases.value)
  layers.packValues('coverageFilterWidth', uniforms.coverageFilterWidths.value)

  const { densityProfile } = uniforms
  layers.packDensityProfiles('expTerm', densityProfile.expTerms.value)
  layers.packDensityProfiles('exponent', densityProfile.exponents.value)
  layers.packDensityProfiles('linearTerm', densityProfile.linearTerms.value)
  layers.packDensityProfiles('constantTerm', densityProfile.constantTerms.value)

  let totalMinHeight = Infinity
  let totalMaxHeight = 0
  let shadowBottomHeight = Infinity
  let shadowTopHeight = 0
  shadowLayerMask.fill(0)
  for (let i = 0; i < layers.length; ++i) {
    const { altitude, height, shadow } = layers[i]
    const maxHeight = altitude + height
    if (height > 0) {
      if (altitude < totalMinHeight) {
        totalMinHeight = altitude
      }
      if (shadow && altitude < shadowBottomHeight) {
        shadowBottomHeight = altitude
      }
      if (maxHeight > totalMaxHeight) {
        totalMaxHeight = maxHeight
      }
      if (shadow && maxHeight > shadowTopHeight) {
        shadowTopHeight = maxHeight
      }
    }
    shadowLayerMask[i] = shadow ? 1 : 0
  }
  if (totalMinHeight !== Infinity) {
    uniforms.minHeight.value = totalMinHeight
    uniforms.maxHeight.value = totalMaxHeight
  } else {
    invariant(totalMaxHeight === 0)
    uniforms.minHeight.value = 0
  }
  if (shadowBottomHeight !== Infinity) {
    uniforms.shadowBottomHeight.value = shadowBottomHeight
    uniforms.shadowTopHeight.value = shadowTopHeight
  } else {
    invariant(shadowTopHeight === 0)
    uniforms.shadowBottomHeight.value = 0
  }
  uniforms.shadowLayerMask.value.fromArray(shadowLayerMask)
}

export interface CloudShadowUniforms {
  shadowTexelSize: UniformNode<Vector2>
  shadowIntervals: TypedUniformArrayNode<Vector2>
  shadowMatrices: TypedUniformArrayNode<Matrix4>
  shadowFar: UniformNode<number>
  maxShadowFilterRadius: UniformNode<number>
}

export function createCloudShadowUniforms(): CloudShadowUniforms {
  return {
    shadowTexelSize: uniform(new Vector2()).setName('shadowTexelSize'),
    shadowIntervals: uniformArray(
      Array.from({ length: 4 }, () => new Vector2()), // Populate the max number of elements
      'vec2'
    ).setName('shadowIntervals') as TypedUniformArrayNode<Vector2>,
    shadowMatrices: uniformArray(
      Array.from({ length: 4 }, () => new Matrix4()), // Populate the max number of elements
      'mat4'
    ).setName('shadowMatrices') as TypedUniformArrayNode<Matrix4>,
    shadowFar: uniform(0).setName('shadowFar'),
    maxShadowFilterRadius: uniform(6).setName('maxShadowFilterRadius')
  }
}
