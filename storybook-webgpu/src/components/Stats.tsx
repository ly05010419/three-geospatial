import { useThree } from '@react-three/fiber'
import { useEffect, useRef, type FC } from 'react'

interface RendererInfoLike {
  render?: {
    timestamp?: number
    triangles?: number
    frameCalls?: number
  }
  compute?: {
    timestamp?: number
    frameCalls?: number
  }
  memory?: {
    textures?: number
  }
}

interface TimestampQueryPoolLike {
  frames?: number[]
  timestamps?: Iterable<readonly [string, number]>
}

interface RendererLike {
  info?: RendererInfoLike
  backend?: unknown
  resolveTimestampsAsync?: (type?: 'render' | 'compute') => Promise<unknown>
  __cloudsPerformance?: {
    submitMs?: number
    gpuQueueMs?: number
  }
}

interface Metrics {
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
  gpuQueue: number | null
}

// A cloud frame can contain many render contexts. Filter impossible individual
// query values in resolveCloudsTimestamps(), but allow their aggregate to exceed
// one second so a slow Custom Layers frame is reported instead of shown as —.
const MAX_FRAME_TIMESTAMP_MS = 10_000

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ]
}

const formatCount = (value: number): string =>
  new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(value)))

/**
 * Resolve Three's WebGPU timestamp pools and repair invalid query pairs. Three
 * allocates one pair per render context, so the public render timestamp is the
 * sum of all valid contexts in the latest frame.
 */
export const resolveCloudsTimestamps = async (
  renderer: RendererLike
): Promise<void> => {
  if (typeof renderer.resolveTimestampsAsync !== 'function') return

  try {
    await Promise.all([
      renderer.resolveTimestampsAsync('render'),
      renderer.resolveTimestampsAsync('compute')
    ])

    const backend = renderer.backend as
      | {
          timestampQueryPool?: {
            render?: TimestampQueryPoolLike
          }
        }
      | undefined
    const pool = backend?.timestampQueryPool?.render
    const frame = pool?.frames?.at(-1)
    const timestamps = pool?.timestamps
    if (frame == null || timestamps == null) return

    let duration = 0
    for (const [uid, value] of timestamps) {
      if (!uid.endsWith(`:f${frame}`)) continue
      if (Number.isFinite(value) && value >= 0 && value < 1000) {
        duration += value
      }
    }

    if (duration > 0 && renderer.info?.render != null) {
      renderer.info.render.timestamp = duration
    }
  } catch {
    // Timestamp queries are optional diagnostics and must never break a frame.
  }
}

const createPerformanceSampler = (
  renderer: RendererLike
): { sample: (now: number) => Metrics | null } => {
  let lastFrame = 0
  let lastUpdate = 0
  let lastComputeTimestamp: number | null = null
  let lastRenderTimestamp: number | null = null
  const samples: number[] = []
  const computeSamples: number[] = []
  const renderSamples: number[] = []

  return {
    sample(now: number): Metrics | null {
      if (lastFrame > 0) {
        const frameMs = now - lastFrame
        samples.push(frameMs)
        if (samples.length > 240) samples.shift()
      }
      lastFrame = now

      const renderInfo = renderer.info?.render
      if (
        typeof renderInfo?.timestamp === 'number' &&
        (!Number.isFinite(renderInfo.timestamp) ||
          renderInfo.timestamp < 0 ||
          renderInfo.timestamp > MAX_FRAME_TIMESTAMP_MS)
      ) {
        renderInfo.timestamp = 0
      }

      const renderTimestamp = renderInfo?.timestamp
      const computeTimestamp = renderer.info?.compute?.timestamp
      if (
        typeof renderTimestamp === 'number' &&
        Number.isFinite(renderTimestamp) &&
        renderTimestamp > 0 &&
        renderTimestamp < MAX_FRAME_TIMESTAMP_MS &&
        lastRenderTimestamp !== renderTimestamp
      ) {
        renderSamples.push(renderTimestamp)
        if (renderSamples.length > 120) renderSamples.shift()
        lastRenderTimestamp = renderTimestamp
      }
      if (
        typeof computeTimestamp === 'number' &&
        Number.isFinite(computeTimestamp) &&
        computeTimestamp > 0 &&
        computeTimestamp < 1000 &&
        lastComputeTimestamp !== computeTimestamp
      ) {
        computeSamples.push(computeTimestamp)
        if (computeSamples.length > 120) computeSamples.shift()
        lastComputeTimestamp = computeTimestamp
      }

      if (now - lastUpdate < 250) return null
      lastUpdate = now

      const mean =
        samples.length > 0
          ? samples.reduce((sum, value) => sum + value, 0) / samples.length
          : 0
      const performanceMetrics = renderer.__cloudsPerformance
      const average = (values: number[]): number | null =>
        values.length > 0
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null

      return {
        triangles: renderer.info?.render?.triangles ?? 0,
        textures: renderer.info?.memory?.textures ?? 0,
        computeCalls: renderer.info?.compute?.frameCalls ?? 0,
        renderCalls: renderer.info?.render?.frameCalls ?? 0,
        fps: mean > 0 ? 1000 / mean : 0,
        mean,
        p95: percentile(samples, 0.95),
        p99: percentile(samples, 0.99),
        max: samples.length > 0 ? Math.max(...samples) : 0,
        hitches: samples.filter(value => value > 50).length,
        submit:
          typeof performanceMetrics?.submitMs === 'number' &&
          Number.isFinite(performanceMetrics.submitMs)
            ? performanceMetrics.submitMs
            : mean,
        gpuCompute: average(computeSamples),
        gpuRender: average(renderSamples),
        gpuQueue:
          typeof performanceMetrics?.gpuQueueMs === 'number' &&
          Number.isFinite(performanceMetrics.gpuQueueMs)
            ? performanceMetrics.gpuQueueMs
            : null
      }
    }
  }
}

