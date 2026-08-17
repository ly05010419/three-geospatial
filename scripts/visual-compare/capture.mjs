#!/usr/bin/env node
// capture.mjs — screenshot a Storybook story with headless Chrome once its
// temporal rendering has settled. Node 22 ESM, zero dependencies: talks to
// Chrome DevTools Protocol (CDP) with the global `fetch` + `WebSocket`.
//
// Usage:
//   node capture.mjs --url <URL> --out <file.png> [--width 1600] [--height 900] [--dpr 1]
//     [--settle-frames 240] [--min-seconds 15] [--max-seconds 300]
//     [--wait-gone <css selector>] [--press-key <key>] [--canvas-out <file.png>]
//     [--log <file.log>] [--chrome-flag <flag>]...
//
// Exit codes: 0 success, 1 failure, 2 usage error, 3 settle timeout
// (on timeout the current frame is still written to <out>.timeout.png).

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CHROME_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT_RANGE = { min: 9300, max: 9900 }
const PORT_ATTEMPTS = 20
const DEVTOOLS_STARTUP_TIMEOUT_MS = 30_000
const DEVTOOLS_POLL_MS = 200
const READY_POLL_MS = 500
const PROGRESS_EVERY_POLLS = 20 // one stderr progress line every 10 s
const POST_KEY_DELAY_MS = 1000
const CDP_TIMEOUT_MS = 60_000
const PAGE_LOAD_TIMEOUT_MS = 120_000
const EXIT_OK = 0
const EXIT_FAILURE = 1
const EXIT_USAGE = 2
const EXIT_TIMEOUT = 3

const DEFAULTS = {
  width: 1600,
  height: 900,
  dpr: 1,
  settleFrames: 240,
  minSeconds: 15,
  maxSeconds: 300
}

// flag -> [option key, type]. `list` flags may be repeated.
const FLAG_SPEC = {
  '--url': ['url', 'string'],
  '--out': ['out', 'string'],
  '--width': ['width', 'int'],
  '--height': ['height', 'int'],
  '--dpr': ['dpr', 'number'],
  '--settle-frames': ['settleFrames', 'int'],
  '--min-seconds': ['minSeconds', 'number'],
  '--max-seconds': ['maxSeconds', 'number'],
  '--wait-gone': ['waitGone', 'string'],
  '--press-key': ['pressKey', 'string'],
  '--canvas-out': ['canvasOut', 'string'],
  '--log': ['log', 'string'],
  '--chrome-flag': ['chromeFlags', 'list']
}

const USAGE = `usage: node capture.mjs --url <URL> --out <file.png>
  [--width ${DEFAULTS.width}] [--height ${DEFAULTS.height}] [--dpr ${DEFAULTS.dpr}]
  [--settle-frames ${DEFAULTS.settleFrames}] [--min-seconds ${DEFAULTS.minSeconds}] [--max-seconds ${DEFAULTS.maxSeconds}]
  [--wait-gone <css selector>]   wait until no element matches (e.g. '.ant-progress')
  [--press-key <key>]            key pressed on <body> after readiness (e.g. 'h')
  [--canvas-out <file.png>]      also save canvas.toDataURL('image/png')
  [--log <file.log>]             console/exception log (default <out>.log)
  [--chrome-flag <flag>]...      extra Chrome flags (repeatable)`

class UsageError extends Error {}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const info = message => process.stderr.write(`[capture] ${message}\n`)

// --------------------------------------------------------------------------- CLI

