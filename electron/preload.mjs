import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('argus', {
  collect: () => ipcRenderer.invoke('collect'),
  runEval: () => ipcRenderer.invoke('run-eval'),
  onEvalLog: (cb) => ipcRenderer.on('eval-log', (_e, m) => cb(m)),
})
