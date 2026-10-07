#!/usr/bin/env node
// review-eval - offline review-corpus runner and metrics diff.
//
// Corpus JSON: [{ name, repo, base, head, labels? }]
//   repo    absolute path or https URL (init'd into --cache dir, only the
//           entry's two SHAs fetched - no full clone)
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
      (l.fileLevel === true ||
        (typeof finding.line === 'number' &&
          finding.line >= l.fromLine &&
          finding.line <= l.toLine)),
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

// ensureSha: fetch a single commit at depth 1. GitHub serves
// reachable-sha-in-want, so `git fetch origin <sha>` lands any PR commit —
// no clone of the repo's full history needed.
function ensureSha(repo, sha) {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`])
    return
  } catch {
    /* not fetched yet */
  }
  console.error(`  fetch ${sha.slice(0, 12)}`)
  execFileSync('git', ['-C', repo, 'fetch', '--quiet', '--depth', '1', 'origin', sha], {
    stdio: 'inherit',
  })
}

// mergeBase: '' when the shallow boundary hides the shared ancestor.
function mergeBase(repo, a, b) {
  try {
    return git(repo, ['merge-base', a, b])
  } catch {
    return ''
  }
}

// The base and head SHAs share real ancestry (the PR source forked from
// base history), so merge-base exists — depth-1 fetches just hide it. A
// wrong merge-base would make `git diff <base>` report months of branch
// drift instead of the PR diff, so deepen both tips until it surfaces.
function ensureSharedHistory(repo, base, head) {
  let depth = 32
  for (let i = 0; i < 6 && mergeBase(repo, base, head) === ''; i++) {
    // One SHA per fetch: a single multi-ref deepen rewrites .git/shallow
    // twice under one transaction and can lose the race with itself
    // ("shallow file has changed since we read it").
    for (const sha of [base, head]) {
      try {
        execFileSync('git', ['-C', repo, 'fetch', '--quiet', `--deepen=${depth}`, 'origin', sha], {
          stdio: 'inherit',
        })
      } catch {
        // deepen failures are tolerated once per round - a shallow root
        // that already reaches the merge-base needs no more history
      }
    }
    depth *= 2
  }
  if (mergeBase(repo, base, head) === '') {
    throw new Error(`no merge-base between ${base.slice(0, 12)} and ${head.slice(0, 12)} after deepening`)
  }
}

function resolveRepo(entry, cacheDir) {
  const repo = entry.repo
  if (existsSync(repo)) return resolve(repo)
  const dest = join(cacheDir, repo.replace(/[^a-zA-Z0-9]/g, '_'))
  if (!existsSync(dest)) {
    console.error(`init ${repo} -> ${dest}`)
    mkdirSync(dest, { recursive: true })
    execFileSync('git', ['-C', dest, 'init', '--quiet'])
    execFileSync('git', ['-C', dest, 'remote', 'add', 'origin', repo])
  }
  ensureSha(dest, entry.base)
  ensureSha(dest, entry.head)
  ensureSharedHistory(dest, entry.base, entry.head)
  return dest
}

async function run(corpusPath, tag, cacheDir) {
  if (!existsSync(CLI)) {
    console.error('dist/cli.js missing - run npm run build first')
    process.exit(2)
  }
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
  const outDir = join(REPO_ROOT, 'docs', 'audits', 'eval')
  const keptDir = join(outDir, 'reports')
  mkdirSync(keptDir, { recursive: true })
  const results = []
  for (const entry of corpus) {
    let repo
    try {
      repo = resolveRepo(entry, cacheDir)
    } catch (e) {
      results.push({
        name: entry.name,
        ms: 0,
        exitCode: 2,
        stalled: true,
        metrics: { findings: 0, comments: 0, nitShare: 0, summary: String(e.message ?? e).slice(0, 200) },
      })
      console.error(`${entry.name}: repo setup failed - ${String(e.message ?? e).slice(0, 120)}`)
      continue
    }
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
      const keptReport = existsSync(reportPath)
        ? join(keptDir, `${entry.name.replace(/[^a-zA-Z0-9-]/g, '_')}.json`)
        : undefined
      if (keptReport) writeFileSync(keptReport, JSON.stringify(report, null, 2))
      results.push({ name: entry.name, ms, exitCode: code, stalled, metrics, reportPath: keptReport })
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