function coerceValue(flag, raw, type, previous) {
  if (type === 'string') return raw
  if (type === 'list') return [...previous, raw]
  const value = Number(raw)
  const valid = Number.isFinite(value) && (type !== 'int' || Number.isInteger(value)) && value > 0
  if (!valid) throw new UsageError(`${flag} expects a positive ${type}, got '${raw}'`)
  return value
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return null
  let opts = { ...DEFAULTS, chromeFlags: [] }
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, raw] = [argv[i], argv[i + 1]]
    const spec = FLAG_SPEC[flag]
    if (spec === undefined) throw new UsageError(`unknown flag '${flag}'`)
    if (raw === undefined) throw new UsageError(`${flag} needs a value`)
    const [key, type] = spec
    opts = { ...opts, [key]: coerceValue(flag, raw, type, opts[key]) }
  }
  if (opts.url === undefined) throw new UsageError('--url is required')
  if (opts.out === undefined) throw new UsageError('--out is required')
  if (opts.minSeconds > opts.maxSeconds) throw new UsageError('--min-seconds must be <= --max-seconds')
  return { ...opts, log: opts.log ?? `${opts.out}.log` }
}

// --------------------------------------------------------------------------- log file

function createLogger(logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true })
  writeFileSync(logPath, '')
  const counters = { errors: 0 }
  return {
    path: logPath,
    write(level, source, text) {
      const line = `${new Date().toISOString()} [${level}] ${source}: ${text}\n`
      appendFileSync(logPath, line)
      if (level === 'error') counters.errors += 1
    },
    errorCount: () => counters.errors
  }
}

function formatRemoteObject(obj) {
  if (obj.type === 'string') return obj.value
  if (obj.value !== undefined) return JSON.stringify(obj.value)
  if (obj.preview?.properties !== undefined) {
    const props = obj.preview.properties.map(p => `${p.name}: ${p.value}`).join(', ')
    return `${obj.description ?? obj.type} {${props}}`
  }
  return obj.description ?? obj.type
}

function subscribeConsole(cdp, logger) {
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    const level = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : null
    if (level === null) return
    logger.write(level, 'console', args.map(formatRemoteObject).join(' '))
  })
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    const where = d.url ? ` (${d.url}:${d.lineNumber}:${d.columnNumber})` : ''
    logger.write('error', 'exception', `${d.exception?.description ?? d.text}${where}`)
  })
  cdp.on('Log.entryAdded', ({ entry }) => {
    const level = entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warning' : 'info'
    const where = entry.url ? ` (${entry.url}:${entry.lineNumber ?? 0})` : ''
    logger.write(level, `log/${entry.source}`, `${entry.text}${where}`)
  })
}

// --------------------------------------------------------------------------- Chrome

function isPortFree(port) {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function pickFreePort() {
  const span = PORT_RANGE.max - PORT_RANGE.min + 1
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const port = PORT_RANGE.min + Math.floor(Math.random() * span)
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port found in ${PORT_RANGE.min}-${PORT_RANGE.max} after ${PORT_ATTEMPTS} attempts`)
}

function launchChrome(opts, port, profileDir) {
  const args = [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    `--window-size=${opts.width},${opts.height}`,
    `--force-device-scale-factor=${opts.dpr}`,
    ...opts.chromeFlags,
    'about:blank'
  ]
  const child = spawn(CHROME_BINARY, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const stderr = { tail: '' }
  child.stderr.on('data', chunk => { stderr.tail = (stderr.tail + chunk).slice(-4000) })
  child.on('error', error => { stderr.tail += `\nspawn error: ${error.message}` })
  return { child, stderr }
}

async function waitForDevtools(port, chrome) {
  const deadline = Date.now() + DEVTOOLS_STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (chrome.child.exitCode !== null) {
      throw new Error(`Chrome exited early (code ${chrome.child.exitCode}). stderr tail:\n${chrome.stderr.tail}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch { /* not listening yet */ }
    await sleep(DEVTOOLS_POLL_MS)
  }
  throw new Error(`Chrome DevTools not reachable on port ${port} after ${DEVTOOLS_STARTUP_TIMEOUT_MS} ms. stderr tail:\n${chrome.stderr.tail}`)
}

async function createTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  if (!response.ok) throw new Error(`PUT /json/new failed: HTTP ${response.status}`)
  const target = await response.json()
  if (!target.webSocketDebuggerUrl) throw new Error(`/json/new returned no webSocketDebuggerUrl: ${JSON.stringify(target)}`)
  return target
}

// --------------------------------------------------------------------------- CDP client