const renderPanel = (panel: HTMLDivElement, metrics: Metrics): void => {
  const cells: Array<[string, string]> = [
    ['绘制三角形', formatCount(metrics.triangles)],
    ['纹理资源', `${formatCount(metrics.textures)} 个`],
    ['计算 pass', `${metrics.computeCalls} 个`],
    ['渲染 pass', `${metrics.renderCalls} 个`],
    ['扰动数', '0'],
    ['帧率 / 平均', `${metrics.fps.toFixed(0)} · ${metrics.mean.toFixed(2)}ms`],
    ['P95 / P99', `${metrics.p95.toFixed(2)} · ${metrics.p99.toFixed(2)}ms`],
    ['最大 / 卡顿', `${metrics.max.toFixed(2)} · ${metrics.hitches}`],
    ['JS 提交', `${metrics.submit.toFixed(3)}ms`],
    [
      'GPU 模拟',
      metrics.gpuCompute == null ? '—' : `${metrics.gpuCompute.toFixed(3)}ms`
    ],
    [
      'GPU 渲染合计',
      metrics.gpuRender == null ? '—' : `${metrics.gpuRender.toFixed(2)}ms`
    ],
    [
      'GPU 队列完成',
      metrics.gpuQueue == null ? '—' : `${metrics.gpuQueue.toFixed(2)}ms`
    ]
  ]

  panel.innerHTML = `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr))">${cells.map(([label, value]) => `<div style="padding:10px 12px;background:rgba(5,31,37,.76);border-right:1px solid rgba(198,232,220,.22);border-bottom:1px solid rgba(198,232,220,.22)"><div style="color:rgba(219,237,222,.55);font-size:10px;letter-spacing:.06em">${label}</div><div style="color:#edf3db;font-size:13px;margin-top:2px;font-variant-numeric:tabular-nums">${value}</div></div>`).join('')}<div style="background:rgba(80,151,156,.45)"></div></div>`
}

const mountPanel = (renderer: RendererLike): { dispose: () => void } => {
  const panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;top:18px;right:18px;width:348px;z-index:10000;overflow:hidden;border:1px solid rgba(198,232,220,.45);border-radius:14px;background:rgba(5,31,37,.9);color:#edf3db;box-shadow:0 10px 28px rgba(0,0,0,.22);pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace'
  document.body.appendChild(panel)

  const sampler = createPerformanceSampler(renderer)
  let animationFrame = 0
  const tick = (now: number): void => {
    const metrics = sampler.sample(now)
    if (metrics != null) renderPanel(panel, metrics)
    animationFrame = requestAnimationFrame(tick)
  }
  animationFrame = requestAnimationFrame(tick)

  return {
    dispose: () => {
      cancelAnimationFrame(animationFrame)
      panel.remove()
    }
  }
}

/** Mount the same metrics panel for a non-R3F Three.js demo. */
export const createPerformancePanel = mountPanel

export const Stats: FC<{ enabled?: boolean }> = ({ enabled = true }) => {
  const renderer = useThree(({ gl }) => gl as RendererLike)
  const panelRef = useRef<{ dispose: () => void } | null>(null)

  useEffect(() => {
    if (!enabled) {
      panelRef.current = null
      return
    }
    panelRef.current = mountPanel(renderer)
    return () => {
      panelRef.current?.dispose()
      panelRef.current = null
    }
  }, [enabled, renderer])

  return null
}
