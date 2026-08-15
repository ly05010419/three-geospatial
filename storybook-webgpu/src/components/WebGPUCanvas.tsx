import styled from '@emotion/styled'
import { Canvas, type CanvasProps } from '@react-three/fiber'
import { atom, useAtomValue } from 'jotai'
import { useCallback, useEffect, useRef, type FC, type MouseEvent } from 'react'
import { WebGPURenderer, type Renderer } from 'three/webgpu'

import type { RendererArgs } from '../controls/rendererControls'
import {
  AgXPunchyToneMapping,
  agxPunchyToneMapping
} from '../helpers/AgxToneMapping'
import { useControl } from '../hooks/useControl'
import { Stats } from './Stats'

export const availableAtom = atom(
  async () =>
    typeof navigator !== 'undefined' &&
    navigator.gpu !== undefined &&
    (await navigator.gpu.requestAdapter()) != null
)

const MessageElement = styled('div')`
  position: absolute;
  top: 16px;
  right: 16px;
  left: 16px;
  color: white;
  font-size: small;
  letter-spacing: 0.02em;
  text-align: center;
`

const Message: FC<{ forceWebGL: boolean }> = ({ forceWebGL }) => {
  const available = useAtomValue(availableAtom)
  if (!available) {
    return (
      <MessageElement>
        Your browser does not support WebGPU yet. Running under WebGL2 as a
        fallback.
      </MessageElement>
    )
  }
  if (forceWebGL) {
    return <MessageElement>Running under WebGL2.</MessageElement>
  }
  return null
}

export interface WebGPUCanvasProps extends Omit<CanvasProps, 'gl'> {
  renderer?: ConstructorParameters<typeof WebGPURenderer>[0] & {
    onInit?: (renderer: WebGPURenderer) => void | Promise<void>
  }
}

export const WebGPUCanvas: FC<WebGPUCanvasProps> = ({
  renderer: { onInit, ...otherProps } = {},
  children,
  onClick,
  style,
  ...canvasProps
}) => {
  const available = useAtomValue(availableAtom)
  let forceWebGL = useControl(({ forceWebGL }: RendererArgs) => forceWebGL)
  forceWebGL ||= !available
  const pixelRatio = useControl(({ pixelRatio }: RendererArgs) => pixelRatio)
  const frameloop = useControl(({ frameloop }: RendererArgs) => frameloop)

  const ref = useRef<Renderer>(null)
  useEffect(() => {
    return () => {
      // WORKAROUND: Renderer won't be disposed when used in Storybook.
      setTimeout(() => {
        ref.current?.dispose()
      }, 500)
    }
  }, [])

  // Focus the iframe in Storybook so that keyboard events can be captured.
  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      window.focus()
      onClick?.(event)
    },
    [onClick]
  )

  return (
    <>
      <Canvas
        key={forceWebGL ? 'webgl' : 'webgpu'}
        frameloop={frameloop}
        {...canvasProps}
        style={{
          width: '100%',
          height: '100%',
          ...style
        }}
        gl={async props => {
          const renderer = new WebGPURenderer({
            ...(props as any),
            ...otherProps,
            forceWebGL,
            // Stats-gl can only report GPU/CPT timings when Three creates its
            // timestamp query pool during renderer initialization. Enabling
            // this before init is required; setting backend.trackTimestamp
            // afterward is too late for the pool to exist.
            trackTimestamp: otherProps.trackTimestamp ?? true
          })
          ref.current = renderer
          await renderer.init()

          // Require the model-view matrix premultiplied on the CPU side.
          // See: https://github.com/mrdoob/three.js/issues/30955
          renderer.highPrecision = true

          // Add extra variations for AgX tone mapping.
          renderer.library.addToneMapping(
            agxPunchyToneMapping,
            AgXPunchyToneMapping
          )

          await onInit?.(renderer)
          return renderer
        }}
        dpr={pixelRatio}
        onClick={handleClick}
      >
        {children}
        <Stats />
      </Canvas>
      <Message forceWebGL={forceWebGL} />
    </>
  )
}
