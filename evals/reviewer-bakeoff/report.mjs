#!/usr/bin/env node
// Aggregate results.json (+ results-batch.json) into the REPORT.md tables.
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
const dir = new URL('.', import.meta.url).pathname
const rt = JSON.parse(readFileSync(dir + 'results.json', 'utf8')).realtime
const bt = JSON.parse(readFileSync(dir + 'results.json', 'utf8')).batch
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN)
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a')
const judged = existsSync(dir + 'judged.json') ? JSON.parse(readFileSync(dir + 'judged.json', 'utf8')).verdicts : {}
const jv = (f) => judged[`${f.file}:${f.line}:${f.message}`]?.verdict
const models = [...new Set(rt.map((r) => r.model))]
const lines = []
lines.push('| model | mode | demo ok/runs | recall | precision | doc-key FP/run | ocellus ok/runs | ocellus findings (post-filter) | bug+risk | invalid dropped | judge-valid/ocellus review | demo cost/review | ocellus cost/review | demo latency s | ocellus latency s |')
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const m of models) {
  const d = rt.filter((r) => r.model === m && r.fixture === 'demo'), o = rt.filter((r) => r.model === m && r.fixture === 'ocellus')
  const dok = d.filter((r) => !r.error), ook = o.filter((r) => !r.error)
  lines.push(`| ${m} | realtime | ${dok.length}/${d.length} | ${f(avg(dok.map((r) => r.score.recall)))} | ${f(avg(dok.map((r) => r.score.precision)))} | ${f(avg(dok.map((r) => r.score.docKeyFalsePositives)), 1)} | ${ook.length}/${o.length} | ${f(avg(ook.map((r) => r.score.postFilter)), 1)} | ${f(avg(ook.map((r) => r.score.bugRisk)), 1)} | ${f(avg(ook.map((r) => r.score.invalidDropped)), 1)} | ${f(avg(ook.map((r) => r.findings.filter((x) => jv(x) === 'valid').length)), 1)} (${ook.reduce((s, r) => s + r.findings.length, 0) ? Math.round((100 * ook.reduce((s, r) => s + r.findings.filter((x) => jv(x) === 'valid').length, 0)) / ook.reduce((s, r) => s + r.findings.length, 0)) : 'n/a'}%) | $${f(avg(dok.map((r) => r.totalCostUsd)), 5)} | $${f(avg(ook.map((r) => r.totalCostUsd)), 5)} | ${f(avg(dok.map((r) => r.latencyS)), 0)} | ${f(avg(ook.map((r) => r.latencyS)), 0)} |`)
}
for (const b of bt) {
  lines.push(`| ${b.model} | batch | ${b.error ? 'err' : '1/1'} | ${b.demo ? f(b.demo.recall) : 'n/a'} | ${b.demo ? f(b.demo.precision) : 'n/a'} | ${b.demo ? b.demo.docKeyFalsePositives : 'n/a'} | ${b.error ? 'err' : '1/1'} | ${b.ocellus?.postFilter ?? 'n/a'} | ${b.ocellus?.bugRisk ?? 'n/a'} | ${b.ocellus?.invalidDropped ?? 'n/a'} | ${b.findings ? `${b.findings.ocellus.filter((x) => jv(x) === 'valid').length} (${b.findings.ocellus.length ? Math.round((100 * b.findings.ocellus.filter((x) => jv(x) === 'valid').length) / b.findings.ocellus.length) : 'n/a'}%)` : 'n/a'} | (both fixtures) $${f(b.costUsd, 5)} | | ${f(b.latencyS, 0)} (whole batch) | |`)
}
const spent = rt.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0) + bt.reduce((s, b) => s + (b.costUsd ?? 0), 0)
lines.push('', `Ledger spend (sum of usage.cost): $${spent.toFixed(4)}`)
writeFileSync(dir + 'table.md', lines.join('\n') + '\n')
console.log(lines.join('\n'))
