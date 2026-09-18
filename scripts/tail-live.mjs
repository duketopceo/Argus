// Shared tailer for <cacheDir>/live.ndjson — plain node, no deps.
// Ported from electron/main.mjs's tailLive so watch.mjs (and later the
// Electron dashboard) follow live argus runs from any terminal.
//
// argus writes NDJSON lines via src/live.ts; rotation replaces the file
// atomically (new inode), which is how we detect it and re-seed.
import { statSync } from 'node:fs'
import { open } from 'node:fs/promises'

const LIVE_SEED = 32 * 1024 // bytes of history to emit on first sight

export function createLiveTailer(path, { onLine, seedBytes = LIVE_SEED } = {}) {
  let offset = -1 // -1 = uninitialized; first read seeds recent history
  let ino = -1
  let buf = ''

  // Poll once: emits complete new lines via onLine(entry). Never throws —
  // missing/unwritable file is normal (no run in progress).
  async function poll() {
    try {
      const st = statSync(path)
      if (st.ino !== ino) {
        ino = st.ino
        offset = -1
        buf = ''
      }
      const size = st.size
      if (offset === -1) offset = Math.max(0, size - seedBytes)
      if (size < offset) offset = 0 // truncated under us
      if (size === offset) return
      const fh = await open(path)
      try {
        const { bytesRead, buffer } = await fh.read(
          Buffer.alloc(size - offset),
          0,
          size - offset,
          offset,
        )
        offset += bytesRead
        buf += buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await fh.close()
      }
      const lines = buf.split('\n')
      buf = lines.pop() // keep the partial tail line
      for (const l of lines) {
        if (!l) continue
        try {
          onLine?.(JSON.parse(l))
        } catch { /* partial write — skip malformed line */ }
      }
    } catch { /* file doesn't exist yet */ }
  }

  // Convenience driver: poll on an interval until stop() is called.
  function start(intervalMs = 2000) {
    const timer = setInterval(poll, intervalMs)
    timer.unref()
    poll()
    return () => clearInterval(timer)
  }

  return { poll, start }
}
