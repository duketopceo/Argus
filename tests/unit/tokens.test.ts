import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildTokens, OUTPUT_FILES, parseFrontMatter } from '../../scripts/build-tokens.mjs'
import { checkContrast, contrastRatio } from '../../scripts/check-contrast.mjs'

const ROOT = join(import.meta.dirname, '..', '..')
const DESIGN = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8')

describe('token generation (KTD1)', () => {
  it('generating from DESIGN.md reproduces the committed outputs byte for byte', () => {
    const outputs = buildTokens(DESIGN)
    for (const file of OUTPUT_FILES) {
      const committed = readFileSync(join(ROOT, file), 'utf8')
      expect(outputs[file], `${file} is stale: run npm run tokens`).toBe(committed)
    }
  })

  it('editing a hex in DESIGN.md without regenerating is caught as drift', () => {
    const edited = DESIGN.replace('ink-3: "#5D6571"', 'ink-3: "#5D6572"')
    expect(edited).not.toBe(DESIGN)
    const outputs = buildTokens(edited)
    const committedCss = readFileSync(join(ROOT, 'assets/brand/tokens.css'), 'utf8')
    const committedJson = readFileSync(join(ROOT, 'assets/brand/tokens.json'), 'utf8')
    expect(outputs['assets/brand/tokens.css']).not.toBe(committedCss)
    expect(outputs['assets/brand/tokens.json']).not.toBe(committedJson)
  })

  it('fails when light and dark color key sets differ, naming the missing keys', () => {
    const darkStart = DESIGN.indexOf('\n  dark:\n')
    expect(darkStart).toBeGreaterThan(0)
    const head = DESIGN.slice(0, darkStart)
    const tail = DESIGN.slice(darkStart)
    const strip = (s: string, key: string) => s.replace(new RegExp(`^ {4}${key}: "#[0-9A-Fa-f]{6}"\\n`, 'm'), '')

    // Dark block loses `raised`: the light block still has it.
    expect(() => buildTokens(head + strip(tail, 'raised'))).toThrow(/dark is missing: raised/)
    // Light block loses `surface-sunk`: the dark block still has it.
    expect(() => buildTokens(strip(head, 'surface-sunk') + tail)).toThrow(/light is missing: surface-sunk/)
  })

  it('emits light values in :root and dark values under prefers-color-scheme', () => {
    const css = buildTokens(DESIGN)['assets/brand/tokens.css']
    const [light, dark] = css.split('@media (prefers-color-scheme: dark)')
    expect(light).toContain('--argus-color-canvas: #F4F5F7;')
    expect(dark).toContain('--argus-color-canvas: #0C0E12;')
    expect(light).toContain('--argus-space-12: 12px;')
    expect(light).toContain('--argus-radius-sm: 4px;')
    expect(light).toContain('--argus-motion-state: 180ms;')
    expect(light).toContain('--argus-motion-ease-out: cubic-bezier(0.2, 0, 0, 1);')
  })

  it('keeps hex canonical in tokens.json with an OKLCH value alongside', () => {
    const json = JSON.parse(buildTokens(DESIGN)['assets/brand/tokens.json'])
    const canvas = json.color.light.canvas
    expect(canvas.$type).toBe('color')
    expect(canvas.$value.hex).toBe('#F4F5F7')
    expect(canvas.$extensions['argus.oklch']).toMatch(/^oklch\(0\.9\d+ 0\.\d+ \d+(\.\d+)?\)$/)
    // White is achromatic: L = 1, C = 0.
    expect(json.color.light.surface.$extensions['argus.oklch']).toBe('oklch(1 0 0)')
    expect(json.spacing['96'].$value).toEqual({ value: 96, unit: 'px' })
    expect(json.motion['ease-in-out'].$value).toEqual([0.4, 0, 0.2, 1])
  })

  it('maps status and text roles to ANSI-16 slots per DESIGN.md section 6.1', () => {
    const ansi = JSON.parse(buildTokens(DESIGN)['assets/brand/ansi.json'])
    expect(ansi.status.passed).toMatchObject({ role: 'passed', sgr: '32' })
    expect(ansi.status.failed).toMatchObject({ role: 'failed', sgr: '31' })
    expect(ansi.status.inconclusive).toMatchObject({ role: 'caution', sgr: '33' })
    expect(ansi.status.blocked).toMatchObject({ role: 'ink', sgr: '1' })
    expect(ansi.status.unavailable).toMatchObject({ role: 'ink-3', sgr: '2' })
    expect(ansi.status.skipped).toMatchObject({ role: 'ink-3', sgr: '2' })
    expect(ansi.roles.accent).toMatchObject({ sgr: '34', light: '#2343F5', dark: '#7D91FF' })
  })

  it('parses the token blocks it needs and nothing else', () => {
    const fm = parseFrontMatter(DESIGN)
    expect(fm.spacing).toEqual([0, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96])
    expect(fm.rounded.md).toBe(6)
    expect(fm.motion.panel).toBe('260ms')
    expect(Object.keys(fm.colors)).toEqual(['light', 'dark'])
  })
})

describe('contrast check (R29)', () => {
  it('computes WCAG ratios matching the published reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5)
    expect(contrastRatio('#0E1116', '#FFFFFF')).toBeCloseTo(18.9, 1)
  })

  it('reports every section 6.1 pair and all of them pass on the committed tokens', () => {
    const rows = checkContrast(parseFrontMatter(DESIGN).colors)
    const key = (r: { theme: string; fg: string; bg: string }) => `${r.theme}:${r.fg}/${r.bg}`
    const keys = rows.map(key)
    for (const theme of ['light', 'dark']) {
      for (const fg of ['ink', 'ink-2', 'ink-3', 'accent', 'passed', 'failed', 'caution']) {
        expect(keys).toContain(`${theme}:${fg}/canvas`)
        expect(keys).toContain(`${theme}:${fg}/surface`)
      }
      expect(keys).toContain(`${theme}:control-border/canvas`)
      expect(keys).toContain(`${theme}:hairline/surface`)
      expect(keys).toContain(`${theme}:on-accent/accent`)
      for (const s of ['passed', 'failed', 'caution']) expect(keys).toContain(`${theme}:${s}/${s}-tint`)
      // The two tokens U1 adds are checked as text backgrounds too.
      expect(keys).toContain(`${theme}:ink-3/surface-sunk`)
      expect(keys).toContain(`${theme}:ink-3/raised`)
    }
    const failing = rows.filter((r) => !r.pass)
    expect(failing.map(key)).toEqual([])
  })

  it('fails when a fixture token set lowers ink-3 below 4.5:1', () => {
    const colors = structuredClone(parseFrontMatter(DESIGN).colors)
    colors.light['ink-3'] = '#9AA0A8'
    const rows = checkContrast(colors)
    const failing = rows.filter((r) => !r.pass)
    expect(failing.length).toBeGreaterThan(0)
    expect(failing.every((r) => r.theme === 'light' && r.fg === 'ink-3')).toBe(true)
    expect(failing[0]!.min).toBe(4.5)
  })
})
