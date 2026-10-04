import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  commentToHtml,
  fixtureSpendUsd,
  formatUsd,
  frameHtml,
  HERO_SCALE,
  HERO_WIDTH,
  keyRefusal,
  loadSource,
  OUT_DIR,
  SOCIAL,
  SOURCE_FIXTURE,
} from '../../scripts/render-brand.mjs'

const ROOT = join(import.meta.dirname, '..', '..')

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const buf = readFileSync(path)
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

describe('render-brand source (U16, R26)', () => {
  it('reads the fixture and its committed comment golden', () => {
    const { fixture, markdown } = loadSource()
    expect(fixture.body).toBe('review-only')
    expect(markdown.startsWith('<!-- argus-reviewer -->\n### Argus: ')).toBe(true)
  })

  it('fails clearly, naming the regenerate command, when the golden is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'render-brand-'))
    mkdirSync(join(root, 'fixtures', 'manifests'), { recursive: true })
    copyFileSync(
      join(ROOT, 'fixtures', 'manifests', `${SOURCE_FIXTURE}.json`),
      join(root, 'fixtures', 'manifests', `${SOURCE_FIXTURE}.json`),
    )
    expect(() => loadSource(SOURCE_FIXTURE, root)).toThrow(/comment golden .* is missing[\s\S]*UPDATE_GOLDENS=1/)
    expect(() => loadSource('no-such-fixture', root)).toThrow(/fixture .* is missing/)
  })

  it('shows the spend the fixture recorded, as the comment header prints it', () => {
    const { fixture, markdown } = loadSource()
    const spend = formatUsd(fixtureSpendUsd(fixture))
    expect(spend).toBe('$0.000739')
    expect(markdown.split('\n')[3]).toMatch(new RegExp(`· \\${spend}$`))
  })

  it('prints spend at 6 decimals up to $0.01 and 4 above (DESIGN.md 6.2)', () => {
    expect(formatUsd(0.0007393176)).toBe('$0.000739')
    expect(formatUsd(0.01)).toBe('$0.010000')
    expect(formatUsd(1.23456)).toBe('$1.2346')
  })

  it('refuses to run while OPENROUTER_API_KEY is set (R32)', () => {
    expect(keyRefusal({ OPENROUTER_API_KEY: 'x' })).toMatch(/refusing/)
    expect(keyRefusal({})).toBe('')
  })
})

describe('comment markdown to HTML', () => {
  it('renders the golden: heading, verdict line, lane table, folds and footer', () => {
    const html = frameHtml(loadSource().markdown)
    expect(html).not.toContain('{{body}}')
    expect(html).toContain('<h3>Argus: ⊘ needs changes</h3>')
    expect(html).toContain('<p><strong>3 findings, none reproduced</strong> · $0.000739</p>')
    expect(html).toContain('<th align="right">Spend</th>')
    expect(html).toContain('<td>▰▱▱▱ suspected</td><td align="right">$0.000739</td>')
    expect(html).toContain('<summary>Findings (3)</summary>')
    expect(html).toContain('<sub>Argus 0.4.0 · <a href="https://github.com/acme/shop/actions/runs/123456">')
    expect(html).not.toMatch(/<details open/)
  })

  it('escapes HTML, keeps code spans literal, and unescapes table pipes', () => {
    expect(commentToHtml('| A | B |\n|---|---|\n| `<x>` a\\|b | **b** *c* |')).toBe(
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><code>&lt;x&gt;</code> a|b</td><td><strong>b</strong> <em>c</em></td></tr></tbody></table>',
    )
    expect(commentToHtml('a <script>x</script> line<br>two')).toBe('<p>a &lt;script&gt;x&lt;/script&gt; line<br>two</p>')
    expect(commentToHtml('see ``a`b`` here')).toBe('<p>see <code>a`b</code> here</p>')
  })

  it('throws on markdown the comment never emits, instead of guessing', () => {
    expect(() => commentToHtml('````suggestion\nx\n````')).toThrow(/unsupported markdown/)
    expect(() => commentToHtml('<div>raw</div>')).toThrow(/unsupported markdown/)
  })
})

describe('committed renders', () => {
  it('social card is 1280x640 and within the 300 KB budget (DESIGN.md 10)', () => {
    const path = join(ROOT, OUT_DIR, 'social.png')
    expect(pngSize(path)).toEqual(SOCIAL)
    expect(statSync(path).size).toBeLessThanOrEqual(300 * 1024)
  })

  it.each(['light', 'dark'])('hero %s is the 2x hero width and within the 250 KB budget', (theme) => {
    const path = join(ROOT, OUT_DIR, `hero-${theme}.png`)
    expect(pngSize(path).width).toBe(HERO_WIDTH * HERO_SCALE)
    expect(statSync(path).size).toBeLessThanOrEqual(250 * 1024)
  })

  it('the README shows the hero in both themes and its alt text states the rendered spend', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    expect(readme).toContain('<source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png" />')
    expect(readme).toContain('<img src="docs/assets/hero-light.png"')
    const { fixture } = loadSource()
    expect(readme).toContain(`metered spend ${formatUsd(fixtureSpendUsd(fixture))}.`)
  })
})