function dispatchCdpMessage(state, message) {
  if (message.id !== undefined) {
    const pending = state.pending.get(message.id)
    if (pending === undefined) return
    state.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message}`))
    else pending.resolve(message.result)
    return
  }
  const handlers = state.listeners.get(message.method) ?? []
  for (const handler of handlers) handler(message.params ?? {})
}

function sendCdpCommand(ws, state, method, params) {
  return new Promise((resolve, reject) => {
    const id = state.nextId + 1
    state.nextId = id
    const timer = setTimeout(() => {
      state.pending.delete(id)
      reject(new Error(`CDP ${method} timed out after ${CDP_TIMEOUT_MS} ms`))
    }, CDP_TIMEOUT_MS)
    state.pending.set(id, { method, resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`WebSocket connection failed: ${wsUrl}`))
  })
  const state = { nextId: 0, pending: new Map(), listeners: new Map() }
  ws.onmessage = event => dispatchCdpMessage(state, JSON.parse(event.data))
  ws.onclose = () => {
    for (const { method, reject, timer } of state.pending.values()) {
      clearTimeout(timer)
      reject(new Error(`CDP socket closed while waiting for ${method}`))
    }
    state.pending.clear()
  }
  return {
    send: (method, params = {}) => sendCdpCommand(ws, state, method, params),
    on: (event, handler) => state.listeners.set(event, [...(state.listeners.get(event) ?? []), handler]),
    close: () => ws.close()
  }
}

function waitForEvent(cdp, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event} (${timeoutMs} ms)`)), timeoutMs)
    cdp.on(event, params => { clearTimeout(timer); resolve(params) })
  })
}

async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise
  })
  if (exceptionDetails !== undefined) {
    const detail = exceptionDetails.exception?.description ?? exceptionDetails.text
    throw new Error(`in-page evaluation failed: ${detail}`)
  }
  return result.value
}

// --------------------------------------------------------------------------- page driving

async function preparePage(cdp, opts, logger) {
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')
  subscribeConsole(cdp, logger)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: opts.width,
    height: opts.height,
    deviceScaleFactor: opts.dpr,
    mobile: false
  })
  const loaded = waitForEvent(cdp, 'Page.loadEventFired', PAGE_LOAD_TIMEOUT_MS)
  const navigation = await cdp.send('Page.navigate', { url: opts.url })
  if (navigation.errorText) throw new Error(`navigation to ${opts.url} failed: ${navigation.errorText}`)
  await loaded
  info(`page loaded: ${opts.url}`)
}

const FRAME_COUNTER_SCRIPT = `(() => {
  window.__vcFrames = 0;
  const tick = () => { window.__vcFrames += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return true;
})()`

function probeScript(waitGoneSelector) {
  const selector = JSON.stringify(waitGoneSelector ?? null)
  return `(() => {
    const canvas = document.querySelector('canvas');
    const selector = ${selector};
    return {
      frames: window.__vcFrames ?? 0,
      canvasWidth: canvas ? canvas.width : 0,
      canvasHeight: canvas ? canvas.height : 0,
      waitGoneSatisfied: selector === null || document.querySelector(selector) === null
    };
  })()`
}

function describeWait(opts, probe, ready) {
  if (ready === null) {
    const canvas = probe.canvasWidth > 0 && probe.canvasHeight > 0 ? 'canvas ok' : 'no canvas with non-zero size'
    const gone = probe.waitGoneSatisfied ? '' : `, '${opts.waitGone}' still present`
    return `not ready (${canvas}${gone}, frames=${probe.frames})`
  }
  const frames = probe.frames - ready.f0
  const seconds = ((Date.now() - ready.t0) / 1000).toFixed(1)
  return `settling: ${frames}/${opts.settleFrames} frames, ${seconds}/${opts.minSeconds} s since ready`
}

