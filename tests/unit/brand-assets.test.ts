import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'
import { optimize } from 'svgo'
import { describe, expect, it } from 'vitest'

import {
  buildBrand,
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
  (m) => !m.rel.startsWith(GLYPH_PREFIX) && !m.rel.startsWith(ICON_PREFIX),
)
const glyphs = allMasters.filter((m) => m.rel.startsWith(GLYPH_PREFIX))
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
      if (rel.endsWith('.svg') && rel !== 'glyphs.svg' && !rel.startsWith(ICON_PREFIX))
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
