import {
  Data3DTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  TextureLoader,
  type Texture
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
  ready: Promise<void>
}

interface PendingTexture<T> {
  texture: T
  ready: Promise<T>
}

const loadError = (url: string, cause: unknown): Error =>
  new Error(`Failed to load default cloud texture: ${url}`, { cause })

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
  texture.image.data ??= new Uint8Array(width * height * depth)
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

function loadDefaultTexture(url: string): PendingTexture<Texture> {
  let resolveReady!: (texture: Texture) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<Texture>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const texture = configurePlaceholder2DTexture(
    new TextureLoader().load(
      url,
      loaded => {
        loaded.needsUpdate = true
        resolveReady(loaded)
      },
      undefined,
      cause => {
        rejectReady(loadError(url, cause))
      }
    )
  )
  return { texture, ready }
}

function loadDefault3DTexture(
  url: string,
  size: number
): PendingTexture<Data3DTexture> {
  let resolveReady!: (texture: Data3DTexture) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<Data3DTexture>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
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
  }).load(
    url,
    loaded => {
      resolveReady(loaded)
    },
    undefined,
    cause => {
      rejectReady(loadError(url, cause))
    }
  )
  return {
    texture: configurePlaceholder3DTexture(texture, size, size, size),
    ready
  }
}

function loadDefaultSTBNTexture(url: string): PendingTexture<Data3DTexture> {
  let resolveReady!: (texture: Data3DTexture) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<Data3DTexture>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const texture = configurePlaceholderSTBNTexture(
    new STBNLoader().load(
      url,
      loaded => {
        resolveReady(loaded)
      },
      undefined,
      cause => {
        rejectReady(loadError(url, cause))
      }
    )
  )
  return { texture, ready }
}

export function loadDefaultCloudTextures(options: { assetBaseUrl?: string | URL } = {}): DefaultCloudTextures {
  const base = options.assetBaseUrl != null
    ? new URL(String(options.assetBaseUrl), globalThis.location?.href ?? 'http://localhost/')
    : undefined
  const asset = (name: string, fallback: string): string =>
    base != null ? new URL(name, base).href : fallback
  const localWeather = loadDefaultTexture(asset('local_weather.png', DEFAULT_LOCAL_WEATHER_URL))
  const shape = loadDefault3DTexture(
    asset('shape.bin', DEFAULT_SHAPE_URL),
    CLOUD_SHAPE_TEXTURE_SIZE
  )
  const shapeDetail = loadDefault3DTexture(
    asset('shape_detail.bin', DEFAULT_SHAPE_DETAIL_URL),
    CLOUD_SHAPE_DETAIL_TEXTURE_SIZE
  )
  const turbulence = loadDefaultTexture(asset('turbulence.png', DEFAULT_TURBULENCE_URL))
  const stbn = loadDefaultSTBNTexture(DEFAULT_STBN_URL)
  const ready = Promise.all([
    localWeather.ready,
    shape.ready,
    shapeDetail.ready,
    turbulence.ready,
    stbn.ready
  ]).then(() => undefined)
  void ready.catch((error: unknown) => {
    console.error(error)
  })
  return {
    localWeather: localWeather.texture,
    shape: shape.texture,
    shapeDetail: shapeDetail.texture,
    turbulence: turbulence.texture,
    stbn: stbn.texture,
    ready
  }
}
