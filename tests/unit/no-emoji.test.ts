import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Emoji, em-dash and codename lint (plan KTD11, R4, R5).
 *
 * Scope: every file under SCOPE. In JS/TS files only string, template and
 * regex literals are checked, because those are what reach users; comments
 * are not output. Other text files (YAML, HTML, JSON) are checked whole.
 *
 * Permanent allow-list: the `deriveSeverity` input parser and the review
 * prompt text (`buildCodeReviewMessages`) in src/cli.ts. Parsing emoji out of
 * model output stays allowed (R4).
 *
 * Temporary allow-list: TEMPORARY below. Each entry is the exact count of
 * literal sites still carrying an emoji or an em-dash, and the unit that
 * rewrites the file. Counts must match exactly, so a new emoji or em-dash
 * fails, and a removal fails until the count is lowered (or the entry
 * deleted). The list only shrinks.
 *
 * Codename check (R5, U3): the internal codename "Jev" may not appear in any
 * output literal under SCOPE or in the user-facing docs (USER_DOCS). It has
 * no allow-list. The real model slug (`typesafe/jev-...`) and the
 * JEV_DEFAULT_MODEL identifier stay allowed.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const SCOPE = ['src', 'action', 'scripts', 'electron', 'assets/brand/templates']

const EMOJI = /\p{Extended_Pictographic}|\u{FE0F}|[\u{1F1E6}-\u{1F1FF}]/u
const EM_DASH = '—'
/** Real model slugs that contain the codename; stripped before CODENAME runs. */
const ALLOWED_SLUG = /~?typesafe\/jev-[\w.-]+/gi
const CODENAME = /\bjev\b/i

function hasCodename(chunk: string): boolean {
  return CODENAME.test(chunk.replace(ALLOWED_SLUG, ''))
}

/**
 * Docs a consumer reads. DESIGN.md is left out on purpose: it is the
 * contributor design spec and quotes the codename as the defect to remove.
 * docs/plans and docs/brainstorms are historical working notes.
 */
const USER_DOCS = [
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'docs/quickstart.md',
  'docs/models.md',
  'docs/approval-token.md',
  'fixtures/demo-pr/README.md',
]

const JS_EXT = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])
const TEXT_EXT = new Set([...JS_EXT, '.html', '.yml', '.yaml', '.json', '.css', '.svg', '.md'])

/** Functions in src/cli.ts whose literals may carry emoji: model input, not output. */
const PERMANENT: Record<string, ReadonlySet<string>> = {
  'src/cli.ts': new Set(['deriveSeverity', 'buildCodeReviewMessages']),
}

interface Allowance {
  emoji?: number
  emdash?: number
  /** Unit that rewrites the file and removes the entry; null = no unit owns it. */
  unit: string | null
  why?: string
}

const NO_OWNER =
  'no later unit rewrites this file; R5 bans em-dashes in changed strings, so the exact count blocks new ones'