async function waitUntilSettled(cdp, opts) {
  const start = Date.now()
  let ready = null
  for (let poll = 0; ; poll++) {
    const probe = await evaluate(cdp, probeScript(opts.waitGone))
    const elapsedSeconds = (Date.now() - start) / 1000
    const isReady = probe.canvasWidth > 0 && probe.canvasHeight > 0 && probe.waitGoneSatisfied
    if (ready === null && isReady) {
      ready = { t0: Date.now(), f0: probe.frames }
      info(`ready after ${elapsedSeconds.toFixed(1)} s (canvas ${probe.canvasWidth}x${probe.canvasHeight}, frame ${probe.frames})`)
    }
    const settleFrames = ready === null ? 0 : probe.frames - ready.f0
    const settled = ready !== null && settleFrames >= opts.settleFrames && (Date.now() - ready.t0) / 1000 >= opts.minSeconds
    const result = { framesTotal: probe.frames, settleFrames, elapsedSeconds: Number(elapsedSeconds.toFixed(1)) }
    if (settled) return { ...result, timedOut: false }
    if (elapsedSeconds >= opts.maxSeconds) return { ...result, timedOut: true, reason: describeWait(opts, probe, ready) }
    if (poll % PROGRESS_EVERY_POLLS === 0) info(`${elapsedSeconds.toFixed(0)} s: ${describeWait(opts, probe, ready)}`)
    await sleep(READY_POLL_MS)
  }
}

async function pressKey(cdp, key) {
  // The story's hotkey handler checks `event.target === document.body`.
  await evaluate(cdp, 'document.activeElement && document.activeElement !== document.body && document.activeElement.blur(); true')
  const single = key.length === 1
  const keyInfo = single
    ? { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) }
    : { key, code: key }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyInfo, ...(single && { text: key, unmodifiedText: key }) })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyInfo })
  info(`pressed key '${key}'`)
  await sleep(POST_KEY_DELAY_MS)
}

// --------------------------------------------------------------------------- capture

function writePng(filePath, base64) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const bytes = Buffer.from(base64, 'base64')
  writeFileSync(filePath, bytes)
  return bytes.length
}

async function captureScreenshot(cdp, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  })
  return writePng(filePath, data)
}

// Reads the canvas inside a rAF callback so it runs after the story's own rAF
// render of the same frame (WebGL/WebGPU drawing buffers are cleared once presented).
const CANVAS_DATA_URL_SCRIPT = `new Promise((resolve, reject) => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return reject(new Error('no <canvas> in document'));
  requestAnimationFrame(() => {
    try { resolve(canvas.toDataURL('image/png')); } catch (error) { reject(error); }
  });
})`

async function captureCanvas(cdp, filePath) {
  const dataUrl = await evaluate(cdp, CANVAS_DATA_URL_SCRIPT, { awaitPromise: true })
  const prefix = 'data:image/png;base64,'
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    throw new Error(`canvas.toDataURL returned unexpected data (${String(dataUrl).slice(0, 40)}...)`)
  }
  return writePng(filePath, dataUrl.slice(prefix.length))
}

const BLACK_FRACTION_PY = `import sys
import numpy as np
from PIL import Image
rgb = np.asarray(Image.open(sys.argv[1]).convert('RGB'))
print(float((rgb == 0).all(axis=2).mean()))`

function blackFraction(pngPath) {
  const run = spawnSync('python3', ['-c', BLACK_FRACTION_PY, pngPath], { encoding: 'utf8' })
  const value = Number(run.stdout.trim())
  if (run.status !== 0 || !Number.isFinite(value)) {
    info(`warning: black-fraction detector failed for ${pngPath}: ${run.stderr.trim() || run.error?.message || 'unknown error'}`)
    return null
  }
  return Number(value.toFixed(4))
}

