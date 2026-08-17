import { Object3D, PerspectiveCamera, Vector2, Vector3 } from 'three'
import { NodeBuilder, NodeFrame } from 'three/webgpu'

import { CloudShapeDetailNode } from './CloudShapeDetailNode'
import { CloudsNode } from './CloudsNode'

// NodeBuilder is declared abstract in the typings, but its constructor is
// enough for resolving node types without a renderer.
const createBuilder = (): NodeBuilder =>
  new (NodeBuilder as unknown as new (
    object: Object3D,
    renderer: unknown,
    parser: unknown
  ) => NodeBuilder)(new Object3D(), {}, null)

describe('CloudsNode', () => {
  test('advances weather and shape offsets from their velocities', () => {
    const node = new CloudsNode()
    node.localWeatherVelocity.set(0.25, -0.5)
    node.shapeVelocity.set(1, 2, 3)
    node.shapeDetailVelocity.set(-1, -2, -3)

    vi.spyOn(node.shadowNode, 'update').mockImplementation(() => {})
    vi.spyOn(node.marchNode, 'update').mockImplementation(() => {})
    vi.spyOn(node.resolveNode, 'update').mockImplementation(() => {})

    const frame = Object.assign(new NodeFrame(), {
      deltaTime: 2,
      renderer: {
        getDrawingBufferSize: (target: Vector2) => target.set(800, 600)
      }
    })
    node.updateBefore(frame)

    expect(node.localWeatherOffset).toEqual(new Vector2(0.5, -1))
    expect(node.shapeOffset.toArray()).toEqual([2, 4, 6])
    expect(node.shapeDetailOffset.toArray()).toEqual([-2, -4, -6])
    node.dispose()
  })

  test('keeps the shadow producer and consumer cascade counts in sync', () => {
    const node = new CloudsNode()

    node.qualityPreset = 'low'

    expect(node.qualityPreset).toBe('low')
    expect(node.shadowNode.cascadeCount).toBe(2)
    expect(node.marchNode.shadowCascadeCount).toBe(2)
    expect(node.shadowMaps.mapSize).toEqual(new Vector2(256, 256))
    node.dispose()
  })

  test('gates shadow dispatch without losing the requested BSM setting', () => {
    const node = new CloudsNode()
    const shadowUpdate = vi
      .spyOn(node.shadowNode, 'update')
      .mockImplementation(() => {})
    vi.spyOn(node.marchNode, 'update').mockImplementation(() => {})
    vi.spyOn(node.resolveNode, 'update').mockImplementation(() => {})

    node.bsm = true
    node.shadowsEnabled = false

    expect(node.bsm).toBe(true)
    expect(node.marchNode.bsm).toBe(false)

    const frame = Object.assign(new NodeFrame(), {
      deltaTime: 0,
      renderer: {
        getDrawingBufferSize: (target: Vector2) => target.set(800, 600)
      }
    })
    node.updateBefore(frame)
    expect(shadowUpdate).not.toHaveBeenCalled()

    node.shadowsEnabled = true
    expect(node.marchNode.bsm).toBe(true)
    node.updateBefore(frame)
    expect(shadowUpdate).toHaveBeenCalledTimes(1)
    node.dispose()
  })

  test('maps autoUpdate false to explicit shadow dispatch', () => {
    const node = new CloudsNode(undefined, { shadows: { autoUpdate: false } })
    expect(node.shadowDispatchMode).toBe('explicit')
    node.dispose()
  })

  test('synchronizes custom layer channels with both march passes', () => {
    const node = new CloudsNode()

    node.setCloudLayers([
      { channel: 'a', altitude: 1000, height: 100 },
      { channel: 'b', altitude: 2000, height: 200 },
      { channel: 'g', altitude: 3000, height: 300 },
      { channel: 'r', altitude: 4000, height: 400 }
    ])

    expect(node.cloudLayers.localWeatherChannels).toBe('abgr')
    expect(node.shadowNode.localWeatherChannels).toBe('abgr')
    expect(node.marchNode.localWeatherChannels).toBe('abgr')
    expect(node.layerUniforms.minHeight.value).toBe(1000)
    expect(node.layerUniforms.maxHeight.value).toBe(4400)
    node.dispose()
  })

  test('exposes the shadow length as the vec2 the atmosphere expects', () => {
    const node = new CloudsNode()
    // SkyNode/AerialPerspectiveNode consume vec2(shadowLength, distance from
    // the camera to the shadowed segment). A float would silently be read as
    // (L, L) because swizzles on floats are no-ops.
    expect(node.getShadowLengthNode().getNodeType(createBuilder())).toBe('vec2')
    node.dispose()
  })

  test('lets the shadow map far follow the camera far by default', () => {
    const node = new CloudsNode()
    // Like the WebGL CascadedShadowMaps default (maxFar: null), the library
    // does not impose a far cap; integrations set shadowMaps.maxFar
    // themselves when needed:
    expect(node.shadowMaps.maxFar).toBeNull()
    node.shadowMaps.update(
      new PerspectiveCamera(75, 1, 1, 4e5),
      new Vector3(0, 0, 1)
    )
    expect(node.shadowMaps.far).toBe(4e5)
    node.dispose()
  })

  test('applies the shadow maxFar option', () => {
    const node = new CloudsNode(undefined, { shadows: { maxFar: 2e5 } })
    expect(node.shadowMaps.maxFar).toBe(2e5)
    node.shadowMaps.update(
      new PerspectiveCamera(75, 1, 1, 4e5),
      new Vector3(0, 0, 1)
    )
    expect(node.shadowMaps.far).toBe(2e5)
    node.dispose()
  })

  test('preserves an assigned procedural STBN node', () => {
    const node = new CloudsNode()
    const stbn = new CloudShapeDetailNode()

    node.stbnTexture = stbn

    expect(node.stbnTexture).toBe(stbn)
    node.dispose()
    stbn.dispose()
  })
})
