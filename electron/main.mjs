// argus-reviewer dash — local-only Electron dashboard over scripts/collect.mjs.
// `npm run app`. Reads gh CLI + local artifacts; renderer polls via IPC.
import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { collect, ROOT } from '../scripts/collect.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
app.disableHardwareAcceleration()
app.setVersion('0.0.1')
let win
let evalChild

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'argus-reviewer',
    webPreferences: {
      preload: join(HERE, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.loadFile(join(HERE, 'index.html'))
}

ipcMain.handle('collect', () => collect())

ipcMain.handle('run-eval', () => {
  if (evalChild) return { ok: false, msg: 'already running' }
  if (!process.env.OPENROUTER_API_KEY) {
    return { ok: false, msg: 'OPENROUTER_API_KEY not set' }
  }
  evalChild = spawn('node', ['evals/run.mjs'], { cwd: ROOT, env: process.env })
  const send = (stream, d) => {
    for (const l of String(d).split('\n').filter(Boolean)) {
      win?.webContents.send('eval-log', { stream, line: l })
    }
  }
  evalChild.stdout.on('data', (d) => send('out', d))
  evalChild.stderr.on('data', (d) => send('err', d))
  evalChild.on('close', (code) => {
    evalChild = undefined
    win?.webContents.send('eval-log', { stream: 'done', line: `eval exited ${code}` })
  })
  return { ok: true }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  evalChild?.kill()
  app.quit()
})
