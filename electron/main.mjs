// argus-reviewer dash — local-only Electron dashboard over scripts/collect.mjs.
// `npm run app`. Reads gh CLI + local artifacts; renderer polls via IPC.
import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol } from 'electron'
import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { collect, ROOT } from '../scripts/collect.mjs'
import { evalPlan, fmtUsd, formatEvalPlan } from '../scripts/eval-plan.mjs'
import { APP_ICON, APP_TITLE, appVersion, DESK_SCHEME, DESK_URL, evalRefusal } from './app-meta.mjs'
import { deskFile, mimeOf } from './desk-files.mjs'

// The desk UI (electron/ui/) loads from a privileged app scheme rather than
// file://, so ES modules, the SVG sprites (<use href="…svg#id">) and the
// fonts resolve same-origin under the unchanged CSP ('self'). Registration
// must happen before 'ready', so it runs before any top-level await below.
protocol.registerSchemesAsPrivileged([
  { scheme: DESK_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const HERE = dirname(fileURLToPath(import.meta.url))
// Report dir the latest collect saw; /report/ serves flow screenshots from it.
let reportDir
// The CLI honours config.cacheDir / --cache-dir; the dashboard must tail the
// same directory or a custom cache dir produces no Live Log output.
let LIVE_LOG = join(ROOT, '.argus-reviewer-cache/live.ndjson')
try {
  const { loadConfig } = await import('../dist/config.js')
  const cfg = await loadConfig(ROOT, { trust: 'trusted' })
  if (cfg.cacheDir) LIVE_LOG = join(ROOT, cfg.cacheDir, 'live.ndjson')
} catch { /* fall back to the default cache dir */ }
app.disableHardwareAcceleration()
app.setVersion(appVersion())
let win
let evalChild
let logChild
let liveOffset = -1 // -1 = uninitialized; first tail seeds recent history
let liveIno = -1 // rotation replaces the file (new inode) — re-seed on change
let liveBuf = ''
const LIVE_SEED = 32 * 1024

// Tail .argus-reviewer-cache/live.ndjson — argus processes append NDJSON
// lines; we emit new entries to the renderer as 'live-log'.
async function tailLive() {
  try {
    const st = statSync(LIVE_LOG)
    if (st.ino !== liveIno) {
      liveIno = st.ino
      liveOffset = -1
      liveBuf = ''
    }
    const size = st.size
    if (liveOffset === -1) liveOffset = Math.max(0, size - LIVE_SEED)
    if (size < liveOffset) liveOffset = 0 // truncated
    if (size === liveOffset) return
    const fh = await open(LIVE_LOG)
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(size - liveOffset), 0, size - liveOffset, liveOffset)
    await fh.close()
    liveOffset += bytesRead
    liveBuf += buffer.subarray(0, bytesRead).toString('utf8')
    const lines = liveBuf.split('\n')
    liveBuf = lines.pop() // keep partial line
    for (const l of lines) {
      if (!l) continue
      try {
        win?.webContents.send('live-log', JSON.parse(l))
      } catch { /* partial write */ }
    }
  } catch { /* file doesn't exist yet */ }
}

ipcMain.handle('run-logs', (_e, runId) => {
  if (typeof runId !== 'number' || !Number.isInteger(runId)) return { ok: false, msg: 'bad run id' }
  if (logChild) return { ok: false, msg: 'already tailing a run' }
  // `gh run view --log` dumps completed logs; `--log-failed` for failures.
  // Bound the spawn — a hung gh would hold the logChild latch forever and
  // every later click would answer 'already tailing a run'.
  logChild = spawn('gh', ['run', 'view', String(runId), '--log'], {
    cwd: ROOT,
    timeout: 120_000,
  })
  // Buffer per stream — a chunk can split a log line in two.
  const pending = { out: '', err: '' }
  const send = (stream, d) => {
    const lines = (pending[stream] + String(d)).split('\n')
    pending[stream] = lines.pop()
    for (const l of lines.filter(Boolean)) {
      win?.webContents.send('run-log', { stream, line: l })
    }
  }
  logChild.stdout.on('data', (d) => send('out', d))
  logChild.stderr.on('data', (d) => send('err', d))
  let errored = false
  logChild.on('error', (err) => {
    errored = true
    logChild = undefined
    win?.webContents.send('run-log', { stream: 'done', line: `gh failed to start: ${err.message}` })
  })
  logChild.on('close', (code) => {
    logChild = undefined
    for (const s of ['out', 'err']) {
      if (pending[s]) win?.webContents.send('run-log', { stream: s, line: pending[s] })
    }
    if (!errored) {
      win?.webContents.send('run-log', { stream: 'done', line: `logs exited ${code}` })
    }
  })
  return { ok: true }
})

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    // Paint the token canvas before first frame so the window never flashes.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0C0E12' : '#F4F5F7',
    title: APP_TITLE,
    icon: APP_ICON,
    webPreferences: {
      preload: join(HERE, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.loadURL(DESK_URL)
}

ipcMain.handle('collect', async () => {
  const state = await collect()
  reportDir = state.workspace?.reportDir || undefined
  return state
})

// The renderer shows this plan (models, cases, estimate, budget cap) in a
// confirm dialog before it may call run-eval. evalPlan never throws.
ipcMain.handle('eval-plan', () => {
  const plan = evalPlan(ROOT)
  return { ...plan, lines: formatEvalPlan(plan), capLabel: fmtUsd(plan.capUsd) }
})

ipcMain.handle('run-eval', (_e, opts) => {
  // Evals spend real OpenRouter credit: refuse unless the user confirmed.
  const refusal = evalRefusal(opts, { running: evalChild !== undefined, env: process.env })
  if (refusal !== undefined) return { ok: false, msg: refusal }
  evalChild = spawn('node', ['evals/run.mjs'], { cwd: ROOT, env: process.env })
  const send = (stream, d) => {
    for (const l of String(d).split('\n').filter(Boolean)) {
      win?.webContents.send('eval-log', { stream, line: l })
    }
  }
  evalChild.stdout.on('data', (d) => send('out', d))
  evalChild.stderr.on('data', (d) => send('err', d))
  // An unhandled 'error' event throws in the main process — a spawn ENOENT
  // (node missing from a bare launchd/Finder PATH) must not kill the app.
  evalChild.on('error', (err) => {
    evalChild = undefined
    win?.webContents.send('eval-log', { stream: 'done', line: `eval failed to start: ${err.message}` })
  })
  evalChild.on('close', (code) => {
    evalChild = undefined
    win?.webContents.send('eval-log', { stream: 'done', line: `eval exited ${code}` })
  })
  return { ok: true }
})

app.whenReady().then(() => {
  protocol.handle(DESK_SCHEME, async (req) => {
    const url = new URL(req.url)
    const file = url.host === 'desk' ? deskFile(url.pathname, { reportDir }) : undefined
    if (file === undefined) return new Response('not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).href)
    if (!res.ok) return new Response('not found', { status: 404 })
    return new Response(res.body, { headers: { 'content-type': mimeOf(file) } })
  })
  // macOS takes the dock icon from the app bundle; in dev there is none.
  app.dock?.setIcon(APP_ICON)
  createWindow()
  const tailTimer = setInterval(tailLive, 2000)
  tailTimer.unref()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  evalChild?.kill()
  logChild?.kill()
  app.quit()
})
