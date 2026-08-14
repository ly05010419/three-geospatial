import { Vector2 } from 'three'
import { NodeFrame } from 'three/webgpu'

import { CloudShapeDetailNode } from './CloudShapeDetailNode'
import { CloudsNode } from './CloudsNode'

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

  test('preserves an assigned procedural STBN node', () => {
    const node = new CloudsNode()
    const stbn = new CloudShapeDetailNode()

    node.stbnTexture = stbn

    expect(node.stbnTexture).toBe(stbn)
    node.dispose()
    stbn.dispose()
  })
})
