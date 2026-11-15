// Loopback-only server for the eval demo app. Serves index.html (the recorded UI)
// or drifted.html (the changed UI), chosen by the file named in <dir>/active.
// usage: node serve.mjs <port> <dir-with-active-file>
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2] ?? 4401)
const activeFile = join(process.argv[3] ?? here, 'active')

createServer(async (req, res) => {
  try {
    if (req.url === '/shared.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(await readFile(join(here, 'shared.js')))
      return
    }
    if (req.url === '/' || req.url === '/index.html') {
      const name = (await readFile(activeFile, 'utf8').catch(() => 'index.html')).trim()
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(await readFile(join(here, name === 'drifted.html' ? 'drifted.html' : 'index.html')))
      return
    }
    res.writeHead(404)
    res.end()
  } catch {
    res.writeHead(500)
    res.end()
  }
}).listen(port, '127.0.0.1')
