#!/usr/bin/env node
// npm run demo — materialize fixtures/demo-pr into a temp git repo and run
// the real code-review pipeline against it (zero GitHub API calls).
// Requires OPENROUTER_API_KEY — the point is the real pipeline, BYOK.
// Watch it live: `npm run watch` in a second terminal shows every stage.

import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const FIXTURE = join(ROOT, 'fixtures/demo-pr')
const WORK = join(ROOT, '.argus-demo')
const REPO = join(WORK, 'repo')
const REPORT = join(WORK, 'report')

// Placeholder → secret-shaped literals, substituted only inside the
// throwaway materialized repo so nothing credential-shaped is committed.
// Values are concatenated so no credential-shaped literal sits in this
// file statically (push protection scans committed content).
const SUBS = {
  __ARGUS_DEMO_DOC_KEY__: `AKIA${'IOSFODNN7EXAMPLE'}`, // AWS docs example — Jev should suppress
  __ARGUS_DEMO_LIVE_KEY__: `sk_live_${'51Qfake00DEMO7xK2mNvT9rLp'}`, // fake but live-shaped — Jev should hedge/flag
}

function git(args) {
  execFileSync('git', ['-C', REPO, '-c', 'user.email=demo@argus.local', '-c', 'user.name=argus-demo', ...args], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

function copyTree(src, dst, { substitute = false } = {}) {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dst, name)
    if (statSync(s).isDirectory()) {
      copyTree(s, d, { substitute })
    } else {
      let content = readFileSync(s, 'utf8')
      if (substitute) {
        for (const [k, v] of Object.entries(SUBS)) content = content.replaceAll(k, v)
      }
      writeFileSync(d, content)
    }
  }
}

function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      'demo: OPENROUTER_API_KEY is not set — the demo runs the real review pipeline (BYOK).\n' +
        '      export OPENROUTER_API_KEY=sk-or-... and re-run `npm run demo`.',
    )
    process.exit(1)
  }
  if (!existsSync(join(ROOT, 'dist/cli.js'))) {
    console.error('demo: dist/cli.js missing — run `npm run build` first.')
    process.exit(1)
  }

  console.log('demo: materializing fixtures/demo-pr → .argus-demo/repo')
  rmSync(WORK, { recursive: true, force: true })
  copyTree(join(FIXTURE, 'base'), REPO)
  git(['init', '-b', 'pr'])
  git(['add', '-A'])
  git(['commit', '-m', 'base'])
  git(['branch', 'argus-fixture-base'])
  copyTree(join(FIXTURE, 'head'), REPO, { substitute: true })
  git(['add', '-A'])
  git(['commit', '-m', 'pr head — seeded bug + credentials'])

  console.log('demo: tip — run `npm run watch` in another terminal to follow stages live\n')
  const child = spawn(
    process.execPath,
    [join(ROOT, 'dist/cli.js'), 'code-review', '--fixture', REPO, '--report-dir', REPORT],
    { cwd: ROOT, env: process.env, stdio: 'inherit' },
  )
  child.on('close', (code) => {
    if (code !== 0) process.exit(code ?? 1)
    try {
      const r = JSON.parse(readFileSync(join(REPORT, 'code-review.json'), 'utf8'))
      console.log('\n── demo summary ──────────────────────────────')
      console.log(`  verdict:   ${r.verdict}`)
      console.log(`  findings:  ${r.findings?.length ?? 0} (${(r.findings ?? []).map((f) => `${f.severity}@${f.file}:${f.line ?? '?'}`).join(', ') || 'none'})`)
      if (r.secretsScan && !r.secretsScan.skipped) {
        const recs = r.secretsScan.records ?? []
        console.log(
          `  secrets:   ${recs.length} candidate(s), ` +
            `${recs.filter((x) => x.suppressed).length} adjudicated-suppressed, ` +
            `${recs.filter((x) => !x.adjudicated).length} unadjudicated`,
        )
      } else if (r.secretsScan?.skipped) {
        console.log(`  secrets:   skipped — ${r.secretsScan.skipped}`)
      }
      console.log(`  cost:      $${(r.visionCostUsd ?? 0).toFixed(6)} · ${r.tokens ?? 0} tok · model ${r.model}`)
      console.log(`  report:    ${relative(ROOT, join(REPORT, 'code-review.json'))}`)
    } catch {
      console.log(`demo: review finished — see ${relative(ROOT, REPORT)}/`)
    }
    rmSync(REPO, { recursive: true, force: true }) // temp repo served its purpose; report stays
  })
}

main()
