import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { optimize } from 'svgo'
import { describe, expect, it } from 'vitest'

import { buildBrand, EXPORT_DIR, GLYPH_PREFIX, readMasters } from '../../scripts/build-brand.mjs'
import { LANE_IDS, LANE_STATUSES } from '../../src/report/manifest.js'
import { PROOF_LEVELS, SEVERITIES } from '../../src/report/viewmodel.js'

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
const masters = allMasters.filter((m) => !m.rel.startsWith(GLYPH_PREFIX))
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
      if (rel.endsWith('.svg') && rel !== 'glyphs.svg')
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
