import { Color, NoToneMapping, SRGBColorSpace, type RenderTarget } from 'three'
import type { NodeFrame, Renderer } from 'three/webgpu'

import { CloudsNode } from './CloudsNode'

interface ClearRecord {
  target: RenderTarget | null
  alpha: number
}

// A minimal stand-in for the WebGPU renderer covering what
// RendererUtils.saveRendererState/resetRendererState/restoreRendererState and
// CloudsResolveNode.update() touch. It tracks the clear color/alpha exactly
// like Renderer.setClearColor/getClearAlpha and records the alpha in effect at
// every clear() call.
const createFakeRenderer = (
  initialClearAlpha: number
): { renderer: Renderer; clears: ClearRecord[]; renders: ClearRecord[] } => {
  const clearColor = new Color(0x000000)
  let clearAlpha = initialClearAlpha
  let renderTarget: RenderTarget | null = null
  const clears: ClearRecord[] = []
  const renders: ClearRecord[] = []
  const renderer = {
    toneMapping: NoToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: SRGBColorSpace,
    autoClear: true,
    getRenderTarget: () => renderTarget,
    setRenderTarget: (target: RenderTarget | null) => {
      renderTarget = target
    },
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getRenderObjectFunction: () => null,
    setRenderObjectFunction: () => {},
    getPixelRatio: () => 1,
    setPixelRatio: () => {},
    getMRT: () => null,
    setMRT: () => {},
    getClearColor: (target: Color) => target.copy(clearColor),
    setClearColor: (color: Color | number, alpha = 1) => {
      clearColor.set(color)
      clearAlpha = alpha
    },
    getClearAlpha: () => clearAlpha,
    getScissorTest: () => false,
    setScissorTest: () => {},
    clear: () => {
      clears.push({ target: renderTarget, alpha: clearAlpha })
    },
    render: () => {
      renders.push({ target: renderTarget, alpha: clearAlpha })
    }
  }
  return { renderer: renderer as unknown as Renderer, clears, renders }
}

describe('CloudsResolveNode', () => {
  test('clears the resolve and history targets to alpha 0', () => {
    const node = new CloudsNode()
    const { renderer, clears, renders } = createFakeRenderer(0.75)

    node.resolveNode.setSize(8, 8)
    node.resolveNode.update({ renderer } as unknown as NodeFrame)

    // Both the resolve and the history targets are cleared:
    expect(clears).toHaveLength(2)
    expect(clears[0].target).not.toBeNull()
    expect(clears[1].target).not.toBeNull()
    expect(clears[0].target).not.toBe(clears[1].target)

    // The clouds output is premultiplied (alpha = coverage). Clearing the
    // history to opaque black would composite a black frame over the scene
    // until the temporal history has converged:
    expect(clears.map(({ alpha }) => alpha)).toEqual([0, 0])

    // The resolve pass itself renders with the resetRendererState() default
    // into the resolve target, and the renderer state is restored afterwards:
    expect(renders).toHaveLength(1)
    expect(renders[0].alpha).toBe(1)
    expect(renders[0].target).toBe(clears[0].target)
    expect(renderer.getClearAlpha()).toBe(0.75)
    node.dispose()
  })

  test('does not clear again until the history is reset', () => {
    const node = new CloudsNode()
    const { renderer, clears } = createFakeRenderer(1)

    node.resolveNode.setSize(8, 8)
    node.resolveNode.update({ renderer } as unknown as NodeFrame)
    node.resolveNode.update({ renderer } as unknown as NodeFrame)
    expect(clears).toHaveLength(2)

    node.resolveNode.resetHistory()
    node.resolveNode.update({ renderer } as unknown as NodeFrame)
    expect(clears).toHaveLength(4)
    expect(clears.map(({ alpha }) => alpha)).toEqual([0, 0, 0, 0])
    node.dispose()
  })
})
