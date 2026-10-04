#!/usr/bin/env node
// Render the real U14 evidence report for the mixed-four-lane fixture and
// screenshot it with Playwright chromium → launch/public/captures/report.png
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'launch/public/captures')
const { renderReportHtml } = await import(join(ROOT, 'dist/report/html.js'))

const fixture = JSON.parse(
  readFileSync(join(ROOT, 'fixtures/manifests/mixed-four-lane.json'), 'utf8'),
)

const html = renderReportHtml({
  manifestText: JSON.stringify(fixture.manifest),
  codeReview: fixture.codeReview,
  run: fixture.report,
  version: fixture.version,
  runUrl: fixture.runUrl,
})

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'report.html'), html)

const { chromium } = await import('playwright')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.goto(`file://${join(OUT, 'report.html')}`)
await page.screenshot({ path: join(OUT, 'report.png') })
await browser.close()
console.log('report.png written')
