import { Vector2 } from 'three'

import { CloudShapeDetailNode } from './CloudShapeDetailNode'
import { CloudsNode } from './CloudsNode'

describe('CloudsNode', () => {
  test('keeps the shadow producer and consumer cascade counts in sync', () => {
    const node = new CloudsNode()

    node.qualityPreset = 'low'

    expect(node.qualityPreset).toBe('low')
    expect(node.shadowNode.cascadeCount).toBe(2)
    expect(node.marchNode.shadowCascadeCount).toBe(2)
    expect(node.shadowMaps.mapSize).toEqual(new Vector2(256, 256))
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
