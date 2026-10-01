#!/usr/bin/env node
// Review-quality measurement harness (ce-optimize/review-finding-quality).
//
// For each corpus item under evals/review-quality/corpus/<name>/:
//   materialize a git repo (ref argus-fixture-base vs HEAD) into
//   evals/work/rq-<name>/, run the real `code-review --fixture` pipeline,
//   then score hard metrics against ground-truth.json.
//
// Corpus item shapes:
//   {kind:"trees"}      base/ + head/ dirs (+ optional subs.json placeholders)
//   {kind:"source"}     "source": path to a dir containing base/ + head/
//   {kind:"revisions"}  "revisions": {baseRev, headRev} — materialized via
//                       `git archive` from this repo (real-PR snapshots)
//
// ground-truth.json:
//   planted:        [{file, line, severity, category, note}]  — recall targets
//   secretsExpect:  [{file, line, expect: "suppressed"|"flagged"}]
//   expectVerdictIn: ["needs_changes"] | ["pass","approve"] | omitted
//   precisionOnly:  true on real-PR snapshots (no ground truth)
//
// Usage: node evals/review-quality/run.mjs --label <name> [--only <item>]
// Env:   OPENROUTER_API_KEY (required), ARGUS_CODE_MODEL (default
//        google/gemini-2.5-flash-lite), ARGUS_RQ_KEEP_WORK=1 keeps repos.
// Output: evals/review-quality/results/<label>.json + metrics JSON on stdout.

import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CORPUS = join(ROOT, 'evals/review-quality/corpus')
const WORK = join(ROOT, 'evals/work')
const RESULTS = join(ROOT, 'evals/review-quality/results')
const LINE_TOLERANCE = 8

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function copyTreeWithSubs(src, dst, subs) {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dst, name)
    if (statSync(s).isDirectory()) {
      copyTreeWithSubs(s, d, subs)
    } else {
      let content = readFileSync(s, 'utf8')
      for (const [k, parts] of Object.entries(subs)) {
        content = content.replaceAll(k, parts.join(''))
      }
      writeFileSync(d, content)
    }
  }
}

function git(repo, args) {
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=rq@argus.local', '-c', 'user.name=rq', ...args],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
}

function materialize(itemDir, gt) {
  const repo = join(WORK, `rq-${basename(itemDir)}`)
  rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })

  const subs = existsSync(join(itemDir, 'subs.json'))
    ? JSON.parse(readFileSync(join(itemDir, 'subs.json'), 'utf8'))
    : {}

  if (gt.kind === 'revisions') {
    for (const [i, rev] of [gt.revisions.baseRev, gt.revisions.headRev].entries()) {
      execFileSync('tar', ['-x', '-C', repo], {
        input: execFileSync('git', ['-C', ROOT, 'archive', rev], { maxBuffer: 64 << 20 }),
      })
      // Generated/bundle churn adds tokens, not signal — strip it so the
      // fixture diff matches what a human would actually review.
      for (const p of gt.strip ?? ['dist', 'package-lock.json']) {
        rmSync(join(repo, p), { recursive: true, force: true })
      }
      if (i === 0) {
        git(repo, ['init', '-b', 'pr'])
        git(repo, ['add', '-A'])
        git(repo, ['commit', '-m', `base ${rev.slice(0, 8)}`])
        git(repo, ['branch', 'argus-fixture-base'])
      } else {
        git(repo, ['add', '-A'])
        git(repo, ['commit', '-m', `head ${rev.slice(0, 8)}`])
      }
    }
    return repo
  }

  const srcDir = gt.kind === 'source' ? join(ROOT, gt.source) : itemDir
  copyTreeWithSubs(join(srcDir, 'base'), repo, {})
  git(repo, ['init', '-b', 'pr'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'base'])
  git(repo, ['branch', 'argus-fixture-base'])
  copyTreeWithSubs(join(srcDir, 'head'), repo, subs)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'pr head'])
  return repo
}

function basename(p) {
  return p.replace(/\/+$/, '').split('/').pop()
}

const HIGH = new Set(['bug', 'risk'])

function findingMatches(f, planted) {
  if (f.file !== planted.file) return false
  if (typeof f.line !== 'number' || Math.abs(f.line - planted.line) > LINE_TOLERANCE) {
    return false
  }
  // A planted bug/risk must be found at bug/risk severity — a nit mention of
  // the same line is not a catch. Low-severity plantings accept anything.
  if (HIGH.has(planted.severity)) return HIGH.has(f.severity)
  return true
}

