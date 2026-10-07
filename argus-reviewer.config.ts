import { resolve } from 'node:path'

export default {
  model: 'google/gemini-2.5-flash-lite',
  budgetUsd: 1,
  target: {
    command: '',
    url: `file://${resolve('tests/fixtures/index.html')}`,
    readyTimeoutMs: 0,
  },
  testsDir: 'e2e',
  cacheDir: '.argus-reviewer-cache',
  reportDir: 'argus-reviewer-report',
  review: {
    // Replaces DEFAULT_REVIEW_EXCLUDE — repeat it plus eval artifacts.
    // docs/audits/eval holds captured tallies and per-entry report JSON
    // embedding third-party diffs; the reviewer flags that foreign code
    // as ours (PR #174 dogfood produced 3 such findings).
    exclude: [
      'dist/**',
      'fixtures/**',
      'tests/goldens/**',
      '**/package-lock.json',
      '**/npm-shrinkwrap.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml',
      '**/bun.lock',
      '**/Cargo.lock',
      '**/poetry.lock',
      '**/Gemfile.lock',
      '**/composer.lock',
      '**/go.sum',
      '**/*.generated.*',
      'assets/brand/export/**',
      'docs/audits/eval/**',
    ],
  },
  // Dogfood the B.2 probe lane: authored probes run in the Docker sandbox on
  // the self-hosted runner for not_exercised bug/risk findings.
  sandbox: { enabled: true },
}
