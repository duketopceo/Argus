import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * README demo casts (plan U17, R27, R32). The tapes in assets/demo/ are
 * recorded by scripts/demo-record.mjs in a staged clean environment; these
 * checks keep a future tape from leaking personal tooling, a home path or a
 * key into frame, and keep the seeded flow cache honest about its origin.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const DEMO = join(ROOT, 'assets/demo')
const tapes = readdirSync(DEMO)
  .filter((f) => f.endsWith('.tape'))
  .sort()

/** Strings that must never appear in anything a cast types, sources or shows. */
export const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'omaseal', re: /omaseal/i },
  { name: '1password', re: /1password|\bop read\b/i },
  { name: 'home path', re: /\/home\/|\/Users\/|~\// },
  { name: 'API key value', re: /OPENROUTER_API_KEY\s*=\s*\S/ },
  { name: 'key-shaped literal', re: /sk-or-v1-|sk-ant-/ },
  { name: 'desktop notification', re: /notify-send|osascript/ },
]

/** Every file the casts type, source or replay. */
function castInputs(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    )
  return [...walk(DEMO), ...walk(join(ROOT, 'fixtures/demo-cache'))]
}

export function leaks(text: string): string[] {
  return FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.name)
}

describe('demo tapes', () => {
  it('there are the three README casts', () => {
    expect(tapes).toEqual(['init.tape', 'run-cache-hit.tape', 'verify.tape'])
  })

  it('the leak scan catches each forbidden string', () => {
    expect(leaks('Type "omaseal get openrouter default"')).toEqual(['omaseal'])
    expect(leaks('Type "cd /home/someone/app"')).toEqual(['home path'])
    expect(leaks('Env OPENROUTER_API_KEY=sk-or-v1-abc')).toEqual(['API key value', 'key-shaped literal'])
    expect(leaks('Type "notify-send done"')).toEqual(['desktop notification'])
    expect(leaks('Type "argus-reviewer run"')).toEqual([])
  })

  it.each(castInputs().map((p) => [relative(ROOT, p)]))('%s has no forbidden string', (path) => {
    expect(leaks(readFileSync(join(ROOT, path), 'utf8'))).toEqual([])
  })

  const theme = JSON.parse(readFileSync(join(DEMO, 'theme.json'), 'utf8')) as Record<string, string>

  it.each(tapes)('%s sets the font, width, theme and clean profile', (tape) => {
    const text = readFileSync(join(DEMO, tape), 'utf8')
    expect(text).toMatch(/^Set FontFamily "Martian Mono"$/m)
    expect(text).toMatch(/^Set Width 1100$/m)
    expect(text).toMatch(/^Set Shell "bash"$/m)
    const themeLine = /^Set Theme (\{.*\})$/m.exec(text)
    expect(themeLine).not.toBeNull()
    expect(JSON.parse(themeLine![1]!)).toEqual(theme)
    // The profile is sourced inside Hide, before anything is shown.
    const hide = text.indexOf('\nHide\n')
    const source = text.indexOf('source ./shell-profile.sh')
    const show = text.indexOf('\nShow\n')
    expect(hide).toBeGreaterThan(-1)
    expect(source).toBeGreaterThan(hide)
    expect(show).toBeGreaterThan(source)
    expect(text).toMatch(new RegExp(`^Output out/${tape.replace('.tape', '')}\\.mp4$`, 'm'))
  })

  it('the terminal theme is the dark Ocellus ANSI map', () => {
    const tokens = JSON.parse(readFileSync(join(ROOT, 'assets/brand/tokens.json'), 'utf8')) as {
      color: { dark: Record<string, { $value: { hex: string } }> }
    }
    const dark = (k: string) => tokens.color.dark[k]!.$value.hex
    expect(theme.background).toBe(dark('canvas'))
    expect(theme.foreground).toBe(dark('ink'))
    expect(theme.green).toBe(dark('passed'))
    expect(theme.red).toBe(dark('failed'))
    expect(theme.yellow).toBe(dark('caution'))
    expect(theme.blue).toBe(dark('accent'))
  })

  it('the clean profile drops history and any key', () => {
    const profile = readFileSync(join(DEMO, 'shell-profile.sh'), 'utf8')
    expect(profile).toContain('unset HISTFILE')
    expect(profile).toMatch(/unset [^\n]*OPENROUTER_API_KEY/)
    expect(profile).toContain('set +o history')
  })
})

describe('seeded demo flow cache', () => {
  const flow = JSON.parse(readFileSync(join(ROOT, 'fixtures/demo-cache/checkout.flow.json'), 'utf8')) as {
    steps: { model: string }[]
    asserts: { model: string }[]
  }

  it('labels every entry as scripted, never as a model verdict', () => {
    const models = [...flow.steps, ...flow.asserts].map((e) => e.model)
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) expect(m).toBe('demo-seed (scripted, no model call)')
  })
})

describe('README casts', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

  it.each(tapes.map((t) => t.replace('.tape', '')))('embeds %s.gif within the 3 MB budget', (name) => {
    const rel = `docs/assets/demo/${name}.gif`
    expect(readme).toContain(`src="${rel}"`)
    expect(statSync(join(ROOT, rel)).size).toBeLessThanOrEqual(3 * 1024 * 1024)
  })

  it('does not present the contributor tools as consumer features', () => {
    for (const line of readme.split('\n')) {
      if (/npm run (watch|app)\b/.test(line)) expect(line).toMatch(/contributor/i)
    }
  })
})