const TEMPORARY: Record<string, Allowance> = {
  // No unit owns these; the count is a ratchet, not a removal plan.
  // U6 cleaned the review comment, persist reply and code-review report text in src/cli.ts.
  // What remains is terminal stage lines, mention replies, run-report skip text, the
  // generated workflow text and the verbatim init cost block (DESIGN 7.8).
  'src/cli.ts': { emdash: 22, unit: null, why: NO_OWNER },
  // Moved verbatim from src/cli.ts (init must stay byte-identical).
  'src/onboarding/scaffold.ts': { emdash: 5, unit: null, why: NO_OWNER },
  'src/api.ts': { emdash: 1, unit: null, why: NO_OWNER },
  'src/driver/target.ts': { emdash: 1, unit: null, why: NO_OWNER },
  'src/engine/explore.ts': { emdash: 2, unit: null, why: NO_OWNER },
  'src/engine/loop.ts': { emdash: 1, unit: null, why: NO_OWNER },
  'src/engine/prompts.ts': { emdash: 4, unit: null, why: NO_OWNER },
  'src/evidence/link.ts': { emdash: 1, unit: null, why: NO_OWNER },
  'src/executor/a0.ts': { emdash: 6, unit: null, why: NO_OWNER },
  'src/mention.ts': { emdash: 9, unit: null, why: NO_OWNER },
  'src/pipeline/app.ts': { emdash: 4, unit: null, why: NO_OWNER },
  'src/probe/author.ts': { emdash: 3, unit: null, why: NO_OWNER },
  'src/probe/queue.ts': { emdash: 7, unit: null, why: NO_OWNER },
  'src/trust.ts': { emdash: 5, unit: null, why: 'changing src/trust.ts is a plan stop condition' },
  'action/emit-review.mjs': { emdash: 8, unit: null, why: NO_OWNER },
  'action/runtime.mjs': { emdash: 1, unit: null, why: NO_OWNER },
  'scripts/consumer-smoke.mjs': { emdash: 1, unit: null, why: NO_OWNER },
}

function relPath(abs: string): string {
  return relative(ROOT, abs).split(sep).join('/')
}

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (TEXT_EXT.has(extname(entry.name))) out.push(p)
  }
  return out
}

interface Site {
  kind: 'emoji' | 'emdash' | 'codename'
  line: number
  text: string
}

const LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
])

function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) return n.name.text
  }
  return undefined
}

