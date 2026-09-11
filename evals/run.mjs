#!/usr/bin/env node
/**
 * argus-reviewer eval harness.
 *
 * Runs the fixed task suite in evals/suite once cold (full vision grounding)
 * and once warm (fingerprint cache replay — expected $0) per model, then writes
 *   evals/results/<timestamp>.json   raw per-model run reports
 *   docs/evals/<date>.md             markdown summary for posting
 *
 * Usage:
 *   npm run build && OPENROUTER_API_KEY=... node evals/run.mjs
 *   node evals/run.mjs --models google/gemini-2.5-flash-lite,moonshotai/kimi-k2.5
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureUrl = `file://${join(repo, 'tests/fixtures/index.html')}`
const suiteDir = join(repo, 'evals/suite')
const workRoot = join(repo, 'evals/work')
const resultsDir = join(repo, 'evals/results')
const docsDir = join(repo, 'docs/evals')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const models = (flag('models') ?? 'google/gemini-2.5-flash-lite,moonshotai/kimi-k2.5').split(',')
const budgetUsd = Number(flag('budget') ?? '1')

if (!process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is required — evals make real vision calls.')
  process.exit(1)
}
if (!existsSync(join(repo, 'dist/cli.js'))) {
  const b = spawnSync('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' })
  if (b.status !== 0) process.exit(b.status ?? 1)
}

function runCli(cwd, cliArgs) {
  return spawnSync('node', [join(repo, 'dist/cli.js'), ...cliArgs], {
    cwd,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 600_000,
  })
}

const results = []
for (const model of models) {
  const slug = model.replace(/[^a-z0-9]+/gi, '-')
  const ws = join(workRoot, slug)
  await rm(ws, { recursive: true, force: true })
  await mkdir(join(ws, 'tests'), { recursive: true })
  await cp(suiteDir, join(ws, 'tests'), { recursive: true })
  await writeFile(
    join(ws, 'argus-reviewer.config.json'),
    JSON.stringify(
      {
        model,
        budgetUsd,
        target: { url: fixtureUrl },
        testsDir: 'tests',
        cacheDir: '.cache',
        reportDir: 'report',
      },
      null,
      2,
    ),
  )

  const cold = runCli(ws, ['run'])
  const coldReport = JSON.parse(
    await readFile(join(ws, 'report/run.json'), 'utf8'),
  )
  const warm = runCli(ws, ['run'])
  const warmReport = JSON.parse(
    await readFile(join(ws, 'report/run.json'), 'utf8'),
  )

  const failures = (report) =>
    report.tests
      .filter((t) => !t.ok)
      .map((t) => ({ name: t.name, reason: t.failureMessage ?? 'unknown' }))

  results.push({
    model,
    cold: {
      ok: coldReport.ok,
      passed: coldReport.totals.passed,
      tests: coldReport.totals.tests,
      visionCalls: coldReport.totals.visionCalls,
      visionCostUsd: coldReport.totals.visionCostUsd,
      healEvents: coldReport.tests.reduce((n, t) => n + t.healEvents.length, 0),
      failures: failures(coldReport),
      stdout: (cold.stdout ?? '').trim().split('\n').pop(),
      stderr: (cold.stderr ?? '').trim().split('\n').slice(-3),
      exitCode: cold.status,
    },
    warm: {
      ok: warmReport.ok,
      passed: warmReport.totals.passed,
      tests: warmReport.totals.tests,
      visionCalls: warmReport.totals.visionCalls,
      visionCostUsd: warmReport.totals.visionCostUsd,
      failures: failures(warmReport),
      stdout: (warm.stdout ?? '').trim().split('\n').pop(),
      exitCode: warm.status,
    },
  })
}

const ts = new Date().toISOString()
await mkdir(resultsDir, { recursive: true })
await mkdir(docsDir, { recursive: true })
await writeFile(
  join(resultsDir, `${ts.replace(/[:.]/g, '-')}.json`),
  `${JSON.stringify({ generatedAt: ts, suite: 'evals/suite', budgetUsd, results }, null, 2)}\n`,
)

const lines = [
  `# argus-reviewer eval — ${ts.slice(0, 10)}`,
  '',
  `Suite: \`evals/suite\` (${results[0]?.cold.tests ?? '?'} td-API tasks on tests/fixtures/index.html)`,
  `Budget cap: $${budgetUsd.toFixed(2)}/run · Target: static fixture via file://`,
  '',
  '| Model | Cold pass | Cold calls | Cold cost | Heal events | Warm pass | Warm calls | Warm cost |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
]
for (const r of results) {
  lines.push(
    `| \`${r.model}\` | ${r.cold.passed}/${r.cold.tests} | ${r.cold.visionCalls} | ` +
      `$${r.cold.visionCostUsd.toFixed(4)} | ${r.cold.healEvents} | ${r.warm.passed}/${r.warm.tests} | ` +
      `${r.warm.visionCalls} | $${r.warm.visionCostUsd.toFixed(4)} |`,
  )
}
lines.push(
  '',
  'Cold = empty cache (model grounds every step). Warm = same suite re-run on the fingerprint cache.',
  'Warm calls of 0 is the cache-first replay guarantee working as designed.',
)
const anyFailures = results.some((r) => r.cold.failures.length + r.warm.failures.length > 0)
if (anyFailures) {
  lines.push('', '### Failures', '')
  for (const r of results) {
    for (const f of [...r.cold.failures, ...r.warm.failures]) {
      lines.push(`- \`${r.model}\` — ${f.name}: ${f.reason}`)
    }
  }
}
await writeFile(join(docsDir, `${ts.slice(0, 10)}.md`), `${lines.join('\n')}\n`)
console.log(lines.join('\n'))
