#!/usr/bin/env node
// review-eval - offline review-corpus runner and metrics diff.
//
// Corpus JSON: [{ name, repo, base, head, labels? }]
//   repo    absolute path or https URL (cloned into --cache dir)
//   base    ref/sha the PR diverged from (merge-base source)
//   head    sha to check out and review
//   labels  optional [{ path, fromLine, toLine, valid, note? }] ground truth
//
// run:     node scripts/review-eval.mjs run --corpus c.json [--tag t]
//            replays each entry in a temp worktree via
//            `node dist/cli.js code-review --base <base>` and writes
//            docs/audits/eval/<tag|timestamp>.json + a metrics table.
// compare: node scripts/review-eval.mjs compare runA.json runB.json
//            prints per-metric deltas (adopt/reject evidence for U3+).
//
// Env: model/provider config comes from the reviewed repo's own
// argus-reviewer config or ambient env, exactly as a normal run does.
// Label match: same path, finding line within label's from..to window.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const CLI = join(REPO_ROOT, 'dist', 'cli.js')

const pathType = (p) =>
  /(^|\/)dist\//.test(p) || /\.min\.|\.map$|(^|\/)generated|lock$/i.test(p) ? 'generated'
    : /(^|\/)docs?\//.test(p) ? 'docs'
    : /(^|\/)tests?\//.test(p) ? 'test'
    : 'src'

const matchLabel = (finding, labels) =>
  labels.find(
    (l) =>
      l.path === finding.file &&
      typeof finding.line === 'number' &&
      finding.line >= l.fromLine &&
      finding.line <= l.toLine,
  )

// metricsFromReport: pure - unit-testable without a repo.
export function metricsFromReport(report, labels) {
  const findings = report.findings ?? []
  const posted = report.reviewComments ?? []
  const bySeverity = {}
  const byPathType = {}
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
    byPathType[pathType(f.file)] = (byPathType[pathType(f.file)] ?? 0) + 1
  }
  const m = {
    ok: report.ok,
    skipped: report.skipped,
    verdict: report.verdict,
    findings: findings.length,
    comments: posted.length,
    commentsOverflow: report.commentsOverflow ?? 0,
    bySeverity,
    byPathType,
    generatedPathComments: byPathType.generated ?? 0,
    droppedOutsideDiff: report.droppedUnanchored ?? 0,
    droppedReverted: report.droppedReverted ?? 0,
    nitShare: findings.length ? (bySeverity.nit ?? 0) / findings.length : 0,
  }
  if (labels?.length) {
    const hitLabels = new Set()
    let tp = 0
    for (const f of findings) {
      const l = matchLabel(f, labels)
      if (!l) continue
      if (l.valid) {
        tp++
        hitLabels.add(l)
      }
    }
    const validLabels = labels.filter((l) => l.valid)
    m.precision = findings.length ? tp / findings.length : 0
    m.recall = validLabels.length ? hitLabels.size / validLabels.length : 0
    m.tp = tp
    m.validLabels = validLabels.length
  }
  return m
}

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function resolveRepo(repo, cacheDir) {
  if (existsSync(repo)) return resolve(repo)
  const dest = join(cacheDir, repo.replace(/[^a-zA-Z0-9]/g, '_'))
  if (!existsSync(dest)) {
    console.error(`clone ${repo} -> ${dest}`)
    execFileSync('git', ['clone', '--quiet', repo, dest], { stdio: 'inherit' })
  } else {
    git(dest, ['fetch', '--quiet', 'origin'])
  }
  return dest
}

