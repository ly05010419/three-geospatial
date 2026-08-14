import { Vector3, Vector4 } from 'three'

import { CloudLayers } from '../CloudLayers'
import {
  createCloudLayerUniforms as createWebGLCloudLayerUniforms,
  updateCloudLayerUniforms as updateWebGLCloudLayerUniforms
} from '../uniforms'
import { createCloudLayerUniforms, updateCloudLayerUniforms } from './uniforms'

describe('updateCloudLayerUniforms', () => {
  test('packs CloudLayers.DEFAULT into the WebGL uniform values', () => {
    const uniforms = createCloudLayerUniforms()
    updateCloudLayerUniforms(uniforms, CloudLayers.DEFAULT)

    // Expected values below are what the WebGL updateCloudLayerUniforms
    // produces for CloudLayers.DEFAULT:
    // - Layer 0: altitude 750, height 650, shadow
    // - Layer 1: altitude 1000, height 1200, shadow
    // - Layer 2: altitude 7500, height 500
    // - Layer 3: CloudLayer.DEFAULT (altitude 0, height 0)
    expect(uniforms.minLayerHeights.value).toEqual(
      new Vector4(750, 1000, 7500, 0)
    )
    expect(uniforms.maxLayerHeights.value).toEqual(
      new Vector4(1400, 2200, 8000, 0)
    )

    // packIntervalHeights derives the gaps between the layer spans
    // [0, 0] ∪ [750, 1400] ∪ [1000, 2200] ∪ [7500, 8000]:
    // (0, 750), (2200, 7500), and an empty third interval.
    expect(uniforms.minIntervalHeights.value).toEqual(new Vector3(0, 2200, 0))
    expect(uniforms.maxIntervalHeights.value).toEqual(new Vector3(750, 7500, 0))

    expect(uniforms.densityScales.value).toEqual(
      new Vector4(0.2, 0.2, 0.003, 0.2)
    )
    expect(uniforms.shapeAmounts.value).toEqual(new Vector4(1, 1, 0.4, 1))
    expect(uniforms.shapeDetailAmounts.value).toEqual(new Vector4(1, 1, 0, 1))
    expect(uniforms.weatherExponents.value).toEqual(new Vector4(1, 1, 1, 1))
    expect(uniforms.shapeAlteringBiases.value).toEqual(
      new Vector4(0.35, 0.35, 0.35, 0.35)
    )
    expect(uniforms.coverageFilterWidths.value).toEqual(
      new Vector4(0.6, 0.6, 0.5, 0.6)
    )

    // Every layer uses the default density profile (0, 0, 0.75, 0.25).
    const { densityProfile } = uniforms
    expect(densityProfile.expTerms.value).toEqual(new Vector4(0, 0, 0, 0))
    expect(densityProfile.exponents.value).toEqual(new Vector4(0, 0, 0, 0))
    expect(densityProfile.linearTerms.value).toEqual(
      new Vector4(0.75, 0.75, 0.75, 0.75)
    )
    expect(densityProfile.constantTerms.value).toEqual(
      new Vector4(0.25, 0.25, 0.25, 0.25)
    )

    expect(uniforms.minHeight.value).toBe(750)
    expect(uniforms.maxHeight.value).toBe(8000)
    expect(uniforms.shadowBottomHeight.value).toBe(750)
    expect(uniforms.shadowTopHeight.value).toBe(2200)
    expect(uniforms.shadowLayerMask.value).toEqual(new Vector4(1, 1, 0, 0))
  })

  test('matches the WebGL implementation for CloudLayers.DEFAULT', () => {
    const uniforms = createCloudLayerUniforms()
    updateCloudLayerUniforms(uniforms, CloudLayers.DEFAULT)
    const webglUniforms = createWebGLCloudLayerUniforms()
    updateWebGLCloudLayerUniforms(webglUniforms, CloudLayers.DEFAULT)

    expect(uniforms.minLayerHeights.value).toEqual(
      webglUniforms.minLayerHeights.value
    )
    expect(uniforms.maxLayerHeights.value).toEqual(
      webglUniforms.maxLayerHeights.value
    )
    expect(uniforms.minIntervalHeights.value).toEqual(
      webglUniforms.minIntervalHeights.value
    )
    expect(uniforms.maxIntervalHeights.value).toEqual(
      webglUniforms.maxIntervalHeights.value
    )
    expect(uniforms.densityScales.value).toEqual(
      webglUniforms.densityScales.value
    )
    expect(uniforms.shapeAmounts.value).toEqual(
      webglUniforms.shapeAmounts.value
    )
    expect(uniforms.shapeDetailAmounts.value).toEqual(
      webglUniforms.shapeDetailAmounts.value
    )
    expect(uniforms.weatherExponents.value).toEqual(
      webglUniforms.weatherExponents.value
    )
    expect(uniforms.shapeAlteringBiases.value).toEqual(
      webglUniforms.shapeAlteringBiases.value
    )
    expect(uniforms.coverageFilterWidths.value).toEqual(
      webglUniforms.coverageFilterWidths.value
    )
    expect(uniforms.densityProfile.expTerms.value).toEqual(
      webglUniforms.densityProfile.value.expTerms
    )
    expect(uniforms.densityProfile.exponents.value).toEqual(
      webglUniforms.densityProfile.value.exponents
    )
    expect(uniforms.densityProfile.linearTerms.value).toEqual(
      webglUniforms.densityProfile.value.linearTerms
    )
    expect(uniforms.densityProfile.constantTerms.value).toEqual(
      webglUniforms.densityProfile.value.constantTerms
    )
    expect(uniforms.minHeight.value).toBe(webglUniforms.minHeight.value)
    expect(uniforms.maxHeight.value).toBe(webglUniforms.maxHeight.value)
    expect(uniforms.shadowTopHeight.value).toBe(
      webglUniforms.shadowTopHeight.value
    )
    expect(uniforms.shadowBottomHeight.value).toBe(
      webglUniforms.shadowBottomHeight.value
    )
    expect(uniforms.shadowLayerMask.value).toEqual(
      webglUniforms.shadowLayerMask.value
    )
  })
})
