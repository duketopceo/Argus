import { defineConfig } from 'argus-reviewer-e2e'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  model: 'google/gemini-2.5-flash-lite',
  code_model: 'deepseek/deepseek-v4.1-flash',
  budgetUsd: 1.0,
  target: {
    url: `file://${fileURLToPath(new URL('./fixtures/index.html', import.meta.url))}`,
  },
  testsDir: 'e2e',
  cacheDir: '.argus-reviewer-cache',
  reportDir: 'argus-reviewer-report',
})