async function run(corpusPath, tag, cacheDir) {
  if (!existsSync(CLI)) {
    console.error('dist/cli.js missing - run npm run build first')
    process.exit(2)
  }
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
  const results = []
  for (const entry of corpus) {
    const repo = resolveRepo(entry.repo, cacheDir)
    const wt = mkdtempSync(join(tmpdir(), 'argus-eval-wt-'))
    const reportDir = mkdtempSync(join(tmpdir(), 'argus-eval-report-'))
    try {
      git(repo, ['worktree', 'add', '--detach', '--force', wt, entry.head])
      const t0 = Date.now()
      let code = 0
      try {
        execFileSync(
          process.execPath,
          [CLI, 'code-review', '--base', entry.base, '--report-dir', reportDir],
          { cwd: wt, stdio: 'inherit', env: process.env, timeout: 900_000 },
        )
      } catch (e) {
        code = e.status ?? 1
      }
      const ms = Date.now() - t0
      const reportPath = join(reportDir, 'code-review.json')
      const report = existsSync(reportPath)
        ? JSON.parse(readFileSync(reportPath, 'utf8'))
        : { ok: false, skipped: true, summary: `exit ${code}` }
      const metrics = metricsFromReport(report, entry.labels)
      const stalled = code !== 0 || !existsSync(reportPath)
      results.push({ name: entry.name, ms, exitCode: code, stalled, metrics, reportPath })
      console.error(
        `${entry.name}: findings=${metrics.findings} comments=${metrics.comments}` +
          (metrics.precision !== undefined
            ? ` precision=${metrics.precision.toFixed(2)} recall=${metrics.recall.toFixed(2)}`
            : '') +
          ` (${(ms / 1000).toFixed(0)}s)`,
      )
    } finally {
      try {
        git(repo, ['worktree', 'remove', '--force', wt])
      } catch {
        rmSync(wt, { recursive: true, force: true })
      }
      rmSync(reportDir, { recursive: true, force: true })
    }
  }
  const summary = {
    tag: tag ?? new Date().toISOString().replace(/[:.]/g, '-'),
    at: new Date().toISOString(),
    cli: git(REPO_ROOT, ['rev-parse', '--short', 'HEAD']),
    entries: results.length,
    results,
  }
  const outDir = join(REPO_ROOT, 'docs', 'audits', 'eval')
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, `${summary.tag}.json`)
  writeFileSync(out, JSON.stringify(summary, null, 2))
  console.log(`\nwrote ${out}`)
  printTable(results)
}

function printTable(results) {
  console.log('\nentry | findings | comments | nit% | gen-path | precision | recall | drop(od/rev) | stalled')
  for (const r of results) {
    const m = r.metrics
    const stalled = r.stalled === true || r.exitCode !== 0 ? 'yes' : 'no'
    console.log(
      `${r.name} | ${m.findings} | ${m.comments} | ${(m.nitShare * 100).toFixed(0)}% | ` +
        `${m.generatedPathComments} | ${m.precision?.toFixed(2) ?? '-'} | ` +
        `${m.recall?.toFixed(2) ?? '-'} | ${m.droppedOutsideDiff}/${m.droppedReverted} | ${stalled}`,
    )
  }
}

function compare(aPath, bPath) {
  const a = JSON.parse(readFileSync(aPath, 'utf8'))
  const b = JSON.parse(readFileSync(bPath, 'utf8'))
  const byName = new Map(a.results.map((r) => [r.name, r]))
  console.log('entry | Δfindings | Δcomments | Δnit% | Δgen-path | Δprecision | Δrecall | stalled')
  for (const r of b.results) {
    const stalled = r.stalled === true || r.exitCode !== 0 ? 'yes' : 'no'
    const m0 = byName.get(r.name)?.metrics
    const m1 = r.metrics
    if (!m0) {
      console.log(`${r.name} | new entry`)
      continue
    }
    const d = (k) => (m1[k] - m0[k]).toFixed(2)
    console.log(
      `${r.name} | ${m1.findings - m0.findings} | ${m1.comments - m0.comments} | ` +
        `${d('nitShare')} | ${m1.generatedPathComments - m0.generatedPathComments} | ` +
        `${m1.precision !== undefined && m0.precision !== undefined ? d('precision') : '-'} | ` +
        `${m1.recall !== undefined && m0.recall !== undefined ? d('recall') : '-'} | ${stalled}`,
    )
  }
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedAsScript) {
  const [cmd, ...rest] = process.argv.slice(2)
  const arg = (name, dflt) => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : dflt
  }
  if (cmd === 'run') {
    const corpus = arg('corpus')
    if (!corpus) {
      console.error('usage: run --corpus <file> [--tag t] [--cache dir]')
      process.exit(2)
    }
    await run(resolve(corpus), arg('tag'), arg('cache', join(tmpdir(), 'argus-eval-repos')))
  } else if (cmd === 'compare') {
    const [a, b] = rest.filter((x) => !x.startsWith('--'))
    if (!a || !b) {
      console.error('usage: compare <runA.json> <runB.json>')
      process.exit(2)
    }
    compare(resolve(a), resolve(b))
  } else {
    console.error('usage: review-eval.mjs run|compare (see header)')
    process.exit(2)
  }
}
