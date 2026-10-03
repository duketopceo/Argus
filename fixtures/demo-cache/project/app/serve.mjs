// Static server for the README demo app. Prints nothing, so no local path
// reaches the recorded terminal.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const port = Number(process.argv[2] ?? 4319)
const page = new URL('./index.html', import.meta.url)

createServer((req, res) => {
  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404)
    res.end()
    return
  }
  readFile(page).then((body) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(body)
  })
}).listen(port, '127.0.0.1')