/** Literal sites in `text` (as if it lived at repo path `file`) carrying an emoji or em-dash. */
export function scanSource(file: string, text: string): Site[] {
  const sites: Site[] = []
  const add = (chunk: string, line: number) => {
    if (EMOJI.test(chunk)) sites.push({ kind: 'emoji', line, text: chunk.slice(0, 120) })
    if (chunk.includes(EM_DASH)) sites.push({ kind: 'emdash', line, text: chunk.slice(0, 120) })
    if (hasCodename(chunk)) sites.push({ kind: 'codename', line, text: chunk.slice(0, 120) })
  }
  if (!JS_EXT.has(extname(file))) {
    text.split('\n').forEach((l, i) => add(l, i + 1))
    return sites
  }
  const kind = /\.[mc]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const permanent = PERMANENT[file]
  const visit = (node: ts.Node) => {
    if (LITERAL_KINDS.has(node.kind)) {
      const fn = permanent !== undefined ? enclosingFunctionName(node) : undefined
      if (fn === undefined || !permanent!.has(fn)) {
        add(node.getText(sf), sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

/** Problems for one file against the allow-list; empty when clean. */
function problemsFor(file: string, sites: Site[]): string[] {
  const allow = TEMPORARY[file]
  const problems: string[] = []
  for (const kind of ['emoji', 'emdash', 'codename'] as const) {
    const found = sites.filter((s) => s.kind === kind)
    const allowed = kind === 'codename' ? 0 : (allow?.[kind] ?? 0)
    if (found.length > allowed) {
      problems.push(
        `${file}: ${found.length} ${kind} site(s), allow-list permits ${allowed}\n` +
          found.map((s) => `    L${s.line}: ${s.text}`).join('\n'),
      )
    } else if (found.length < allowed) {
      problems.push(`${file}: ${kind} allowance is ${allowed} but only ${found.length} remain; lower it`)
    }
  }
  return problems
}

describe('no emoji or em-dash in output-producing code (KTD11)', () => {
  const files = SCOPE.flatMap((d) => walk(join(ROOT, d), []))

  it('scans the whole scope', () => {
    const rel = files.map(relPath)
    expect(rel).toContain('src/cli.ts')
    expect(rel).toContain('action/sticky-comment.cjs')
    expect(rel).toContain('scripts/build-tokens.mjs')
    expect(rel).toContain('electron/ui/app.js')
  })

  it('finds nothing outside the allow-lists', () => {
    const problems = files.flatMap((abs) => {
      const file = relPath(abs)
      return problemsFor(file, scanSource(file, readFileSync(abs, 'utf8')))
    })
    expect(problems.join('\n')).toBe('')
  })

  it('every temporary entry names its file and an owner decision', () => {
    for (const [file, allow] of Object.entries(TEMPORARY)) {
      expect(existsSync(join(ROOT, file)), file).toBe(true)
      expect(allow.unit !== null || allow.why !== undefined, file).toBe(true)
    }
  })

  it('flags an emoji added anywhere under src/, for example src/review/secrets.ts', () => {
    const path = 'src/review/secrets.ts'
    const real = readFileSync(join(ROOT, path), 'utf8')
    expect(problemsFor(path, scanSource(path, real))).toEqual([])
    const added = `${real}\nexport const done = 'secret masked ✅'\n`
    const problems = problemsFor(path, scanSource(path, added))
    expect(problems.join('\n')).toMatch(/src\/review\/secrets\.ts: \d+ emoji site\(s\)/)

    const clean = 'src/report/manifest.ts'
    const withEmoji = `${readFileSync(join(ROOT, clean), 'utf8')}\nconst x = '\u{1F534} bug'\n`
    expect(problemsFor(clean, scanSource(clean, withEmoji))).toHaveLength(1)
  })

  it('flags an em-dash in a string but not in a comment', () => {
    const file = 'src/report/manifest.ts'
    expect(scanSource(file, `// a — b\nconst s = 'ok'\n`)).toEqual([])
    expect(scanSource(file, `const s = \`a — \${1} b\`\n`).map((s) => s.kind)).toEqual(['emdash'])
  })

  it('ignores only the deriveSeverity regex and the review prompt text in src/cli.ts', () => {
    const parser = `function deriveSeverity(m: string) { return m.includes('\u{1F534}') || /\u{1F7E1}/.test(m) }\n`
    const prompt = `export function buildCodeReviewMessages() { return \`Severity emojis: bug = \u{1F534}\` }\n`
    const other = `function renderReviewComments() { return '\u{1F9EA} reproduced' }\n`
    expect(scanSource('src/cli.ts', parser + prompt)).toEqual([])
    expect(scanSource('src/cli.ts', other).map((s) => s.kind)).toEqual(['emoji'])
    // The exemption is tied to src/cli.ts; the same parser elsewhere is flagged.
    expect(scanSource('src/review/triage.ts', parser).map((s) => s.kind)).toEqual(['emoji', 'emoji'])
  })
})

describe('no internal codename in user-facing copy (R5, U3)', () => {
  it('finds no "Jev" in the user-facing docs outside the model slug', () => {
    const hits = USER_DOCS.flatMap((file) =>
      readFileSync(join(ROOT, file), 'utf8')
        .split('\n')
        .flatMap((l, i) => (hasCodename(l) ? [`${file}:${i + 1}: ${l.trim()}`] : [])),
    )
    expect(hits.join('\n')).toBe('')
  })

  it('allows the slug and identifier but flags the codename in prose and strings', () => {
    expect(hasCodename("decisionModel: 'typesafe/jev-1.13-20260917'")).toBe(false)
    expect(hasCodename('aliases like `~typesafe/jev-latest` drift')).toBe(false)
    expect(hasCodename('import { JEV_DEFAULT_MODEL } from x')).toBe(false)
    expect(hasCodename('Jev unavailable')).toBe(true)
    expect(hasCodename('Jev-adjudicated above threshold')).toBe(true)
    expect(hasCodename('typesafe/jev-1.13 failed; Jev retried')).toBe(true)
    const file = 'src/report/manifest.ts'
    expect(scanSource(file, `// Jev in a comment\nconst s = 'ok'\n`)).toEqual([])
    expect(scanSource(file, `const s = 'Jev unavailable'\n`).map((x) => x.kind)).toEqual(['codename'])
  })
})
