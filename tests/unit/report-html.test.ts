import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error plain-node action helper, no type declarations
import * as sticky from '../../action/sticky-comment.cjs'
// @ts-expect-error plain-node build script, no type declarations
import { buildBrand, buildReportAssets } from '../../scripts/build-brand.mjs'
import { renderManifestComment } from '../../src/report/comment.js'
import { renderReportHtml, REPORT_HTML, type ReportHtmlInput } from '../../src/report/html.js'
import type { RunManifest } from '../../src/report/manifest.js'
import { writeEvidenceReport } from '../../src/pipeline/verify.js'
import { fixtureManifest } from '../fixtures/manifest.js'

/**
 * HTML evidence report (plan U14, R22; DESIGN.md 7.6, A17). One offline
 * `report.html` per run: inline CSS, fonts, glyph sprite; no network.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const FIXTURES = join(ROOT, 'fixtures', 'manifests')
const REPO_LINK = 'https://github.com/duketopceo/Argus'
const RUN_URL = 'https://github.com/acme/shop/actions/runs/123456'
const BUDGET = 400 * 1024

interface Fixture {
  manifest?: unknown
  manifestRaw?: string | null
  codeReview?: unknown
  report?: unknown
  version: string
  runUrl: string
}

const fixtureNames = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort()

function inputFor(name: string): ReportHtmlInput {
  const f = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture
  const manifestText =
    f.manifestRaw !== undefined
      ? (f.manifestRaw ?? undefined)
      : f.manifest !== undefined
        ? JSON.stringify(f.manifest)
        : undefined
  return {
    manifestText,
    codeReview: f.codeReview,
    run: f.report,
    version: f.version,
    runUrl: f.runUrl,
  }
}

/** Every opening tag that must close, checked as a stack. */
function unbalancedTags(html: string): string[] {
  const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'use', 'path', 'circle', 'rect'])
  const body = html
    .replace(/<!doctype html>/i, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const stack: string[] = []
  const errors: string[] = []
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const [, close, rawName, selfClose] = m
    const name = rawName!.toLowerCase()
    if (selfClose === '/' || VOID.has(name)) continue
    if (close === '') stack.push(name)
    else if (stack.pop() !== name) errors.push(`unexpected </${name}>`)
  }
  return [...errors, ...stack.map((s) => `unclosed <${s}>`)]
}