async function captureOutputs(cdp, opts, outPath) {
  const screenshotBytes = await captureScreenshot(cdp, outPath)
  info(`screenshot written: ${outPath} (${screenshotBytes} bytes)`)
  if (opts.canvasOut === undefined) return { screenshotBytes, canvasBytes: null, canvasBlackFraction: null }
  try {
    const canvasBytes = await captureCanvas(cdp, opts.canvasOut)
    info(`canvas written: ${opts.canvasOut} (${canvasBytes} bytes)`)
    return { screenshotBytes, canvasBytes, canvasBlackFraction: blackFraction(opts.canvasOut) }
  } catch (error) {
    info(`warning: canvas capture failed: ${error.message}`)
    return { screenshotBytes, canvasBytes: null, canvasBlackFraction: null, canvasError: error.message }
  }
}

// --------------------------------------------------------------------------- lifecycle

function cleanupSession(session) {
  if (session.cdp !== null) {
    try { session.cdp.close() } catch { /* socket may already be closed */ }
    session.cdp = null
  }
  if (session.chrome !== null) {
    session.chrome.child.kill('SIGKILL')
    session.chrome = null
  }
  if (session.profileDir !== null) {
    try { rmSync(session.profileDir, { recursive: true, force: true }) } catch (error) {
      info(`warning: could not remove profile dir ${session.profileDir}: ${error.message}`)
    }
    session.profileDir = null
  }
}

function installCleanupHandlers(session) {
  process.on('exit', () => cleanupSession(session))
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      info(`received ${signal}, shutting down Chrome`)
      cleanupSession(session)
      process.exit(EXIT_FAILURE)
    })
  }
}

function timeoutPath(outPath) {
  const ext = path.extname(outPath)
  return `${outPath.slice(0, outPath.length - ext.length)}.timeout${ext || '.png'}`
}

async function runCapture(opts, session) {
  const logger = createLogger(opts.log)
  const port = await pickFreePort()
  session.profileDir = mkdtempSync(path.join(tmpdir(), 'vc-chrome-'))
  session.chrome = launchChrome(opts, port, session.profileDir)
  const version = await waitForDevtools(port, session.chrome)
  info(`chrome ready on port ${port} (${version.Browser})`)
  const target = await createTarget(port)
  session.cdp = await connectCdp(target.webSocketDebuggerUrl)

  await preparePage(session.cdp, opts, logger)
  await evaluate(session.cdp, FRAME_COUNTER_SCRIPT)
  const settle = await waitUntilSettled(session.cdp, opts)
  if (!settle.timedOut && opts.pressKey !== undefined) await pressKey(session.cdp, opts.pressKey)

  const outPath = settle.timedOut ? timeoutPath(opts.out) : opts.out
  const outputs = await captureOutputs(session.cdp, opts, outPath)
  const summary = {
    url: opts.url,
    out: outPath,
    width: opts.width,
    height: opts.height,
    dpr: opts.dpr,
    framesTotal: settle.framesTotal,
    settleFrames: settle.settleFrames,
    elapsedSeconds: settle.elapsedSeconds,
    consoleErrors: logger.errorCount(),
    screenshotBytes: outputs.screenshotBytes,
    canvasBytes: outputs.canvasBytes,
    blackFraction: blackFraction(outPath),
    canvasBlackFraction: outputs.canvasBlackFraction,
    ...(outputs.canvasError !== undefined && { canvasError: outputs.canvasError }),
    log: logger.path
  }
  return { summary, timedOut: settle.timedOut, reason: settle.reason }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts === null) {
    console.log(USAGE)
    return EXIT_OK
  }
  const session = { chrome: null, profileDir: null, cdp: null }
  installCleanupHandlers(session)
  try {
    const { summary, timedOut, reason } = await runCapture(opts, session)
    console.log(JSON.stringify(summary))
    if (timedOut) {
      info(`ERROR: rendering did not settle within ${opts.maxSeconds} s: ${reason}. Wrote ${summary.out}`)
      return EXIT_TIMEOUT
    }
    return EXIT_OK
  } finally {
    cleanupSession(session)
  }
}

main().then(
  code => process.exit(code),
  error => {
    if (error instanceof UsageError) {
      info(`usage error: ${error.message}\n${USAGE}`)
      process.exit(EXIT_USAGE)
    }
    info(`ERROR: ${error.message}`)
    process.exit(EXIT_FAILURE)
  }
)
