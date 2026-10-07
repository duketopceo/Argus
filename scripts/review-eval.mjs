#!/usr/bin/env node
// review-eval - offline review-corpus runner and metrics diff.
//
// Corpus JSON: [{ name, repo, base, head, labels? }]
//   repo    absolute path or https URL (init'd into --cache dir, only the
//           entry's two SHAs fetched - no full clone)
//   base    ref/sha the PR diverged from (merge-base source)
//   head    sha to check out and review
//   labels  optional [{ path, fromLine, toLine, valid, fileLevel?, category?, note? }]
//           ground truth; fileLevel:true matches any finding line on path
//
// run:     node scripts/review-eval.mjs run --corpus c.json [--tag t]
//            replays each entry in a temp worktree via
//            `node dist/cli.js code-review --base <base>` and writes
//            docs/audits/eval/<tag|timestamp>.json + a metrics table.
// compare: node scripts/review-eval.mjs compare runA.json runB.json
//            prints per-metric deltas (adopt/reject evidence for U3+).
//
// Env: model/provider config comes from the reviewed repo's own
// argus-reviewer config (trusted lanes only — scheduled/CI runs classify
// untrusted and evaluate with defaults plus ambient env).
// Label match: same path, finding line within label's from..to window.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const CLI = join(REPO_ROOT, 'dist', 'cli.js')

// Test detection shares the rules lane's vocabulary — the harness must
// bucket foo.test.ts/__tests__/test_x.py the same way missing-test does
// (collect.mjs already imports from dist/ for shared definitions). The
// import is best-effort: tally/compare read only run JSONs and must work
// without a build. FALLBACK mirrors src/review/testfiles.ts TEST_PATH.
const TEST_PATH_FALLBACK =
  /(^|\/)(tests?|__tests__|__mocks__|spec|e2e)\/|\.(test|spec)\.[^/]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/
