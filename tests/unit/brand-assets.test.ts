import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { optimize } from 'svgo'
import { describe, expect, it } from 'vitest'

import { buildBrand, EXPORT_DIR, readMasters } from '../../scripts/build-brand.mjs'

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

const masters = readMasters()
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

  it.each(masters.map((m) => [m.rel, m.svg]))('%s parses and is self-contained', (_rel, svg) => {
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
      if (rel.endsWith('.svg')) expect(buf.length, rel).toBeLessThanOrEqual(2048)
    }
  })
})
