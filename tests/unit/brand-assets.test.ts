import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'
import { optimize } from 'svgo'
import { describe, expect, it } from 'vitest'

import {
  buildBrand,
  CHROME_PREFIX,
  EMPTY_PREFIX,
  EMPTY_TONES,
  EXPORT_DIR,
  GLYPH_PREFIX,
  ICNS_TYPES,
  ICON_PREFIX,
  readMasters,
  readThemeColors,
} from '../../scripts/build-brand.mjs'
import { LANE_IDS, LANE_STATUSES } from '../../src/report/manifest.js'
import {
  PROOF_LEVELS,
  proofMeter,
  SEVERITIES,
  SEVERITY_GLYPH,
  STATUS_GLYPH,
  VERDICTS,
  verdictGlyph,
} from '../../src/report/viewmodel.js'

const ROOT = join(import.meta.dirname, '..', '..')

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path))
    else out.push(relative(join(ROOT, EXPORT_DIR), path).split('\\').join('/'))
  }
  return out.sort()
}

const allMasters = readMasters()
const masters = allMasters.filter(
  (m) => ![GLYPH_PREFIX, ICON_PREFIX, CHROME_PREFIX, EMPTY_PREFIX].some((p) => m.rel.startsWith(p)),
)
const glyphs = allMasters.filter((m) => m.rel.startsWith(GLYPH_PREFIX))
const chrome = allMasters.filter((m) => m.rel.startsWith(CHROME_PREFIX))
const svgo = (svg: string) =>
  optimize(svg, { multipass: true, floatPrecision: 3, plugins: [{ name: 'preset-default' }] }).data
const isMark = (rel: string) => /(^|\/)mark(-\d+)?\.svg$/.test(rel)

describe('brand SVG masters (KTD6)', () => {
  it('has the three optical mark masters, the wordmark and the lockup', () => {
    expect(masters.map((m) => m.rel)).toEqual([
      'lockup.svg',
      'mark-16.svg',
      'mark-24.svg',
      'mark.svg',
      'wordmark.svg',
    ])
  })

  it.each(allMasters.map((m) => [m.rel, m.svg]))('%s parses and is self-contained', (_rel, svg) => {
    expect(() => optimize(svg)).not.toThrow()
    expect(svg).not.toMatch(/<text[\s>]/)
    expect(svg).not.toMatch(/<image[\s>]/)
    expect(svg).not.toMatch(/<script[\s>]/)
    expect(svg).not.toMatch(/\bhref\s*=/)
    expect(svg).not.toMatch(/url\(\s*['"]?(?!#)/)
    expect(svg).not.toMatch(/@import/)
  })

  it('draws every mark on the 24-unit grid', () => {
    for (const { rel, svg } of masters.filter((m) => isMark(m.rel))) {
      expect(svg, rel).toMatch(/viewBox="0 0 24 24"/)
    }
  })
})

describe('brand exports (KTD6)', () => {
  const first = buildBrand()

  it('reproduce byte for byte when the build runs twice', () => {
    const second = buildBrand()
    expect([...second.keys()]).toEqual([...first.keys()])
    for (const [rel, buf] of first) expect(second.get(rel)!.equals(buf), rel).toBe(true)
  })

  it('match the committed export set, and committed SVGs match the masters', () => {
    // PNG bytes are compared run-to-run above, not against the committed
    // files: rasterizer output is not promised to be identical across CPU
    // architectures, and the SVG check already catches a stale master.
    expect(listFiles(join(ROOT, EXPORT_DIR))).toEqual([...first.keys()].sort())
    for (const [rel, buf] of first) {
      if (!rel.endsWith('.svg')) continue
      const committed = readFileSync(join(ROOT, EXPORT_DIR, rel))
      expect(committed.equals(buf), `${rel} is stale: run npm run brand`).toBe(true)
    }
  })

  it('keeps each optimized SVG under 2 KB (DESIGN.md section 10)', () => {
    for (const [rel, buf] of first) {
      if (
        rel.endsWith('.svg') &&
        !['glyphs.svg', 'chrome.svg'].includes(rel) &&
        !rel.startsWith(ICON_PREFIX)
      )
        expect(buf.length, rel).toBeLessThanOrEqual(2048)
    }
  })
})

describe('glyph set (U8, DESIGN.md A3-A6)', () => {
  const sprite = buildBrand().get('glyphs.svg')!.toString('utf8')
  const ids = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1])
  const expected = [
    ...LANE_STATUSES.map((s) => `status-${s}`),
    ...Array.from({ length: PROOF_LEVELS.length + 1 }, (_, n) => `proof-${n}`),
    ...SEVERITIES.map((s) => `severity-${s}`),
    ...LANE_IDS.map((l) => `lane-${l}`),
  ]

  it('has one sprite symbol per status, proof level, severity and lane, keyed by the vocabulary', () => {
    expect([...ids].sort()).toEqual([...expected].sort())
    expect(glyphs.map((g) => g.rel.slice(GLYPH_PREFIX.length, -4)).sort()).toEqual(
      [...expected].sort(),
    )
  })

  it('draws every glyph on the 24-unit grid', () => {
    for (const { rel, svg } of glyphs) expect(svg, rel).toMatch(/viewBox="0 0 24 24"/)
  })

  it('keeps each optimized glyph under 2 KB and the sprite under 24 KB (DESIGN.md section 10)', () => {
    for (const { rel, svg } of glyphs) expect(svgo(svg).length, rel).toBeLessThanOrEqual(2048)
    expect(Buffer.byteLength(sprite)).toBeLessThanOrEqual(24 * 1024)
  })

  it('colors every glyph through currentColor only, so surfaces apply status tokens', () => {
    for (const { rel, svg } of glyphs) {
      expect(svg, rel).toMatch(/currentColor/)
      expect(svg, rel).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|oklch\(/i)
      for (const [, value] of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g))
        expect(['currentColor', 'none'], `${rel}: ${value}`).toContain(value)
    }
  })
})

