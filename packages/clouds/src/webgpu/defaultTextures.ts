import {
  Data3DTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  Texture,
  TextureLoader
} from 'three'

import {
  DataTextureLoader,
  DEFAULT_STBN_URL,
  parseUint8Array,
  STBN_TEXTURE_DEPTH,
  STBN_TEXTURE_HEIGHT,
  STBN_TEXTURE_WIDTH,
  STBNLoader
} from '@takram/three-geospatial'

import {
  CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
  CLOUD_SHAPE_TEXTURE_SIZE,
  DEFAULT_LOCAL_WEATHER_URL,
  DEFAULT_SHAPE_DETAIL_URL,
  DEFAULT_SHAPE_URL,
  DEFAULT_TURBULENCE_URL
} from '../constants'

export interface DefaultCloudTextures {
  localWeather: Texture
  shape: Data3DTexture
  shapeDetail: Data3DTexture
  turbulence: Texture
  stbn: Data3DTexture
}

export function configurePlaceholder2DTexture(texture: Texture): Texture {
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.colorSpace = NoColorSpace
  return texture
}

export function ensureUploadable3DTexture(
  texture: Data3DTexture,
  width: number,
  height: number,
  depth: number
): void {
  texture.image.width = width
  texture.image.height = height
  texture.image.depth = depth
  if (texture.image.data == null) {
    texture.image.data = new Uint8Array(width * height * depth)
  }
  texture.needsUpdate = true
}

export function configurePlaceholder3DTexture(
  texture: Data3DTexture,
  width?: number,
  height?: number,
  depth?: number
): Data3DTexture {
  if (width != null && height != null && depth != null) {
    ensureUploadable3DTexture(texture, width, height, depth)
  }
  texture.format = RedFormat
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.wrapR = RepeatWrapping
  texture.colorSpace = NoColorSpace
  return texture
}

export function configurePlaceholderSTBNTexture(
  texture: Data3DTexture
): Data3DTexture {
  ensureUploadable3DTexture(
    texture,
    STBN_TEXTURE_WIDTH,
    STBN_TEXTURE_HEIGHT,
    STBN_TEXTURE_DEPTH
  )
  texture.format = RedFormat
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.wrapR = RepeatWrapping
  texture.colorSpace = NoColorSpace
  return texture
}

function loadDefaultTexture(url: string): Texture {
  return configurePlaceholder2DTexture(
    new TextureLoader().load(url, texture => {
      texture.needsUpdate = true
    })
  )
}

function loadDefault3DTexture(url: string, size: number): Data3DTexture {
  const texture = new DataTextureLoader(Data3DTexture, parseUint8Array, {
    width: size,
    height: size,
    depth: size,
    format: RedFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: RepeatWrapping,
    wrapT: RepeatWrapping,
    wrapR: RepeatWrapping,
    colorSpace: NoColorSpace
  }).load(url)
  return configurePlaceholder3DTexture(texture, size, size, size)
}

export function loadDefaultCloudTextures(): DefaultCloudTextures {
  return {
    localWeather: loadDefaultTexture(DEFAULT_LOCAL_WEATHER_URL),
    shape: loadDefault3DTexture(DEFAULT_SHAPE_URL, CLOUD_SHAPE_TEXTURE_SIZE),
    shapeDetail: loadDefault3DTexture(
      DEFAULT_SHAPE_DETAIL_URL,
      CLOUD_SHAPE_DETAIL_TEXTURE_SIZE
    ),
    turbulence: loadDefaultTexture(DEFAULT_TURBULENCE_URL),
    stbn: configurePlaceholderSTBNTexture(
      new STBNLoader().load(DEFAULT_STBN_URL)
    )
  }
}