describe('HTML evidence report (U14)', () => {
  it.each(fixtureNames)('%s renders a valid, self-contained document', (name) => {
    const html = renderReportHtml(inputFor(name))
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toMatch(/<html lang="en">/)
    expect(html).toMatch(/<meta charset="utf-8">/)
    expect(html).toMatch(/<title>[^<]+<\/title>/)
    expect(unbalancedTags(html)).toEqual([])
    // No resource is ever fetched: no src/srcset/url() outside data: or a
    // fragment, no external stylesheet or script, no @import.
    for (const m of html.matchAll(/\b(?:src|srcset|poster)="([^"]*)"/g)) {
      expect(m[1]!.startsWith('data:') || m[1]!.startsWith('#'), m[0]).toBe(true)
    }
    for (const m of html.matchAll(/url\(\s*['"]?([^'")]*)/g)) {
      expect(m[1]!.startsWith('data:') || m[1]!.startsWith('#'), m[0]).toBe(true)
    }
    expect(html).not.toMatch(/<link\b[^>]*rel="?stylesheet/i)
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i)
    expect(html).not.toMatch(/@import/)
    // Navigation links only to GitHub: the repo link and the run page.
    for (const m of html.matchAll(/href="(https?:[^"]*)"/g)) {
      expect(m[1]!.startsWith('https://github.com/'), m[0]).toBe(true)
    }
    expect(html).toContain(`href="${REPO_LINK}"`)
    expect(html).toContain(`href="${RUN_URL}"`)
  })

  it.each(fixtureNames)('%s stays under the 400 KB budget without screenshots', (name) => {
    expect(Buffer.byteLength(renderReportHtml(inputFor(name)))).toBeLessThanOrEqual(BUDGET)
  })

  it.each(fixtureNames)('%s contains no emoji and no em-dash', (name) => {
    const html = renderReportHtml(inputFor(name))
    expect(html).not.toMatch(/\p{Extended_Pictographic}|\u{FE0F}/u)
    expect(html).not.toContain('—')
  })

  it('renders the 7.6 sections in reading order: header, lanes, findings, flow, heals, ledger', () => {
    const html = renderReportHtml(inputFor('mixed-four-lane'))
    const order = ['id="verdict"', 'id="lanes"', 'id="findings"', 'id="flow"', 'id="heals"', 'id="ledger"']
    const at = order.map((id) => html.indexOf(id))
    for (const i of at) expect(i).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // Verdict, proof strength, head binding and spend sit in the header.
    const header = html.slice(at[0]!, at[1]!)
    expect(header).toContain('needs changes')
    expect(header).toContain('reproduced')
    expect(header).toContain('a1b2c3d')
    expect(header).toContain('match')
    expect(header).toContain('$0.004210')
  })

  it('escapes hostile strings and masks secret-shaped tokens everywhere', () => {
    const hostile = '<img src=x onerror=alert(1)> "quoted" & sk-or-v1-abcdefabcdef0123 ghp_abcdefghijklmnop'
    const m = fixtureManifest()
    m.runId = `run-${hostile}`
    m.lanes.flow.reason = hostile
    m.lanes.review.model = hostile
    m.identity.repo = hostile
    const html = renderReportHtml({
      manifestText: JSON.stringify(m),
      codeReview: {
        ok: false,
        verdict: 'needs_changes',
        findings: [
          {
            file: `src/${hostile}.ts`,
            line: 3,
            severity: 'bug',
            message: hostile,
            suggestion: hostile,
            evidence: { status: 'reproduced', detail: hostile },
          },
        ],
      },
      run: {
        ok: false,
        durationMs: 10,
        totals: { tests: 1, passed: 0, visionCostUsd: 0 },
        tests: [
          {
            name: hostile,
            file: 'a.test.ts',
            ok: false,
            failureMessage: hostile,
            steps: [{ instruction: hostile, action: hostile, ok: false, healed: true, model: hostile, reason: hostile }],
            healEvents: [{ instruction: hostile, model: hostile }],
          },
        ],
      },
      version: '0.4.0',
      runUrl: RUN_URL,
    })
    expect(html).not.toContain('<img src=x')
    expect(html).not.toMatch(/onerror=alert\(1\)>/)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('sk-or-v1-abcdefabcdef0123')
    expect(html).not.toContain('ghp_abcdefghijklmnop')
    expect(html).toContain('•••')
    expect(unbalancedTags(html)).toEqual([])
  })

  it('masks secrets in the hostile fixture and never links a hostile sha', () => {
    const html = renderReportHtml(inputFor('hostile'))
    expect(html).not.toMatch(/sk-or-v1-(headleak|leak-here)/)
    expect(html).not.toContain('href="https://evil.example')
  })

  it('renders a manifest missing the flow lane as unavailable: evidence missing', () => {
    const m = fixtureManifest() as unknown as { lanes: Record<string, unknown> }
    delete m.lanes.flow
    const html = renderReportHtml({ manifestText: JSON.stringify(m), version: '0.4.0' })
    const flow = html.slice(html.indexOf('id="flow"'), html.indexOf('id="heals"'))
    expect(flow).toContain('◌')
    expect(flow).toContain('unavailable: evidence missing')
    // The other lanes still render from the manifest.
    const lanes = html.slice(html.indexOf('id="lanes"'), html.indexOf('id="findings"'))
    expect(lanes).toMatch(/◌ <\/span><span>unavailable<\/span><\/span>[\s\S]*evidence missing/)
    expect(lanes).toContain('expected state verified')
    expect(html).not.toContain('Manifest unreadable')
  })

  it('renders the unreadable state for a corrupt manifest instead of throwing', () => {
    for (const manifestText of ['{"schemaVersion":', '{"schemaVersion":1}', 'null', '[]']) {
      const html = renderReportHtml({ manifestText, version: '0.4.0' })
      expect(html).toContain('Manifest unreadable')
      expect(html).toContain('argus-reviewer verify')
      expect(unbalancedTags(html)).toEqual([])
    }
    const missing = renderReportHtml({ manifestText: undefined, version: '0.4.0' })
    expect(missing).toContain('No manifest')
  })

  it('embeds fonts, glyph sprite and tokens from the generated module, so a packed install needs no assets/', () => {
    const src = readFileSync(join(ROOT, 'src/report/html.ts'), 'utf8')
    expect(src).not.toMatch(/from 'node:(fs|path|url)'/)
    const html = renderReportHtml(inputFor('passed'))
    expect(html.match(/url\(data:font\/woff2;base64,/g)?.length).toBeGreaterThanOrEqual(3)
    expect(html).toContain('<symbol id="status-passed"')
    expect(html).toContain('<symbol id="proof-4"')
    expect(html).toContain('--argus-color-canvas')
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/)
  })

  it('ships a generated asset module that matches the brand build', () => {
    const committed = readFileSync(join(ROOT, 'src/report/brand-assets.generated.ts'), 'utf8')
    expect(committed).toBe(buildReportAssets(buildBrand()))
  })

  it('hides interactive controls in the print stylesheet and prints details open', () => {
    const html = renderReportHtml(inputFor('mixed-four-lane'))
    const print = /@media print\s*\{([\s\S]*?)\n\}/.exec(html)?.[1] ?? ''
    expect(print).toMatch(/\.control\b[^{]*\{[^}]*display:\s*none/)
    expect(print).toContain('::details-content')
    for (const m of html.matchAll(/<(button|nav)\b[^>]*>/g)) {
      expect(m[0], m[0]).toMatch(/class="[^"]*\bcontrol\b/)
    }
    expect(html).toMatch(/<button\b/)
  })
})

describe('writeEvidenceReport (U14)', () => {
  it('writes report.html beside run-manifest.json from this run’s lane reports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-report-html-'))
    const m: RunManifest = fixtureManifest()
    m.lanes.review.reportPath = 'reports/code-review.json'
    await writeFile(
      join(dir, 'code-review.json'),
      JSON.stringify({ ok: true, verdict: 'approve', findings: [{ file: 'src/x.ts', line: 1, severity: 'nit', message: 'tidy name' }] }),
    )
    const path = await writeEvidenceReport(dir, m, { version: '0.4.0' })
    expect(path).toBe(join(dir, REPORT_HTML))
    const html = await readFile(path, 'utf8')
    expect(html).toContain('tidy name')
  })

  it('ignores a leftover lane report the manifest does not point at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-report-html-'))
    const m: RunManifest = fixtureManifest()
    m.lanes.review.reportPath = undefined
    await writeFile(
      join(dir, 'code-review.json'),
      JSON.stringify({ ok: true, findings: [{ file: 'stale.ts', severity: 'bug', message: 'stale residue' }] }),
    )
    const html = await readFile(await writeEvidenceReport(dir, m, { version: '0.4.0' }), 'utf8')
    expect(html).not.toContain('stale residue')
  })

  it('verify writes report.html and replaces a planted one', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'argus-verify-report-'))
    const reportDir = join(cwd, 'reports')
    await writeFile(join(cwd, 'argus-reviewer.config.json'), JSON.stringify({ reportDir }))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(reportDir, { recursive: true })
    await writeFile(join(reportDir, REPORT_HTML), 'PLANTED')
    const { main } = await import('../../src/cli.js')
    await main(['verify', '--a0'], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      out: () => undefined,
      err: () => undefined,
      exec: async () => ({ code: 1, stdout: '', stderr: 'ENOENT: a0 not found' }),
      probe: async () => false,
    })
    const html = await readFile(join(reportDir, REPORT_HTML), 'utf8')
    expect(html).not.toContain('PLANTED')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('a0')
  }, 60_000)
})