describe('chrome icons (U9, DESIGN.md A7, section 6.6)', () => {
  const sprite = buildBrand().get('chrome.svg')!.toString('utf8')
  const ids = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1])
  const glyphRoot = (svg: string) => /^<svg([^>]*)>/.exec(svg)![1].replace(/<title>.*$/, '')
  const rootAttrs = (svg: string) =>
    glyphRoot(svg)
      .replace(/\s(?:xmlns|viewBox)="[^"]*"/g, '')
      .trim()

  it('ships the A7 set as one sprite symbol per master', () => {
    expect([...ids].sort()).toEqual(
      [
        'check',
        'chevron-down',
        'chevron-left',
        'chevron-right',
        'chevron-up',
        'close',
        'copy',
        'download',
        'drawer',
        'external',
        'file',
        'filter',
        'key',
        'keyboard',
        'play',
        'refresh',
        'search',
        'settings',
        'stop',
        'terminal',
      ].sort(),
    )
    expect(chrome.map((c) => c.rel.slice(CHROME_PREFIX.length, -4)).sort()).toEqual([...ids].sort())
  })

  it('shares no id with the glyph sprite, so both can be inlined in one document', () => {
    const glyphIds = glyphs.map((g) => g.rel.slice(GLYPH_PREFIX.length, -4))
    for (const id of ids) expect(glyphIds, id).not.toContain(id)
  })

  it('draws in the glyph hand: 24-unit grid, same root stroke attributes, currentColor only', () => {
    // The stroked glyphs (status, lane) set the hand; proof tallies are fills.
    const hand = rootAttrs(glyphs.find((g) => g.rel === `${GLYPH_PREFIX}lane-review.svg`)!.svg)
    for (const { rel, svg } of glyphs.filter((g) => /\/(?:status|lane)-/.test(g.rel)))
      expect(rootAttrs(svg), rel).toBe(hand)
    for (const { rel, svg } of chrome) {
      expect(svg, rel).toMatch(/viewBox="0 0 24 24"/)
      expect(rootAttrs(svg), rel).toBe(hand)
      expect(svg, rel).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|oklch\(/i)
      expect(svg, rel).not.toMatch(/stroke-width="(?!1\.8")/)
      for (const [, value] of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g))
        expect(['currentColor', 'none'], `${rel}: ${value}`).toContain(value)
    }
  })

  it('uses no circle, ellipse or arc: circles are reserved for eye semantics', () => {
    for (const { rel, svg } of chrome) {
      expect(svg, rel).not.toMatch(/<(?:circle|ellipse)[\s>]/)
      for (const [, d] of svg.matchAll(/\sd="([^"]*)"/g)) expect(d, rel).not.toMatch(/[Aa]/)
      // A rect rounded into a circle or a pill is an eye in disguise.
      for (const [rect] of svg.matchAll(/<rect\b[^>]*>/g)) {
        const n = (a: string) => Number(new RegExp(`\\s${a}="([^"]*)"`).exec(rect)?.[1] ?? 0)
        expect(n('rx') * 2, `${rel}: ${rect}`).toBeLessThan(Math.min(n('width'), n('height')))
      }
    }
  })

  it('keeps each optimized icon under 2 KB and the sprite under 16 KB (section 10)', () => {
    for (const { rel, svg } of chrome) expect(svgo(svg).length, rel).toBeLessThanOrEqual(2048)
    expect(Buffer.byteLength(sprite)).toBeLessThanOrEqual(16 * 1024)
  })
})

