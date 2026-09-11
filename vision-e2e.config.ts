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
  cacheDir: '.vision-e2e-cache',
  reportDir: 'vision-e2e-report',
}
