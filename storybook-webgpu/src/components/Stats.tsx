import { addAfterEffect, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type FC } from 'react'
import { Html } from '@react-three/drei'
import StatsImpl from 'stats-gl'

import type { RendererArgs } from '../controls/rendererControls'
import { useControl } from '../hooks/useControl'

type Metrics = {
  triangles: number
  textures: number
  computeCalls: number
  renderCalls: number
  fps: number
  mean: number
  p95: number
  p99: number
  max: number
  hitches: number
  submit: number
  gpuCompute: number | null
  gpuRender: number | null
}

const EMPTY_METRICS: Metrics = {
  triangles: 0,
  textures: 0,
  computeCalls: 0,
  renderCalls: 0,
  fps: 0,
  mean: 0,
  p95: 0,
  p99: 0,
  max: 0,
  hitches: 0,
  submit: 0,
  gpuCompute: null,
  gpuRender: null
}

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

const formatCount = (value: number): string =>
  new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(value)))

const MetricCell: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{ padding: '10px 12px', background: 'rgba(5, 31, 37, 0.76)', borderRight: '1px solid rgba(198, 232, 220, 0.22)', borderBottom: '1px solid rgba(198, 232, 220, 0.22)' }}>
    <div style={{ color: 'rgba(219, 237, 222, 0.55)', fontSize: 10, letterSpacing: '0.06em' }}>{label}</div>
    <div style={{ color: '#edf3db', fontSize: 13, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{value}</div>
  </div>
)

const PerformancePanel: FC<{ renderer: any; show: boolean }> = ({ renderer, show }) => {
  const [metrics, setMetrics] = useState(EMPTY_METRICS)
  const lastFrame = useRef(0)
  const lastUpdate = useRef(0)
  const samples = useRef<number[]>([])
  const computeSamples = useRef<number[]>([])
  const renderSamples = useRef<number[]>([])

  useFrame(() => {
    if (!show) return
    const now = performance.now()
    if (lastFrame.current > 0) {
      const frameMs = now - lastFrame.current
      samples.current.push(frameMs)
      if (samples.current.length > 240) samples.current.shift()
    }
    lastFrame.current = now

    const renderTimestamp = renderer.info?.render?.timestamp
    const computeTimestamp = renderer.info?.compute?.timestamp
    if (Number.isFinite(renderTimestamp) && renderTimestamp > 0 && renderTimestamp < 1000) {
      renderSamples.current.push(renderTimestamp)
      if (renderSamples.current.length > 120) renderSamples.current.shift()
    }
    if (Number.isFinite(computeTimestamp) && computeTimestamp > 0 && computeTimestamp < 1000) {
      computeSamples.current.push(computeTimestamp)
      if (computeSamples.current.length > 120) computeSamples.current.shift()
    }

    if (now - lastUpdate.current < 250) return
    lastUpdate.current = now
    const frameSamples = samples.current
    const mean = frameSamples.length ? frameSamples.reduce((sum, value) => sum + value, 0) / frameSamples.length : 0
    setMetrics({
      triangles: renderer.info?.render?.triangles ?? 0,
      textures: renderer.info?.memory?.textures ?? 0,
      computeCalls: renderer.info?.compute?.calls ?? 0,
      renderCalls: renderer.info?.render?.calls ?? 0,
      fps: mean > 0 ? 1000 / mean : 0,
      mean,
      p95: percentile(frameSamples, 0.95),
      p99: percentile(frameSamples, 0.99),
      max: frameSamples.length ? Math.max(...frameSamples) : 0,
      hitches: frameSamples.filter(value => value > 50).length,
      submit: mean,
      gpuCompute: computeSamples.current.length ? computeSamples.current.at(-1) ?? null : null,
      gpuRender: renderSamples.current.length ? renderSamples.current.at(-1) ?? null : null
    })
  })

  if (!show) return null
  const cellStyle = { borderRight: '1px solid rgba(198, 232, 220, 0.22)', borderBottom: '1px solid rgba(198, 232, 220, 0.22)' }
  return (
    <Html fullscreen style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'fixed', top: 18, right: 18, width: 348, zIndex: 10000, overflow: 'hidden', border: '1px solid rgba(198, 232, 220, 0.45)', borderRadius: 14, background: 'rgba(5, 31, 37, 0.9)', color: '#edf3db', boxShadow: '0 10px 28px rgba(0,0,0,0.22)', pointerEvents: 'none' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <MetricCell label="三角形数" value={formatCount(metrics.triangles)} />
        <MetricCell label="近岸状态" value={`${formatCount(metrics.textures)} 纹理`} />
        <MetricCell label="模拟" value={`${metrics.computeCalls} 个计算步`} />
        <MetricCell label="场景捕获" value={`${metrics.renderCalls} 次共享`} />
        <MetricCell label="扰动数" value="0" />
        <MetricCell label="帧率 / 平均" value={`${metrics.fps.toFixed(0)} · ${metrics.mean.toFixed(2)}ms`} />
        <MetricCell label="P95 / P99" value={`${metrics.p95.toFixed(2)} · ${metrics.p99.toFixed(2)}ms`} />
        <MetricCell label="最大 / 卡顿" value={`${metrics.max.toFixed(2)} · ${metrics.hitches}`} />
        <MetricCell label="JS 提交" value={`${metrics.submit.toFixed(3)}ms`} />
        <MetricCell label="GPU 模拟" value={metrics.gpuCompute == null ? '—' : `${metrics.gpuCompute.toFixed(3)}ms`} />
        <div style={{ ...cellStyle, borderBottom: 0 }}><div style={{ color: 'rgba(219, 237, 222, 0.55)', fontSize: 10 }}>GPU 渲染</div><div style={{ color: '#edf3db', fontSize: 13, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{metrics.gpuRender == null ? '—' : `${metrics.gpuRender.toFixed(2)}ms`}</div></div>
        <div style={{ background: 'rgba(80, 151, 156, 0.45)' }} />
      </div>
      </div>
    </Html>
  )
}

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

  return <PerformancePanel renderer={renderer} show={show} />
}
