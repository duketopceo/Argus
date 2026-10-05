// Minimal static file server for the target adapter tests.
// Usage: node serve.mjs <port> [dir]
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const port = Number(process.argv[2] ?? 0)
const root = process.argv[3] ?? new URL('.', import.meta.url).pathname

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const server = createServer((req, res) => {
  // Browsers abort connections on close/nav; an unhandled socket 'error'
  // would crash the fixture mid-test.
  req.on('error', () => {})
  res.on('error', () => {})
  const path = req.url === '/' ? '/index.html' : (req.url ?? '/').split('?')[0]
  const file = normalize(join(root, path))
  readFile(file)
    .then((body) => {
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    })
    .catch(() => {
      if (res.destroyed) return
      res.writeHead(404)
      res.end('not found')
    })
})
server.on('clientError', (_err, socket) => socket.destroy())
server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`)
})
