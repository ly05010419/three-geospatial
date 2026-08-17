import { Object3D } from 'three'
import { float } from 'three/tsl'
import { NodeBuilder, type JoinNode, type VarNode } from 'three/webgpu'

import { shadowLengthFromCamera, shadowLengthToPoint } from './shadowLength'

// NodeBuilder is declared abstract in the typings, but its constructor is
// enough for resolving node types without a renderer.
const createBuilder = (): NodeBuilder =>
  new (NodeBuilder as unknown as new (
    object: Object3D,
    renderer: unknown,
    parser: unknown
  ) => NodeBuilder)(new Object3D(), {}, null)

interface ConstLike {
  isConstNode?: boolean
  value?: unknown
}

// vec2() returns a VarNode intent wrapping the JoinNode of its components.
const getComponents = (
  node: unknown
): Array<JoinNode['nodes'][number] & ConstLike> =>
  ((node as VarNode).node as JoinNode).nodes

describe('shadowLengthFromCamera', () => {
  test('returns a vec2 whose shadowed segment starts at the camera', () => {
    const builder = createBuilder()
    const node = shadowLengthFromCamera(float(1))
    expect(node.getNodeType(builder)).toBe('vec2')

    const [length, start] = getComponents(node)
    expect(length.getNodeType(builder)).toBe('float')
    expect(start.isConstNode).toBe(true)
    expect(start.value).toBe(0)
  })
})

describe('shadowLengthToPoint', () => {
  test('returns a vec2 ending the shadowed segment at the point', () => {
    const builder = createBuilder()
    const node = shadowLengthToPoint(float(3), float(10))
    expect(node.getNodeType(builder)).toBe('vec2')

    const [length, start] = getComponents(node)
    expect(length.getNodeType(builder)).toBe('float')
    expect(start.getNodeType(builder)).toBe('float')
    // The start is derived from the distance, not a constant:
    expect(start.isConstNode).toBeFalsy()
  })
})
