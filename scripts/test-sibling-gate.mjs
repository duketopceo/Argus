#!/usr/bin/env node
// test-sibling-gate — deterministic eval gate for the test-sibling rule
// (plan U2, docs/plans/2026-10-14-2135-feat-test-sibling-rule-plan.md).
//
// For each corpus row, materializes the merge-base diff the review
// actually ran (same -c flags as the lane's diff producers), runs the
// rules lane with testSiblingRule injected via the `rules` seam, and
// records every firing with a repo-tree legitimacy classification:
// `sibling-exists` (the named file's stem group holds a genuine test in
// the head tree — the uncovered-sibling claim is literally true) or
// `no-sibling` (no such test exists — the premise is wrong even though
// the diff signal is real). Zero model calls.
//
// usage: node scripts/test-sibling-gate.mjs --corpus a.json [--corpus b.json ...]
//            [--out docs/audits/eval/test-sibling.json] [--cache dir]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, mergeBase, resolveRepo } from './review-eval.mjs'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const { REVIEW_RULES, isTestCoverPath, runRules, testSiblingRule } = await import(
  new URL('../dist/review/rules.js', import.meta.url).href
)
const { testSiblingKey } = await import(
  new URL('../dist/review/testfiles.js', import.meta.url).href
)
const { GIT_DIFF_PATH_FLAGS } = await import(
  new URL('../dist/review/difftext.js', import.meta.url).href
)
const { filesFromUnifiedDiff } = await import(
  new URL('../dist/cli.js', import.meta.url).href
)

// Inject the rule only when the checked-out registry predates
// registration — a duplicate entry would double-fire and corrupt the
// artifact. The gate measures only the rule, so `enabled` scopes the run.
const REGISTRY = REVIEW_RULES.some((r) => r.id === 'test-sibling')
  ? REVIEW_RULES
  : [...REVIEW_RULES, testSiblingRule]

// Classify uncovered sources against the head tree: sibling-exists when
// a genuine test member shares the stem key, no-sibling otherwise. Stem
// groups are same-directory modulo the sibling dirs, so every group
// member lives under the candidate's own dir — the ls-tree pathspec
// scopes the read to exactly those dirs ('.' = repo root).
function classifyUncovered(repo, head, uncovered) {
  const dirs = [...new Set(uncovered.map((f) => dirname(f)))]
  const groups = new Map()
  for (const p of git(repo, ['ls-tree', '-r', '--name-only', head, '--', ...dirs]).split('\n')) {
    if (p === '') continue
    const key = testSiblingKey(p)
    const g = groups.get(key) ?? []
    g.push(p)
    groups.set(key, g)
  }
  return uncovered.map((file) => {
    const members = groups.get(testSiblingKey(file)) ?? []
    return {
      file,
      class: members.some(isTestCoverPath) ? 'sibling-exists' : 'no-sibling',
      groupMembers: members,
    }
  })
}

async function gateRow(entry, cacheDir) {
  const repo = resolveRepo(entry, cacheDir)
  const mb = mergeBase(repo, entry.base, entry.head)
  if (mb === '') throw new Error(`no merge-base for ${entry.name}`)
  const diff = git(repo, [...GIT_DIFF_PATH_FLAGS, 'diff', `${mb}..${entry.head}`])
  const result = await runRules(diff, { rules: REGISTRY, enabled: ['test-sibling'] })
  const records = result.records
  const findings = result.findings
  const filesChanged = [...new Set(filesFromUnifiedDiff(diff).map((f) => f.filename))]
  const testFilesInDiff = filesChanged.filter(isTestCoverPath)
  const row = {
    name: entry.name,
    note: entry.note,
    mergeBase: mb,
    filesChanged: filesChanged.length,
    testFilesInDiff,
    fired: findings.length > 0,
    findings: findings.map((f) => ({ file: f.file, message: f.message })),
    records,
  }
  if (findings.length > 0) {
    row.classification = classifyUncovered(
      repo,
      entry.head,
      records.map((r) => r.file),
    )
  }
  return row
}

const rest = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = rest.indexOf(`--${name}`)
  const v = i >= 0 ? rest[i + 1] : undefined
  return v !== undefined && !v.startsWith('--') ? v : dflt
}
const corpora = rest.flatMap((a, i) => (a === '--corpus' ? [rest[i + 1]] : []))
if (corpora.length === 0) {
  console.error('usage: --corpus <file> [--corpus <file> ...] [--out path] [--cache dir]')
  process.exit(2)
}
const cacheDir = arg('cache', join(tmpdir(), 'argus-eval-repos'))
const out = resolve(arg('out', join(REPO_ROOT, 'docs', 'audits', 'eval', 'test-sibling.json')))

const rows = []
for (const c of corpora) {
  for (const entry of JSON.parse(readFileSync(resolve(c), 'utf8'))) {
    try {
      rows.push(await gateRow(entry, cacheDir))
      const r = rows[rows.length - 1]
      console.error(
        `${r.name}: fired=${r.fired} files=${r.filesChanged} tests=${r.testFilesInDiff.length}`,
      )
    } catch (e) {
      rows.push({ name: entry.name, error: String(e?.message ?? e).slice(0, 200) })
      console.error(`${entry.name}: stalled - ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }
}

const fired = rows.filter((r) => r.fired)
const tally = {
  rows: rows.length,
  fired: fired.length,
  legitGap: fired.flatMap((r) => r.classification ?? []).filter((c) => c.class === 'sibling-exists')
    .length,
  noSibling: fired.flatMap((r) => r.classification ?? []).filter((c) => c.class === 'no-sibling')
    .length,
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      corpora: corpora.map((c) => resolve(c)),
      tally,
      rows,
    },
    null,
    2,
  ),
)
console.log(`wrote ${out}: ${JSON.stringify(tally)}`)
