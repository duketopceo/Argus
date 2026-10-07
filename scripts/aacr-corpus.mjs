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

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_LANGS = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Java']

// selectPrs: pure — unit-testable without the dataset.
export function selectPrs(rows, { langs = DEFAULT_LANGS, maxLines = 2000, maxPrs = 10 } = {}) {
  const byPr = new Map()
  for (const r of rows) {
    if (!byPr.has(r.pr_url)) byPr.set(r.pr_url, [])
    byPr.get(r.pr_url).push(r)
  }
  const prs = []
  for (const [url, group] of byPr) {
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
      repo: url.replace(/\/pull\/\d+$/, ''),
      // pr_source_commit is the base tip at PR time (merge-base anchor);
      // pr_target_commit is the target-branch tip at capture — usable
      // neither as diff base nor as head; head comes from the GitHub API.
      base: first.pr_source_commit,
      head: first.pr_target_commit,
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
        p.base &&
        p.head,
    )
    .sort((a, b) => a.diffLines - b.diffLines || a.url.localeCompare(b.url))
    .slice(0, maxPrs)
}

// pr_target_commit is the target-branch tip at capture, not the PR head —
// using it would diff months of branch drift. The replay needs GitHub's
// head.sha resolved live (merge-base(source_commit, head) is the PR diff).
export function toCorpus(prs, resolveHead = (p) => p.head) {
  return prs.map((p) => ({
    name:
      'aacr-' +
      p.repo.replace(/^https?:\/\/github\.com\//, '').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() +
      '-' +
      p.url.match(/pull\/(\d+)/)[1],
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
    return i >= 0 ? process.argv[i + 1] : dflt
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
    const m = p.repo.match(/github\.com\/([^/]+\/[^/]+)/)
    const num = p.url.match(/pull\/(\d+)/)[1]
    try {
      return execFileSync(
        'gh',
        ['api', `repos/${m[1]}/pulls/${num}`, '--jq', '.head.sha'],
        { encoding: 'utf8' },
      ).trim()
    } catch {
      return null // pr_target_commit is target-tip drift, never a usable head
    }
  }
  const corpus = toCorpus(prs, resolveHead).filter((e) => e.head)
  const out = arg('out')
  if (out) {
    const outPath = resolve(out)
    mkdirSync(join(outPath, '..'), { recursive: true })
    writeFileSync(outPath, JSON.stringify(corpus, null, 2) + '\n')
    console.log(`wrote ${outPath}`)
  } else {
    console.log(JSON.stringify(corpus, null, 2))
  }
  for (const p of prs) {
    console.error(`${p.url} | ${p.lang} | ${p.diffLines} lines | ${p.labels.length} issues`)
  }
}