describe('empty-state illustrations (U9, DESIGN.md A13)', () => {
  const files = buildBrand()
  const empty = allMasters.filter((m) => m.rel.startsWith(EMPTY_PREFIX))
  const colors = readThemeColors()
  const hexes = (svg: string) =>
    new Set([...svg.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toUpperCase()))
  const tones = (theme: 'light' | 'dark') =>
    EMPTY_TONES.map((t) => colors[theme][t as keyof (typeof colors)[typeof theme]].toUpperCase())

  it('has the four A13 states at 160x120', () => {
    expect(empty.map((m) => m.rel.slice(EMPTY_PREFIX.length, -4)).sort()).toEqual(
      ['manifest-unreadable', 'no-key', 'no-runs', 'nothing-to-heal'].sort(),
    )
    for (const { rel, svg } of empty) expect(svg, rel).toMatch(/viewBox="0 0 160 120"/)
  })

  it('draws monoline in the glyph stroke with at most the two A13 tones, both used', () => {
    for (const { rel, svg } of empty) {
      expect([...hexes(svg)].sort(), rel).toEqual([...tones('light')].sort())
      for (const [, w] of svg.matchAll(/stroke-width="([^"]+)"/g)) expect(w, rel).toBe('1.5')
      expect(svg, rel).not.toMatch(/currentColor|rgb\(|hsl\(|oklch\(|opacity|Gradient|filter=/)
    }
  })

  it('exports each state per theme, the dark one in the dark tones only', () => {
    for (const { rel } of empty) {
      const stem = rel.slice(0, -4)
      for (const theme of ['light', 'dark'] as const) {
        const out = files.get(`${stem}-${theme}.svg`)?.toString()
        expect(out, `${stem}-${theme}`).toBeDefined()
        expect([...hexes(out!)].sort(), `${stem}-${theme}`).toEqual([...tones(theme)].sort())
      }
    }
  })
})

describe('motion (U9, DESIGN.md A14, section 6.5)', () => {
  const css = readFileSync(join(ROOT, 'assets/brand/motion.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
  /** The body of the first block opened by `head`, braces balanced. */
  const block = (src: string, head: string) => {
    const start = src.indexOf('{', src.indexOf(head))
    let depth = 0
    for (let i = start; i < src.length; i++) {
      depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0
      if (!depth) return src.slice(start + 1, i)
    }
    throw new Error(`unclosed ${head}`)
  }
  const reduce = block(css, '@media (prefers-reduced-motion: reduce)')
  const outside = css.replace(reduce, '')
  const rules = (src: string) =>
    [...src.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
      selectors: sel.split(',').map((x) => x.trim()),
      body,
    }))
  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1])

  it('defines only the A14 web motions: scan, blink-to-state and tally tick', () => {
    expect(keyframes.sort()).toEqual(
      ['argus-lid-close', 'argus-lid-open', 'argus-scan', 'argus-tally-roll'].sort(),
    )
  })

  it('times every animation with a section 6.5 motion token', () => {
    const animated = rules(outside).filter((r) => /(^|;|\s)animation\s*:/.test(r.body))
    expect(animated.length).toBeGreaterThanOrEqual(keyframes.length)
    for (const { selectors, body } of animated) {
      const value = /animation\s*:([^;]+);/.exec(body)![1]
      expect(value, selectors.join()).toMatch(/var\(--argus-motion-(?:scan|state|panel|instant)\)/)
      expect(value, selectors.join()).not.toMatch(/\d(?:ms|s)\b/)
    }
    for (const k of keyframes) expect(outside).toMatch(new RegExp(`animation:[^;]*\\b${k}\\b`))
    expect(outside).toMatch(/--argus-motion-scan:\s*1600ms/)
  })

  it('neutralizes every animation and zeroes every motion token under prefers-reduced-motion', () => {
    const stilled = rules(reduce)
      .filter((r) => /animation\s*:\s*none/.test(r.body))
      .flatMap((r) => r.selectors)
    for (const { selectors, body } of rules(outside))
      if (/(^|;|\s)animation\s*:/.test(body))
        for (const sel of selectors) expect(stilled, sel).toContain(sel)
    for (const t of ['instant', 'state', 'panel', 'scan'])
      expect(reduce).toMatch(new RegExp(`--argus-motion-${t}:\\s*0ms`))
    // Running falls back to the static half-lid, resolve to an instant swap.
    expect(reduce).toMatch(/\.argus-scan__lid\s*\{[^}]*display:\s*inline/)
    expect(reduce).toMatch(/\.argus-blink__from[^{]*\{[^}]*display:\s*none/)
  })

  it('ships the terminal spinner as four single-cell glyphs at 120 ms (A14c)', () => {
    const spinner = JSON.parse(readFileSync(join(ROOT, 'assets/brand/spinner.json'), 'utf8'))
    expect(spinner.intervalMs).toBe(120)
    expect(spinner.frames).toEqual(['◌', '◍', '◎', '◉'])
    for (const f of spinner.frames as string[]) {
      expect([...f].length, f).toBe(1)
      // Geometric Shapes defaults to text presentation: one cell, never emoji.
      const cp = f.codePointAt(0)!
      expect(cp >= 0x25a0 && cp <= 0x25ff, f).toBe(true)
    }
  })
})

// ---- Fonts (U10, DESIGN.md A15, plan KTD8) ----------------------------------

const FONT_DIR = join(ROOT, 'assets/brand/fonts')
const FONTS_CSS = readFileSync(join(ROOT, 'assets/brand/fonts.css'), 'utf8')

/** WOFF2 known-table order (spec §5.1); the index is the tag's flag value. */
const WOFF2_TAGS = (
  'cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx ' +
  'kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix ' +
  'acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak ' +
  'Zapf Silf Glat Gloc Feat Sill'
)
  .match(/.{4}\s?/g)!
  .map((t) => t.slice(0, 4))

/** Code points a WOFF2 file maps, read from its cmap (formats 4 and 12). */
function woff2CodePoints(buf: Buffer): Set<number> {
  expect(buf.toString('latin1', 0, 4)).toBe('wOF2')
  const numTables = buf.readUInt16BE(12)
  const compressedSize = buf.readUInt32BE(20)
  let p = 48
  const base128 = () => {
    let v = 0
    for (let i = 0; i < 5; i++) {
      const b = buf[p++]
      v = v * 128 + (b & 0x7f)
      if (!(b & 0x80)) return v
    }
    throw new Error('bad UIntBase128')
  }
  let offset = 0
  let cmap: { offset: number; length: number } | undefined
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++]
    const tag =
      (flags & 0x3f) === 63 ? buf.toString('latin1', p, (p += 4)) : WOFF2_TAGS[flags & 0x3f]
    const version = flags >> 6
    const origLength = base128()
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0
    const length = transformed ? base128() : origLength
    if (tag === 'cmap') cmap = { offset, length }
    offset += length
  }
  const data = brotliDecompressSync(buf.subarray(p, p + compressedSize))
  if (!cmap) throw new Error('no cmap')
  const t = data.subarray(cmap.offset, cmap.offset + cmap.length)
  const out = new Set<number>()
  for (let i = 0; i < t.readUInt16BE(2); i++) {
    const sub = t.subarray(t.readUInt32BE(4 + i * 8 + 4))
    const format = sub.readUInt16BE(0)
    if (format === 4) {
      const segX2 = sub.readUInt16BE(6)
      for (let s = 0; s < segX2; s += 2) {
        const end = sub.readUInt16BE(14 + s)
        const start = sub.readUInt16BE(16 + segX2 + s)
        const delta = sub.readInt16BE(16 + segX2 * 2 + s)
        const rangeAt = 16 + segX2 * 3 + s
        const rangeOffset = sub.readUInt16BE(rangeAt)
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const gid = rangeOffset
            ? sub.readUInt16BE(rangeAt + rangeOffset + (c - start) * 2)
            : (c + delta) & 0xffff
          if (gid) out.add(c)
        }
      }
    } else if (format === 12) {
      for (let g = 0; g < sub.readUInt32BE(12); g++) {
        const at = 16 + g * 12
        for (let c = sub.readUInt32BE(at); c <= sub.readUInt32BE(at + 4); c++) out.add(c)
      }
    }
  }
  return out
}