function reviewItem(itemDir) {
  const gt = JSON.parse(readFileSync(join(itemDir, 'ground-truth.json'), 'utf8'))
  const name = basename(itemDir)
  const repo = materialize(itemDir, gt)
  const reportDir = join(WORK, `rq-${name}-report`)
  rmSync(reportDir, { recursive: true, force: true })
  mkdirSync(reportDir, { recursive: true })

  const run = spawnSync(
    process.execPath,
    [join(ROOT, 'dist/cli.js'), 'code-review', '--fixture', repo, '--report-dir', reportDir],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ARGUS_CODE_MODEL: process.env.ARGUS_CODE_MODEL ?? 'google/gemini-2.5-flash-lite',
      },
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 16 << 20,
    },
  )

  const reportPath = join(reportDir, 'code-review.json')
  let report = null
  let parseError = null
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (e) {
    parseError = String(e)
  }

  const diff = execFileSync('git', ['-C', repo, 'diff', 'argus-fixture-base..HEAD'], {
    encoding: 'utf8',
    maxBuffer: 16 << 20,
  })

  const findings = report?.findings ?? []
  const records = report?.secretsScan?.records ?? []

  const planted = (gt.planted ?? []).map((p) => ({
    ...p,
    found: findings.some((f) => findingMatches(f, p)),
  }))
  const secretsExpect = (gt.secretsExpect ?? []).map((s) => {
    const rec = records.find(
      (r) => r.file === s.file && Math.abs((r.line ?? -999) - s.line) <= LINE_TOLERANCE,
    )
    // "flagged" = the secrets pipeline emitted an unsuppressed finding at the
    // site (secrets findings carry adjudicated pLive in `p`). Findings the
    // review model wrote independently don't count — those are judge-scored.
    const flagged = findings.some(
      (f) => f.file === s.file && typeof f.line === 'number' && Math.abs(f.line - s.line) <= LINE_TOLERANCE && HIGH.has(f.severity) && f.p !== undefined,
    )
    const suppressed = Boolean(rec?.suppressed)
    // "flagged" requires an unsuppressed secrets finding at the site;
    // "quiet" is satisfied by suppression or by never flagging at all.
    return {
      ...s,
      suppressed,
      flagged,
      adjudicated: Boolean(rec?.adjudicated),
      correct: s.expect === 'flagged' ? flagged : !flagged,
    }
  })

  const verdict = report?.verdict ?? null
  const expectIn = gt.expectVerdictIn ?? null

  return {
    name,
    kind: gt.kind ?? 'trees',
    precisionOnly: Boolean(gt.precisionOnly),
    verdict,
    expectedVerdictIn: expectIn,
    verdictCorrect: expectIn ? expectIn.includes(verdict) : null,
    findings: findings.map((f) => ({
      file: f.file,
      line: f.line ?? null,
      severity: f.severity ?? null,
      category: f.category ?? null,
      message: f.message ?? '',
      suggestion: f.suggestion ?? null,
      ...(f.p !== undefined ? { p: f.p } : {}), // secrets-pipeline marker
    })),
    secretsRecords: records.map((r) => ({
      file: r.file, line: r.line, patternClass: r.patternClass,
      adjudicated: r.adjudicated, suppressed: Boolean(r.suppressed), pLive: r.pLive ?? null,
    })),
    planted,
    secretsExpect,
    costUsd: report?.visionCostUsd ?? 0,
    tokens: report?.tokens ?? 0,
    model: report?.model ?? null,
    exitCode: run.status,
    reportPath: report ? reportPath : null,
    parseError,
    stderrTail: (run.stderr ?? '').split('\n').slice(-8).join('\n'),
    diff,
  }
}

function main() {
  const label = arg('label')
  if (!label) {
    console.error('usage: node evals/review-quality/run.mjs --label <name> [--only <item>]')
    process.exit(2)
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is required — reviews run the real pipeline (BYOK).')
    process.exit(2)
  }
  if (!existsSync(join(ROOT, 'dist/cli.js'))) {
    console.error('dist/cli.js missing — run `npm run build` first.')
    process.exit(2)
  }

  const only = arg('only')
  const items = readdirSync(CORPUS)
    .filter((d) => existsSync(join(CORPUS, d, 'ground-truth.json')))
    .filter((d) => !only || d === only)
    .sort()
  if (items.length === 0) {
    console.error(`no corpus items${only ? ` matching --only ${only}` : ''}`)
    process.exit(2)
  }

  mkdirSync(RESULTS, { recursive: true })
  const out = []
  for (const d of items) {
    console.error(`[rq] reviewing ${d} …`)
    out.push(reviewItem(join(CORPUS, d)))
    console.error(`[rq] ${d}: verdict=${out.at(-1).verdict} findings=${out.at(-1).findings.length} cost=$${out.at(-1).costUsd?.toFixed(4)}`)
  }

  const plantedTotal = out.reduce((s, i) => s + i.planted.length, 0)
  const plantedFound = out.reduce((s, i) => s + i.planted.filter((p) => p.found).length, 0)
  const secretsTotal = out.reduce((s, i) => s + i.secretsExpect.length, 0)
  const secretsCorrect = out.reduce((s, i) => s + i.secretsExpect.filter((s) => s.correct).length, 0)
  const verifiable = out.filter((i) => i.verdictCorrect !== null)

  const metrics = {
    reports_produced: out.every((i) => i.reportPath) ? 1 : 0,
    planted_recall: plantedTotal ? +(plantedFound / plantedTotal).toFixed(4) : 1,
    corpus_cost_usd: +out.reduce((s, i) => s + (i.costUsd ?? 0), 0).toFixed(4),
    finding_count: out.reduce((s, i) => s + i.findings.length, 0),
    verdict_correct_count: verifiable.filter((i) => i.verdictCorrect).length,
    verdict_total: verifiable.length,
    secrets_correct_count: secretsCorrect,
    secrets_total: secretsTotal,
    suppressed_count: out.reduce((s, i) => s + i.secretsRecords.filter((r) => r.suppressed).length, 0),
    tokens: out.reduce((s, i) => s + (i.tokens ?? 0), 0),
    items_reviewed: out.length,
  }

  const slim = out.map(({ diff: _diff, ...rest }) => rest)
  writeFileSync(
    join(RESULTS, `${label}.json`),
    JSON.stringify({ label, at: new Date().toISOString(), metrics, items: slim }, null, 2),
  )
  // Full diffs stored separately — large; judge.mjs reads this file.
  writeFileSync(
    join(RESULTS, `${label}.diffs.json`),
    JSON.stringify({ label, diffs: Object.fromEntries(out.map((i) => [i.name, i.diff])) }, null, 2),
  )

  if (!process.env.ARGUS_RQ_KEEP_WORK) {
    for (const d of items) rmSync(join(WORK, `rq-${d}`), { recursive: true, force: true })
  }

  console.log(JSON.stringify(metrics, null, 2))
}

main()
