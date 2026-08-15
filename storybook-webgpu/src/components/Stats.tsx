import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef, useState, type FC } from 'react'


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

const PerformancePanel: FC<{ renderer: any }> = ({ renderer }) => {
  const [metrics, setMetrics] = useState(EMPTY_METRICS)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const lastFrame = useRef(0)
  const lastUpdate = useRef(0)
  const samples = useRef<number[]>([])
  const computeSamples = useRef<number[]>([])
  const renderSamples = useRef<number[]>([])

  useFrame(() => {
    const now = performance.now()
    if (lastFrame.current > 0) {
      const frameMs = now - lastFrame.current
      samples.current.push(frameMs)
      if (samples.current.length > 240) samples.current.shift()
    }
    lastFrame.current = now

    const renderInfo = renderer.info?.render as { timestamp?: number }
    if (
      typeof renderInfo.timestamp === 'number' &&
      (!Number.isFinite(renderInfo.timestamp) || renderInfo.timestamp < 0 || renderInfo.timestamp > 1000)
    ) {
      renderInfo.timestamp = 0
    }
    const renderTimestamp = renderInfo.timestamp
    const computeTimestamp = renderer.info?.compute?.timestamp
    if (typeof renderTimestamp === 'number' && Number.isFinite(renderTimestamp) && renderTimestamp > 0 && renderTimestamp < 1000) {
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
  }, 2)

  useEffect(() => {
    const panel = document.createElement('div')
    panel.style.cssText = 'position:fixed;top:18px;right:18px;width:348px;z-index:10000;overflow:hidden;border:1px solid rgba(198,232,220,.45);border-radius:14px;background:rgba(5,31,37,.9);color:#edf3db;box-shadow:0 10px 28px rgba(0,0,0,.22);pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace'
    panelRef.current = panel
    document.body.appendChild(panel)
    return () => {
      panel.remove()
      panelRef.current = null
    }
  }, [])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const cells: Array<[string, string]> = [
      ['三角形数', formatCount(metrics.triangles)],
      ['近岸状态', `${formatCount(metrics.textures)} 纹理`],
      ['模拟', `${metrics.computeCalls} 个计算步`],
      ['场景捕获', `${metrics.renderCalls} 次共享`],
      ['扰动数', '0'],
      ['帧率 / 平均', `${metrics.fps.toFixed(0)} · ${metrics.mean.toFixed(2)}ms`],
      ['P95 / P99', `${metrics.p95.toFixed(2)} · ${metrics.p99.toFixed(2)}ms`],
      ['最大 / 卡顿', `${metrics.max.toFixed(2)} · ${metrics.hitches}`],
      ['JS 提交', `${metrics.submit.toFixed(3)}ms`],
      ['GPU 模拟', metrics.gpuCompute == null ? '—' : `${metrics.gpuCompute.toFixed(3)}ms`],
      ['GPU 渲染', metrics.gpuRender == null ? '—' : `${metrics.gpuRender.toFixed(2)}ms`]
    ]
    panel.innerHTML = `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr))">${cells.map(([label, value]) => `<div style="padding:10px 12px;background:rgba(5,31,37,.76);border-right:1px solid rgba(198,232,220,.22);border-bottom:1px solid rgba(198,232,220,.22)"><div style="color:rgba(219,237,222,.55);font-size:10px;letter-spacing:.06em">${label}</div><div style="color:#edf3db;font-size:13px;margin-top:2px;font-variant-numeric:tabular-nums">${value}</div></div>`).join('')}<div style="background:rgba(80,151,156,.45)"></div></div>`
  }, [metrics])

  return null
}

export const Stats: FC = () => {
  const renderer = useThree(({ gl }) => gl)

  return <PerformancePanel renderer={renderer} />
}