let isTestPath = (p) => TEST_PATH_FALLBACK.test(p.replace(/^\.\//, ''))
try {
  ;({ isTestPath } = await import(new URL('../dist/review/testfiles.js', import.meta.url).href))
} catch {
  /* dist missing - metrics-only subcommands still work */
}

// Slugs carry a hash suffix — github.com/a/b vs github.com/a-b must not
// share a cache dir or a kept-report name.
const slug = (s) =>
  `${s.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 60)}-${createHash('sha1').update(s).digest('hex').slice(0, 8)}`

const pathType = (p) =>
  /(^|\/)dist\//.test(p) || /\.min\.|\.map$|\.generated\.|(^|\/)generated|\.lock$|[-_]lock\.(json|ya?ml|toml)$|(^|\/)(go\.sum|npm-shrinkwrap\.json)$/.test(p)
    ? 'generated'
    : /(^|\/)docs?\//.test(p) ? 'docs'
    : isTestPath(p) ? 'test'
    : 'src'

const matchLabel = (finding, labels) => {
  const inWindow = (l) =>
    l.path === finding.file &&
    (l.fileLevel === true ||
      (typeof finding.line === 'number' && finding.line >= l.fromLine && finding.line <= l.toLine))
  // Prefer a valid label when several share the window — first-match
  // ordering would let an invalid label shadow the truth at the same line.
  return labels.find((l) => l.valid && inWindow(l)) ?? labels.find(inWindow)
}

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
  const modelFindings = findings.filter((f) => !f.rule)
  const m = {
    ok: report.ok,
    skipped: report.skipped,
    verdict: report.verdict,
    findings: findings.length,
    ruleFindings: findings.length - modelFindings.length,
    comments: posted.length,
    commentsOverflow: report.commentsOverflow ?? 0,
    bySeverity,
    byPathType,
    // What reviewers actually see on generated paths — under nit
    // consolidation, generated-path nits never post, so findings-based
    // bucketing would overstate the noise this metric exists to measure.
    generatedPathComments: posted.filter((c) => pathType(c.path ?? '') === 'generated').length,
    droppedOutsideDiff: report.droppedUnanchored ?? 0,
    droppedReverted: report.droppedReverted ?? 0,
    nitShare: findings.length ? (bySeverity.nit ?? 0) / findings.length : 0,
  }
  if (labels?.length) {
    const hitLabels = new Set()
    let tp = 0
    let tpRules = 0
    for (const f of findings) {
      const l = matchLabel(f, labels)
      if (!l) continue
      if (l.valid) {
        hitLabels.add(l)
        if (f.rule) tpRules++
        else tp++
      }
    }
    const validLabels = labels.filter((l) => l.valid)
    // Precision measures the model lane: rules-lane findings are
    // deterministic nits that can never match a semantic label and would
    // otherwise read as systematic false positives. Recall still credits
    // any lane that catches a labeled issue.
    m.precision = modelFindings.length ? tp / modelFindings.length : 0
    m.recall = validLabels.length ? hitLabels.size / validLabels.length : 0
    m.tp = tp
    m.tpRules = tpRules
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
    timeout: 120_000,
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
          timeout: 120_000,
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
  // A leading '-' injects options into git argv (fetch/worktree add),
  // remote or local (CWE-88).
  for (const sha of [entry.base, entry.head]) {
    if (typeof sha !== 'string' || sha.startsWith('-')) {
      throw new Error(`${entry.name}: invalid SHA ${JSON.stringify(sha)}`)
    }
  }
  // Local paths anchor to REPO_ROOT, not cwd — `repo: "."` in a corpus
  // file means "the repo this harness lives in", wherever it is run from.
  if (!/^https?:\/\//.test(repo)) {
    const local = resolve(REPO_ROOT, repo)
    if (!existsSync(local)) throw new Error(`local repo not found: ${repo}`)
    return local
  }
  const dest = join(cacheDir, slug(repo))
  if (!existsSync(dest)) {
    console.error(`init ${repo} -> ${dest}`)
    mkdirSync(dest, { recursive: true })
    execFileSync('git', ['-C', dest, 'init', '--quiet'])
    execFileSync('git', ['-C', dest, 'remote', 'add', 'origin', repo])
  }
  // Remote entries take exactly a 40-hex SHA — refs could resolve to
  // anything the remote serves and abbreviated hex can't fetch
  // (sha-in-want needs the full OID).
  for (const sha of [entry.base, entry.head]) {
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error(`${entry.name}: ${sha} is not a full 40-hex SHA - remote entries require pinned SHAs`)
    }
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
  // The run file is rewritten after every entry so a kill mid-run still
  // leaves a valid partial summary for tally and artifact upload.
  const summary = {
    schemaVersion: 1,
    // Sanitized for filename use — a `--tag` with / or .. must not write
    // outside docs/audits/eval.
    tag: (tag ?? new Date().toISOString().replace(/[:.]/g, '-')).replace(/[^\w.-]/g, '-'),
    // Iterating on rules/prompts runs dirty — a bare short SHA would
    // attribute metrics to a commit that doesn't describe the measured
    // code. '-dirty' makes the provenance honest.
    cli:
      git(REPO_ROOT, ['rev-parse', '--short', 'HEAD']) +
      (git(REPO_ROOT, ['status', '--porcelain']) === '' ? '' : '-dirty'),
    entries: 0,
    results,
  }
  const out = join(outDir, `${summary.tag}.json`)
  const flush = () =>
    writeFileSync(
      out,
      JSON.stringify({ ...summary, at: new Date().toISOString(), entries: results.length }, null, 2),
    )
  const stalledEntry = (entry, e, ms = 0) => {
    results.push({
      name: entry.name,
      note: entry.note,
      ms,
      exitCode: 2,
      stalled: true,
      metrics: metricsFromReport({ ok: false, skipped: true }, entry.labels),
      error: String(e?.message ?? e).slice(0, 200),
    })
    flush()
    console.error(`${entry.name}: stalled - ${String(e?.message ?? e).slice(0, 120)}`)
  }
  for (const entry of corpus) {
    let repo
    try {
      repo = resolveRepo(entry, cacheDir)
    } catch (e) {
      stalledEntry(entry, e)
      continue
    }
    let wt, reportDir
    // Any per-entry failure (bad head SHA, worktree error) degrades to a
    // stalled result instead of aborting the whole corpus.
    try {
      wt = mkdtempSync(join(tmpdir(), 'argus-eval-wt-'))
      reportDir = mkdtempSync(join(tmpdir(), 'argus-eval-report-'))
      git(repo, ['worktree', 'prune'])
      git(repo, ['worktree', 'add', '--detach', '--force', wt, entry.head])
      const t0 = Date.now()
      let code = 0
      try {
        execFileSync(
          process.execPath,
          [CLI, 'code-review', '--base', entry.base, '--report-dir', reportDir],
          // Corpus trees are third-party code — locally there is no CI
          // event so the child would resolve trusted and import() a
          // fetched argus-reviewer.config.ts beside ambient secrets.
          {
            cwd: wt,
            stdio: 'inherit',
            env: { ...process.env, ARGUS_UNTRUSTED: '1' },
            timeout: 900_000,
          },
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
      // Tag-scoped: an entry-keyed name overwrites the previous run's
      // report while older run files keep dangling reportPath links.
      const keptReport = existsSync(reportPath)
        ? join(keptDir, `${slug(entry.name)}-${summary.tag}.json`)
        : undefined
      if (keptReport) writeFileSync(keptReport, JSON.stringify(report, null, 2))
      results.push({
        name: entry.name,
        note: entry.note,
        ms,
        exitCode: code,
        stalled,
        metrics,
        // The model that produced the findings — ambient ARGUS_CODE_MODEL
        // drift between runs otherwise masquerades as a code regression.
        model: report.spend?.model,
        reportPath: keptReport,
      })
      flush()
      console.error(
        `${entry.name}: findings=${metrics.findings} comments=${metrics.comments}` +
          (metrics.precision !== undefined
            ? ` precision=${metrics.precision.toFixed(2)} recall=${metrics.recall.toFixed(2)}`
            : '') +
          ` (${(ms / 1000).toFixed(0)}s)`,
      )
    } catch (e) {
      stalledEntry(entry, e)
    } finally {
      if (wt) {
        try {
          git(repo, ['worktree', 'remove', '--force', wt])
        } catch {
          rmSync(wt, { recursive: true, force: true })
        }
      }
      if (reportDir) rmSync(reportDir, { recursive: true, force: true })
    }
  }
  flush()
  console.log(`\nwrote ${out}`)
  printTable(results)
}

// One health classifier for every table: a hard stall (nonzero exit,
// missing report) or a clean-exit skip (code-review's skip paths — no
// diff, all files excluded) both mean the entry reviewed nothing; 'yes'
// vs 'skipped' distinguishes the two.
const health = (r) =>
  r.stalled === true || r.exitCode !== 0 ? 'yes' : r.metrics?.skipped ? 'skipped' : 'no'

function printTable(results) {
  console.log('\nentry | findings | comments | nit% | gen-path | precision | recall | drop(od/rev) | stalled')
  for (const r of results) {
    const m = r.metrics
    const stalled = health(r)
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
    const stalled = health(r)
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
    const v = i >= 0 ? rest[i + 1] : undefined
    return v !== undefined && !v.startsWith('--') ? v : dflt
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
  } else if (cmd === 'tally') {
    const [f] = rest.filter((x) => !x.startsWith('--'))
    if (!f) {
      console.error('usage: tally <run.json>  - markdown per-entry table')
      process.exit(2)
    }
    const runFile = JSON.parse(readFileSync(resolve(f), 'utf8'))
    const rows = runFile.results ?? []
    console.log('| entry | findings | comments | nit% | gen-path | stalled |')
    console.log('|---|---|---|---|---|---|')
    for (const r of rows) {
      const m = r.metrics ?? {}
      const stalled = health(r)
      console.log(
        `| ${r.name} | ${m.findings} | ${m.comments} | ` +
          `${Math.round((m.nitShare ?? 0) * 100)}% | ${m.generatedPathComments} | ${stalled} |`,
      )
    }
    // A run where every entry stalled or skipped reviewed nothing - that
    // is a dead lane, not a green week. Partial stays green on purpose.
    if (rows.length > 0 && rows.every((r) => health(r) !== 'no')) {
      console.error(`::error::all ${rows.length} corpus entries stalled or skipped`)
      process.exit(1)
    }
  } else {
    console.error('usage: review-eval.mjs run|compare|tally (see header)')
    process.exit(2)
  }
}
