import type { Vector3 } from 'three'
import type { Ellipsoid } from '@takram/three-geospatial'
import type { AtmosphereContext } from '@takram/three-atmosphere/webgpu'
import type { QualityPreset } from '../qualityPresets'

export type CloudDepthMode = 'conventional' | 'reversed-z'

export interface CloudCurvatureOptions {
  enabled?: boolean
  referenceRadius?: number
  planetRadius?: number
  preserveLocalScale?: boolean
  referenceFrame?: { east: Vector3; north: Vector3; up: Vector3 }
  planetFrame?: { east: Vector3; north: Vector3; up: Vector3 }
}

export interface CloudDepthOptions {
  mode?: CloudDepthMode
  epsilon?: number
}

export interface CloudShadowOptions {
  enabled?: boolean
  autoUpdate?: boolean
  dispatchMode?: 'automatic' | 'explicit'
  /**
   * Caps the far distance of the cascaded shadow maps. Defaults to null,
   * which follows the camera far like the WebGL CascadedShadowMaps.
   */
  maxFar?: number | null
}

export interface CloudQualityOptions {
  preset?: QualityPreset
  bsm?: boolean
  lightShafts?: boolean
  haze?: boolean
  temporalUpscale?: boolean
}

export interface AtmosphereContextLike {
  ellipsoid: Ellipsoid
  getGeodeticHeight?: (positionECEF: unknown) => unknown
}

export interface CloudsOptions extends CloudQualityOptions {
  enabled?: boolean
  atmosphereContext?: AtmosphereContextLike | AtmosphereContext
  ellipsoid?: Ellipsoid
  curvature?: CloudCurvatureOptions
  depth?: CloudDepthOptions
  shaderNamespace?: string
  quality?: CloudQualityOptions
  shadows?: CloudShadowOptions
}

export interface DefaultTextureLoadOptions {
  /** Base URL containing local_weather.png, shape.bin, shape_detail.bin and turbulence.png. */
  assetBaseUrl?: string | URL
}
