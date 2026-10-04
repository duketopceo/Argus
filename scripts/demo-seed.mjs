#!/usr/bin/env node
// Seed the README demo flow cache with zero model calls (plan R32, Q7).
//
// Run by `scripts/demo-record.mjs --seed` inside the staged demo project and
// the same clean environment the casts record in (HOME, fonts, browsers), so
// the stored region hash matches what the cast replays. Never run by hand.
//
// How the seed is made without a model: a scripted client stands in for the
// vision model. Its click comes from the page's DOM (the button's centre);
// its assertion verdict is "pass". The cache entries are labelled
// `demo-seed (scripted, no model call)` so nobody mistakes them for a model
// verdict. The replay in the cast still checks the real page: the click
// target's pixels and accessibility node, and the post-click accessibility
// tree, must match the seed or the run falls through to a model call, which
// fails closed here because no key is set.
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { chromium } from 'playwright'

const SEED_MODEL = 'demo-seed (scripted, no model call)'

const [cliPath, flowName, buttonSelector] = process.argv.slice(2)
if (!cliPath || !flowName || !buttonSelector) {
  console.error('usage: demo-seed.mjs <dist/cli.js> <flow> <button-selector>')
  process.exit(2)
}
if (process.env.OPENROUTER_API_KEY !== undefined) {
  console.error('demo-seed: refusing to run with OPENROUTER_API_KEY set (plan R32)')
  process.exit(3)
}

const { main } = await import(resolve(cliPath))
const config = JSON.parse(await readFile('argus-reviewer.config.json', 'utf8'))

/** Centre of the target element, in viewport pixels (the model's frame). */
async function buttonCentre() {
  const { spawn } = await import('node:child_process')
  const server = spawn(config.target.command, { shell: true, stdio: 'ignore', detached: true })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      for (let i = 0; ; i++) {
        try {
          await page.goto(config.target.url)
          break
        } catch (e) {
          if (i > 50) throw e
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      const box = await page.locator(buttonSelector).boundingBox()
      if (!box) throw new Error(`no element for ${buttonSelector}`)
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    } finally {
      await browser.close()
    }
  } finally {
    process.kill(-server.pid)
  }
}

class ScriptedClient {
  calls = 0
  constructor(point) {
    this.point = point
  }
  async complete(opts) {
    this.calls++
    const content =
      opts.kind === 'assert'
        ? JSON.stringify({ verdict: 'pass', reasoning: 'seeded for the README demo' })
        : JSON.stringify({ action: 'click', x: this.point.x, y: this.point.y, reasoning: 'seeded from the DOM' })
    return {
      id: `demo-seed-${this.calls}`,
      content,
      model: SEED_MODEL,
      cost: { model: SEED_MODEL, provider: 'none', tokens: 0, costUsd: 0, kind: opts.kind ?? 'ground' },
    }
  }
}

const quiet = { out: () => {}, err: (l) => console.error(l), isTTY: false }

const point = await buttonCentre()
const scripted = new ScriptedClient(point)
const seedCode = await main(['run'], { ...quiet, createClient: () => scripted })
if (seedCode !== 0 || scripted.calls === 0) {
  console.error(`demo-seed: seeding run failed (exit ${seedCode}, ${scripted.calls} scripted calls)`)
  process.exit(1)
}

// Prove the seed is a cache hit: a second run with a client that throws on
// any call must pass with zero calls.
let leaked = 0
const refuse = {
  complete: async () => {
    leaked++
    throw new Error('demo-seed: replay asked for a model call; the seed is not a cache hit')
  },
}
const replayCode = await main(['run'], { ...quiet, createClient: () => refuse })
const report = JSON.parse(await readFile(join(config.reportDir, 'run.json'), 'utf8'))
if (replayCode !== 0 || leaked !== 0 || report.totals.visionCalls !== 0) {
  console.error(`demo-seed: replay is not a $0 cache hit (exit ${replayCode}, ${leaked} model calls)`)
  process.exit(1)
}
console.log(join(config.cacheDir, `${flowName}.json`))
