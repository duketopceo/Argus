// Terminal screen for `npm run watch` (DESIGN.md 7.5, plan R17): alternate
// screen buffer, hidden cursor, and a line differ that rewrites only rows
// whose text changed. No full clear between polls, so nothing flickers.

const ESC = '\x1b['
const at = (row) => `${ESC}${row};1H`

/**
 * The bytes that turn frame `prev` into frame `next` on screen. Each changed
 * row is rewritten in place and cleared to its end; rows the new frame no
 * longer uses are cleared. `prev` undefined means a blank screen.
 */
export function diffFrame(prev, next) {
  let out = ''
  const old = prev ?? []
  for (let i = 0; i < next.length; i++) {
    if (prev !== undefined && old[i] === next[i]) continue
    out += `${at(i + 1)}${next[i]}${ESC}K`
  }
  for (let i = next.length; i < old.length; i++) out += `${at(i + 1)}${ESC}2K`
  return out
}

/**
 * Screen bound to a writable (process.stdout in the app, a fake in tests).
 * `invalidate()` forgets the last frame so the next draw clears and repaints
 * everything; call it on resize, when line positions are no longer valid.
 */
export function createScreen(out) {
  let prev
  let active = false
  let full = true
  return {
    enter() {
      if (active) return
      active = true
      full = true
      out.write(`${ESC}?1049h${ESC}?25l`)
    },
    leave() {
      if (!active) return
      active = false
      out.write(`${ESC}0m${ESC}?25h${ESC}?1049l`)
    },
    invalidate() {
      full = true
    },
    draw(lines) {
      if (!active) return
      const bytes = full ? `${ESC}2J${diffFrame(undefined, lines)}` : diffFrame(prev, lines)
      full = false
      prev = lines
      if (bytes !== '') out.write(bytes)
    },
  }
}
