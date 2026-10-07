#!/usr/bin/env node
// aacr-corpus.mjs — convert Alibaba-Aone/aacr-bench (Apache-2.0) rows into an
// eval-corpus file for review-eval.mjs.
//
// AACR-Bench rows are review comments, not raw issues: label=1 marks a
// human-verified correct comment, label=0 an incorrect one. Only label=1
// rows become corpus labels — they are the ground-truth issue set a
// reviewer should find. label=0 rows are wrong-comment bait and are never
// labels.
//
// usage: aacr-corpus.mjs [--dataset <path>] [--out <file>] [--langs csv]
//                        [--max-lines N] [--max-prs N]
// dataset default: ~/.cache/argus-eval/aacr-dataset.json
// (fetch: huggingface.co/datasets/Alibaba-Aone/aacr-bench/resolve/main/dataset.json)
// Requires an authenticated `gh` — every PR head resolves via the API.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_LANGS = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Java']

// Strict canonical form — an infix "github.com/" match would admit
// look-alike hosts (evilgithub.com) and http:// downgrades into emitted
// corpora (CWE-20); non-canonical rows are dropped, never normalized.
const PR_URL_RE = /^https:\/\/github\.com\/(?<repoPath>[\w.-]+\/[\w.-]+)\/pull\/(?<num>\d+)\/?$/

// selectPrs: pure — unit-testable without the dataset.
export function selectPrs(rows, { langs = DEFAULT_LANGS, maxLines = 2000, maxPrs = 10 } = {}) {
  const byPr = new Map()
  for (const r of rows) {
    if (!byPr.has(r.pr_url)) byPr.set(r.pr_url, [])
    byPr.get(r.pr_url).push(r)
  }
  const prs = []
  for (const [url, group] of byPr) {
    const m = url.match(PR_URL_RE)
    if (!m) continue
    const first = group[0]
    const labels = group
      .filter((r) => String(r.label) === '1' && r.side !== 'left')
      .map((r) => ({
        path: r.path,
        fromLine: Number(r.from_line),
        toLine: Number(r.to_line),
        valid: true,
        fileLevel: r.context === 'File Level' || r.context === 'file_level',
        category: r.category,
      }))
      .filter((l) => l.path && Number.isFinite(l.fromLine) && Number.isFinite(l.toLine))
    prs.push({
      url,
      repo: `https://github.com/${m.groups.repoPath}`,
      prNum: m.groups.num,
      // pr_source_commit is the base tip at PR time (merge-base anchor);
      // pr_target_commit is the target-branch tip at capture — usable
      // neither as diff base nor as head; head comes from the GitHub API.
      base: first.pr_source_commit,
      // pr_target_commit is deliberately NOT kept — it is the
      // target-branch tip at capture, not the PR head; the real head is
      // resolved live via resolveHead in toCorpus. Not carrying the field
      // prevents a later reader wiring the drift value through.
      lang: first.project_main_language,
      diffLines: Number(first.pr_change_line_count),
      labels,
    })
  }
  return prs
    .filter(
      (p) =>
        langs.includes(p.lang) &&
        p.diffLines <= maxLines &&
        p.labels.length > 0 &&
        p.base,
    )
    .sort((a, b) => a.diffLines - b.diffLines || a.url.localeCompare(b.url))
    .slice(0, maxPrs)
}

// pr_target_commit is the target-branch tip at capture, not the PR head —
// using it would diff months of branch drift. The replay needs GitHub's
// head.sha resolved live (merge-base(source_commit, head) is the PR diff).
// resolveHead is REQUIRED on purpose: defaulting to p.head would emit the
// drift-laden field the comment above warns against.
export function toCorpus(prs, resolveHead) {
  if (typeof resolveHead !== 'function') {
    throw new TypeError('toCorpus requires a resolveHead(p) => sha|null function')
  }
  return prs.map((p) => ({
    name:
      'aacr-' +
      p.repo.replace(/^https:\/\/github\.com\//, '').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() +
      '-' +
      p.prNum,
    repo: p.repo,
    base: p.base,
    head: resolveHead(p),
    labels: p.labels,
    note: `AACR-Bench ${p.lang} PR, ${p.diffLines} changed lines, ${p.labels.length} verified issues`,
  }))
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedAsScript) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`)
    const v = i >= 0 ? process.argv[i + 1] : undefined
    return v !== undefined && !v.startsWith('--') ? v : dflt
  }
  const datasetPath = resolve(
    arg('dataset', join(homedir(), '.cache', 'argus-eval', 'aacr-dataset.json')),
  )
  if (!existsSync(datasetPath)) {
    console.error(`dataset not found: ${datasetPath}`)
    console.error('fetch: curl -sL https://huggingface.co/datasets/Alibaba-Aone/aacr-bench/resolve/main/dataset.json -o <path>')
    process.exit(2)
  }
  const rows = JSON.parse(readFileSync(datasetPath, 'utf8'))
  const langs = arg('langs', '').trim() ? arg('langs').split(',') : DEFAULT_LANGS
  const prs = selectPrs(rows, {
    langs,
    maxLines: Number(arg('max-lines', '2000')),
    maxPrs: Number(arg('max-prs', '10')),
  })
  const resolveHead = (p) => {
    // repo/prNum were strict-parsed in selectPrs — canonical by construction.
    const repoPath = p.repo.replace(/^https:\/\/github\.com\//, '')
    const num = p.prNum
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return execFileSync(
          'gh',
          ['api', `repos/${repoPath}/pulls/${num}`, '--jq', '.head.sha'],
          { encoding: 'utf8', timeout: 30_000 },
        ).trim()
      } catch {
        // retry once on transient 5xx/rate-limit before dropping
      }
    }
    // pr_target_commit is target-tip drift, never a usable head —
    // drop with a visible reason rather than replaying the wrong diff.
    console.error(`drop ${p.url}: head.sha unresolvable via gh api`)
    return null
  }
  const corpus = toCorpus(prs, resolveHead).filter((e) => e.head)
  if (corpus.length === 0) {
    console.error(`no corpus entries survived (${prs.length} PRs selected; check gh auth)`)
    process.exit(1)
  }
  const out = arg('out')
  if (out) {
    const outPath = resolve(out)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(corpus, null, 2) + '\n')
    console.log(`wrote ${outPath}`)
  } else {
    console.log(JSON.stringify(corpus, null, 2))
  }
  for (const p of prs) {
    console.error(`${p.url} | ${p.lang} | ${p.diffLines} lines | ${p.labels.length} issues`)
  }
}