interface FontFace {
  family: string
  file: string
  ranges: [number, number][] | null
  local: boolean
}

function parseFontFaces(css: string): FontFace[] {
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => {
    const prop = (name: string) => new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+);`).exec(body)?.[1]
    const range = prop('unicode-range')
    return {
      family: prop('font-family')!.replace(/['"]/g, '').trim(),
      file: /url\('([^']+)'\)/.exec(body)?.[1] ?? '',
      local: /local\(/.test(body),
      ranges: range
        ? range.split(',').map((r) => {
            const [a, b = a] = r.trim().replace(/^U\+/i, '').split('-')
            return [parseInt(a, 16), parseInt(b, 16)] as [number, number]
          })
        : null,
    }
  })
}

const faces = parseFontFaces(FONTS_CSS)
const cmaps = new Map(
  faces
    .filter((f) => f.file)
    .map((f) => [f.file, woff2CodePoints(readFileSync(join(ROOT, 'assets/brand', f.file)))]),
)
const inRange = (face: FontFace, cp: number) =>
  !face.ranges || face.ranges.some(([a, b]) => cp >= a && cp <= b)

/**
 * The face a browser draws `cp` with in `family`: the last-declared web face
 * whose unicode-range covers it and whose cmap has it (CSS Fonts 4 §4.5).
 */
function servingFace(family: string, cp: number): FontFace | undefined {
  return faces
    .filter((f) => f.family === family && f.file && inRange(f, cp))
    .reverse()
    .find((f) => cmaps.get(f.file)!.has(cp))
}

/** Every glyph the text surfaces print from src/report/viewmodel.ts. */
const VOCABULARY = [
  ...new Set(
    [
      ...Object.values(STATUS_GLYPH),
      ...Object.values(SEVERITY_GLYPH),
      ...VERDICTS.map((v) => verdictGlyph(v)),
      proofMeter(undefined),
      proofMeter(PROOF_LEVELS.at(-1)),
    ].flatMap((s) => [...s]),
  ),
].sort()

describe('fonts (U10, DESIGN.md A15, KTD8)', () => {
  const woff2 = readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2'))
  const brandFonts = [
    'martian-mono-var.woff2',
    'schibsted-grotesk-italic.woff2',
    'schibsted-grotesk-var.woff2',
  ]

  it('ships the three brand subsets plus the vocabulary glyph subset, and nothing unused', () => {
    expect(woff2.sort()).toEqual(['argus-glyphs.woff2', ...brandFonts].sort())
    expect([...cmaps.keys()].map((f) => f.replace('fonts/', '')).sort()).toEqual(woff2.sort())
  })

  it('keeps the brand fonts at or under 110 KB and the glyph subset under 4 KB (section 10)', () => {
    const size = (f: string) => readFileSync(join(FONT_DIR, f)).length
    expect(brandFonts.reduce((n, f) => n + size(f), 0)).toBeLessThanOrEqual(110_000)
    expect(size('argus-glyphs.woff2')).toBeLessThanOrEqual(4096)
  })

  it('ships a license for every source font and the recorded subsetting command', () => {
    for (const f of ['OFL-SchibstedGrotesk.txt', 'OFL-MartianMono.txt'])
      expect(readFileSync(join(FONT_DIR, f), 'utf8')).toMatch(/SIL Open Font License, Version 1\.1/)
    expect(readFileSync(join(FONT_DIR, 'LICENSE-DejaVu.txt'), 'utf8')).toMatch(/Bitstream Vera/)
    expect(readFileSync(join(FONT_DIR, 'SUBSET.md'), 'utf8')).toMatch(/pyftsubset/)
  })

  it('swaps without blocking and gives each family a metric-matched local fallback', () => {
    for (const f of faces.filter((x) => x.file)) {
      expect(FONTS_CSS).toContain(f.file)
    }
    expect(FONTS_CSS.match(/font-display:\s*swap/g)!.length).toBe(
      faces.filter((x) => x.file).length,
    )
    for (const family of ['Schibsted Grotesk', 'Martian Mono']) {
      const fb = faces.find((f) => f.family === `${family} Fallback`)
      expect(fb?.local, family).toBe(true)
      expect(FONTS_CSS).toMatch(new RegExp(`'${family}', '${family} Fallback'`))
    }
    expect(FONTS_CSS).toMatch(/size-adjust/)
  })

  it('serves every vocabulary glyph in viewmodel.ts from a declared font in both families', () => {
    expect(VOCABULARY.length).toBeGreaterThanOrEqual(12)
    for (const family of ['Schibsted Grotesk', 'Martian Mono']) {
      for (const g of VOCABULARY) {
        const face = servingFace(family, g.codePointAt(0)!)
        expect(face, `${family} has no served font for ${g}`).toBeDefined()
      }
    }
  })

  it('gives each glyph face the descriptors of a main face, so browsers composite them', () => {
    // A unicode-range face whose weight, stretch or style differs from every
    // main face of its family is matched on its own and never drawn.
    const descriptors = (body: string) =>
      ['font-weight', 'font-stretch', 'font-style']
        .map((d) => new RegExp(`${d}\\s*:\\s*([^;]+);`).exec(body)?.[1] ?? '')
        .join('|')
    const blocks = [...FONTS_CSS.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => body)
    const glyphBlocks = blocks.filter((b) => b.includes('argus-glyphs.woff2'))
    expect(glyphBlocks.length).toBe(3)
    for (const g of glyphBlocks) {
      const family = /font-family:\s*'([^']+)'/.exec(g)![1]
      const mains = blocks.filter(
        (b) => b.includes(`'${family}'`) && /url\(/.test(b) && !b.includes('unicode-range'),
      )
      expect(mains.map(descriptors), family).toContain(descriptors(g))
    }
  })

  it('draws the shape vocabulary from the one glyph subset, whose range is exactly that vocabulary', () => {
    const glyphFile = 'fonts/argus-glyphs.woff2'
    const shapes = VOCABULARY.map((g) => g.codePointAt(0)!).filter(
      (cp) => !cmaps.get('fonts/martian-mono-var.woff2')!.has(cp),
    )
    // Everything Martian Mono lacks comes from the subset, in both families,
    // so a glyph looks the same on every surface.
    for (const family of ['Schibsted Grotesk', 'Martian Mono'])
      for (const cp of shapes)
        expect(servingFace(family, cp)?.file, `${family} U+${cp.toString(16)}`).toBe(glyphFile)
    expect([...cmaps.get(glyphFile)!].sort()).toEqual([...shapes].sort())
    for (const face of faces.filter((f) => f.file === glyphFile)) {
      const covered = face.ranges!.flatMap(([a, b]) =>
        Array.from({ length: b - a + 1 }, (_, i) => a + i),
      )
      expect(covered.sort()).toEqual([...shapes].sort())
    }
  })
})

// ---- App icon and favicons (U10, DESIGN.md A8, A9) --------------------------

describe('app icon and favicons (U10, DESIGN.md A8/A9)', () => {
  const files = buildBrand()
  const icon = (name: string) => allMasters.find((m) => m.rel === `${ICON_PREFIX}${name}.svg`)!.svg
  const tokens = JSON.parse(readFileSync(join(ROOT, 'assets/brand/tokens.json'), 'utf8'))
  const colors = readThemeColors()
  const elements = (svg: string) =>
    [...svg.matchAll(/<(?:path|circle)\b[^>]*\/>/g)].map((m) =>
      m[0].replace(/\s(?:fill|stroke)="[^"]*"/g, '').replace(/\s+/g, ' '),
    )

  it('exports the A8/A9 set', () => {
    const want = [
      ...[16, 32, 48, 64, 128, 256, 512, 1024].map((px) => `app-icon-${px}.png`),
      'app-icon.icns',
      'app-icon.ico',
      'favicon.svg',
      'favicon-32.png',
      'apple-touch-icon.png',
      'icon-512.png',
      'icon-maskable-512.png',
    ]
    for (const f of want) expect(files.has(`${ICON_PREFIX}${f}`), f).toBe(true)
  })

  it('builds the icon marks from the mark masters and colors them from tokens.json', () => {
    const accent = colors.light.accent
    const onAccent = tokens.color.light['on-accent'].$value.hex
    for (const [name, master] of [
      ['app-icon', 'mark.svg'],
      ['app-icon-maskable', 'mark.svg'],
      ['app-icon-16', 'mark-16.svg'],
      ['favicon', 'mark-16.svg'],
    ]) {
      const markEls = elements(allMasters.find((m) => m.rel === master)!.svg)
      const g = /<g id="mark"[^>]*>([\s\S]*?)<\/g>/.exec(icon(name))![1]
      for (const el of markEls) expect(elements(g), `${name} carries ${master}`).toContain(el)
    }
    for (const name of ['app-icon', 'app-icon-maskable', 'app-icon-16']) {
      const svg = icon(name)
      expect(svg, name).toContain(`fill="${accent}"`)
      expect(svg, name).toMatch(new RegExp(`(?:fill|stroke)="${onAccent}"`))
      expect(svg, name).not.toMatch(/Gradient|filter=|opacity/)
    }
    const fav = files.get(`${ICON_PREFIX}favicon.svg`)!.toString()
    expect(fav.toLowerCase()).toContain(colors.light.accent.toLowerCase())
    expect(fav.toLowerCase()).toMatch(
      new RegExp(
        `@media \\(prefers-color-scheme:dark\\)\\{[^}]*${colors.dark.accent.toLowerCase()}`,
      ),
    )
    // An inline style would outrank the media query and pin the light color.
    expect(fav).not.toMatch(/\sstyle=/)
  })

  it('writes an ICO with 16, 32, 48 and 256 PNG entries', () => {
    const ico = files.get(`${ICON_PREFIX}app-icon.ico`)!
    expect(ico.readUInt16LE(2)).toBe(1)
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const e = 6 + i * 16
      const data = ico.subarray(
        ico.readUInt32LE(e + 12),
        ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8),
      )
      expect(data.subarray(1, 4).toString('latin1')).toBe('PNG')
      expect(data.readUInt32BE(16)).toBe(ico[e] || 256)
      return ico[e] || 256
    })
    expect(sizes).toEqual([16, 32, 48, 256])
  })

  it('writes an ICNS with the macOS 16-512 @1x/@2x set', () => {
    const icns = files.get(`${ICON_PREFIX}app-icon.icns`)!
    expect(icns.toString('latin1', 0, 4)).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const found: Record<string, number> = {}
    for (let p = 8; p < icns.length; p += icns.readUInt32BE(p + 4)) {
      const data = icns.subarray(p + 8, p + icns.readUInt32BE(p + 4))
      found[icns.toString('latin1', p, p + 4)] = data.readUInt32BE(16)
    }
    expect(found).toEqual(ICNS_TYPES)
    for (const t of [
      'icp4',
      'icp5',
      'ic11',
      'ic12',
      'ic07',
      'ic13',
      'ic08',
      'ic14',
      'ic09',
      'ic10',
    ])
      expect(found[t], t).toBeDefined()
  })

  it('keeps the maskable mark inside the 80% safe zone (bounding box on the master)', () => {
    const svg = icon('app-icon-maskable')
    const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1])
    const mark = /<g id="mark"[\s\S]*?<\/g>/.exec(svg)![0]
    const box = new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${mark}</svg>`,
    ).getBBox()!
    const c = size / 2
    const r = 0.4 * size
    for (const [x, y] of [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ])
      expect(Math.hypot(x - c, y - c), `corner ${x},${y}`).toBeLessThanOrEqual(r)
    expect(box.width).toBeGreaterThan(0.35 * size)
  })

  it('wires the desk app window icon to an exported PNG', async () => {
    // @ts-expect-error plain-node electron helper, no type declarations
    const { APP_ICON } = await import('../../electron/app-meta.mjs')
    expect(existsSync(APP_ICON), APP_ICON).toBe(true)
    expect(readFileSync(join(ROOT, 'electron/main.mjs'), 'utf8')).toMatch(/icon: APP_ICON/)
  })
})
