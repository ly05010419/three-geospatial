import { addAfterEffect, useThree } from '@react-three/fiber'
import { useEffect, type FC } from 'react'
import StatsImpl from 'stats-gl'

import type { RendererArgs } from '../controls/rendererControls'
import { useControl } from '../hooks/useControl'

export const Stats: FC = () => {
  const show = useControl(({ showStats }: RendererArgs) => showStats)
  const renderer = useThree(({ gl }) => gl)

  useEffect(() => {
    if (!show) {
      return
    }
    const stats = new StatsImpl({
      trackGPU: true,
      trackCPT: true,
      horizontal: false
    })
    let removeAfterEffect: (() => void) | undefined
    stats
      .init(renderer)
      .then(() => {
        removeAfterEffect = addAfterEffect(() => {
          // Some WebGPU implementations can return a wrapped/non-monotonic
          // render timestamp while the query buffer is being resolved. Never
          // expose that as a negative or multi-second GPU time in the panel.
          const renderInfo = renderer.info?.render as typeof renderer.info.render & {
            timestamp?: number
          }
          const renderTimestamp = renderInfo?.timestamp
          if (
            typeof renderTimestamp === 'number' &&
            (!Number.isFinite(renderTimestamp) ||
              renderTimestamp < 0 ||
              renderTimestamp > 1000)
          ) {
            renderInfo.timestamp = 0
          }
          stats.update()
        })
      })
      .catch((error: unknown) => {
        console.error(error)
      })

    document.body.appendChild(stats.dom)
    return () => {
      removeAfterEffect?.()
      document.body.removeChild(stats.dom)
    }
  }, [show, renderer])

  return null
}
