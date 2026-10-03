// DOM helpers for the desk. Text only ever goes in through textContent:
// repo-controlled strings (branch names, PR titles, eval docs) are never
// parsed as HTML.
import { statusDisplay } from './model.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
export const GLYPHS = 'brand/export/glyphs.svg'
export const CHROME = 'brand/export/chrome.svg'

export const $ = (id) => document.getElementById(id)

/** Element with an optional class and text. Children via append. */
export const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  return e
}

/** Sprite symbol as an inline svg: `use(GLYPHS, 'status-passed', 'glyph')`. */
export function use(sprite, id, cls = 'icon') {
  const s = svgEl('svg', { class: cls, 'aria-hidden': 'true', focusable: 'false' })
  s.append(svgEl('use', { href: `${sprite}#${id}` }))
  return s
}

/**
 * Running mark (motion.css A14a): the pupil drifts round the iris ring.
 * Under reduced motion desk.css holds the pupil still at the top of the
 * ring, so "running" never borrows the inconclusive half-lid shape.
 */
export function scanMark(cls = 'glyph') {
  const s = svgEl('svg', {
    class: `${cls} argus-scan`,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'aria-hidden': 'true',
    focusable: 'false',
  })
  s.append(
    svgEl('circle', { cx: 12, cy: 12, r: 8 }),
    svgEl('circle', { class: 'argus-scan__pupil', cx: 12, cy: 9.25, r: 2.75, fill: 'currentColor', stroke: 'none' }),
    svgEl('path', { class: 'argus-scan__lid', d: 'M4 12A8 8 0 0 1 20 12Z', fill: 'currentColor' }),
  )
  return s
}

/** Status as glyph plus word, always both (DESIGN.md 6.6). */
export function statusTag(status, extraCls = '') {
  const d = statusDisplay(status)
  const tag = el('span', `status tone-${d.tone}${extraCls ? ` ${extraCls}` : ''}`)
  tag.dataset.status = d.word
  tag.append(d.glyph === 'running' ? scanMark() : use(GLYPHS, d.glyph, 'glyph'), el('span', 'word', d.word))
  return tag
}

/** Button with an optional chrome icon. */
export function button(label, { cls = 'btn secondary', icon, title, onClick } = {}) {
  const b = el('button', cls)
  b.type = 'button'
  if (icon) b.append(use(CHROME, icon))
  if (label) b.append(el('span', 'label', label))
  if (title) b.title = title
  if (onClick) b.addEventListener('click', onClick)
  return b
}

/** A copyable value: mono text plus a Copy button that says when it worked. */
export function copyable(text, { display, label = 'Copy' } = {}) {
  const wrap = el('span', 'copyable')
  const code = el('code', 'data', display ?? text)
  const b = button('', { cls: 'btn ghost square copy', icon: 'copy', title: `${label}: ${text}` })
  b.setAttribute('aria-label', `${label} ${display ?? text}`)
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text)
      b.dataset.done = 'copied'
      announce('Copied')
    } catch {
      b.dataset.done = 'failed'
      announce('Could not copy. Select the text instead.')
    }
    setTimeout(() => delete b.dataset.done, 1500)
  })
  wrap.append(code, b)
  return wrap
}

export function announce(msg) {
  const a = $('announce')
  if (!a) return
  a.textContent = ''
  // A fresh text node so screen readers re-announce identical messages.
  requestAnimationFrame(() => {
    a.textContent = msg
  })
}

/**
 * Empty or problem state: illustration (light and dark exports), one
 * sentence, and a copyable command (DESIGN.md 6.8, A13). Never "none" alone.
 */
export function emptyState({ art, title, body, command, commandLabel, action }) {
  const box = el('div', 'empty')
  if (art) {
    const pic = el('picture', 'empty-art')
    const dark = el('source')
    dark.srcset = `brand/export/empty/${art}-dark.svg`
    dark.media = '(prefers-color-scheme: dark)'
    const img = el('img')
    img.src = `brand/export/empty/${art}-light.svg`
    img.alt = ''
    img.width = 160
    img.height = 120
    pic.append(dark, img)
    box.append(pic)
  }
  box.append(el('p', 'empty-title', title))
  if (body) box.append(el('p', 'empty-body', body))
  if (command) {
    const row = el('div', 'empty-cmd')
    if (commandLabel) row.append(el('span', 'dim', commandLabel))
    row.append(copyable(command.copy ?? command.text, { display: command.text }))
    box.append(row)
  }
  if (action) box.append(action)
  return box
}

/** Inline banner for partial, stale and error states. Never a toast. */
export function banner(tone, title, { body, command, action } = {}) {
  const b = el('div', `inline-banner tone-${tone}`)
  b.setAttribute('role', tone === 'failed' ? 'alert' : 'status')
  const text = el('div', 'inline-banner-text')
  text.append(el('strong', '', title))
  if (body) text.append(el('span', 'dim', body))
  b.append(text)
  if (command) b.append(copyable(command))
  if (action) b.append(action)
  return b
}

/** Static skeleton rows while a panel loads. No shimmer: motion is for status. */
export function loadingRows(label, n = 3) {
  const box = el('div', 'loading')
  box.setAttribute('aria-busy', 'true')
  box.append(el('span', 'sr-only', label))
  for (let i = 0; i < n; i++) box.append(el('div', 'skeleton'))
  box.append(el('p', 'elapsed dim'))
  return box
}

/** Data table with header row; cells are strings or nodes. */
export function table(head, rows, { numeric = [], caption } = {}) {
  const t = el('table', 'table')
  if (caption) t.append(el('caption', 'sr-only', caption))
  const thead = el('thead')
  const hr = el('tr')
  head.forEach((h, i) => {
    const th = el('th', numeric.includes(i) ? 'num' : '', h)
    th.scope = 'col'
    hr.append(th)
  })
  thead.append(hr)
  const tbody = el('tbody')
  for (const r of rows) {
    const tr = el('tr')
    r.forEach((c, i) => {
      const td = el('td', numeric.includes(i) ? 'num' : '')
      if (c instanceof Node) td.append(c)
      else td.textContent = String(c ?? '')
      tr.append(td)
    })
    tbody.append(tr)
  }
  t.append(thead, tbody)
  const wrap = el('div', 'table-wrap')
  wrap.append(t)
  return wrap
}