describe('comment footer names report.html (KTD12, Q13)', () => {
  const m = fixtureManifest()
  const manifestState = { state: 'ok', manifest: m }
  const ev = {
    hasKey: true,
    runDisabled: false,
    eventName: 'pull_request',
    report: undefined,
    codeReview: undefined,
    manifestState,
    ok: false,
    reportDir: '/w/argus-reviewer-report',
    staleEvidence: [],
    runUrl: RUN_URL,
  }
  const footerOf = (body: string) => body.trimEnd().split('\n').at(-1)!

  it('links the run page and names the report path when a fresh manifest exists', () => {
    const body = sticky.renderSticky(
      { ...ev, reportHtml: 'argus-reviewer-report/report.html' },
      { version: '0.4.0' },
    ) as string
    expect(footerOf(body)).toBe(
      `<sub>Argus 0.4.0 · [workflow run and evidence](${RUN_URL}) · report \`argus-reviewer-report/report.html\` in the run artifacts · self-hosted, BYOK</sub>`,
    )
  })

  it('names no report when the manifest is not fresh, so a planted file is never pointed at', () => {
    const body = sticky.renderSticky(
      { ...ev, manifestState: { state: 'stale' }, reportHtml: 'argus-reviewer-report/report.html' },
      { version: '0.4.0' },
    ) as string
    expect(footerOf(body)).not.toContain('report.html')
  })

  it('the TS reference renderer agrees on the footer', () => {
    const cjs = sticky.renderManifestBody(m, undefined, RUN_URL, {
      version: '0.4.0',
      reportHtml: 'argus-reviewer-report/report.html',
    }) as string
    const ts = renderManifestComment(m, {
      version: '0.4.0',
      runUrl: RUN_URL,
      reportHtml: 'argus-reviewer-report/report.html',
    })
    expect(footerOf(ts)).toBe(footerOf(cjs))
  })
})
