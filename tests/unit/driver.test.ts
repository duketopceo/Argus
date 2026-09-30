import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BrowserDriver } from '../../src/driver/browser.js'
import { TargetProcess } from '../../src/driver/target.js'
import { Actions } from '../../src/engine/actions.js'

const FIXTURE_URL = fileURLToPath(new URL('../fixtures/index.html', import.meta.url))
const SERVE_SCRIPT = fileURLToPath(new URL('../fixtures/serve.mjs', import.meta.url))
const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

const markerState = (driver: BrowserDriver) =>
  driver.rawPage.locator('#marker').getAttribute('data-marker')

describe('BrowserDriver + Actions (fixture page)', () => {
  let driver: BrowserDriver
  let actions: Actions
  let videoDir: string
  let videoPath: string | undefined

  beforeAll(async () => {
    videoDir = await mkdtemp(join(tmpdir(), 'argus-test-video-'))
    driver = await BrowserDriver.launch({
      viewport: { width: 1280, height: 720 },
      videoDir,
      browserTimeoutMs: 8_000,
    })
    actions = new Actions(driver)
    await driver.goto(`file://${FIXTURE_URL}`)
  })

  afterAll(async () => {
    videoPath = await driver.close()
  })

  it('a click at known viewport coords lands on the intended element', async () => {
    // #click-target occupies x:100-300, y:100-160 — click its center.
    const obs = await actions.click(200, 130)
    expect(await markerState(driver)).toBe('clicked')
    expect(obs.a11yYaml).toContain('Click me')
  })

  it('observation screenshot is a JPEG under a size bound', async () => {
    const { screenshotJpeg } = await driver.observe()
    // JPEG magic bytes
    expect(screenshotJpeg[0]).toBe(0xff)
    expect(screenshotJpeg[1]).toBe(0xd8)
    expect(screenshotJpeg[screenshotJpeg.length - 2]).toBe(0xff)
    expect(screenshotJpeg[screenshotJpeg.length - 1]).toBe(0xd9)
    // 1280x720 fixture at q70 should be far below 200 KB
    expect(screenshotJpeg.length).toBeLessThan(200_000)
  })

  it('grid overlay does not leak into the a11y snapshot', async () => {
    const plain = await driver.observe()
    const gridded = await driver.observe({ grid: true })
    expect(gridded.a11yYaml).toBe(plain.a11yYaml)
    expect(gridded.a11yYaml).not.toContain('__vision_e2e_grid')
    // And the overlay is removed afterwards — a second plain observe is clean.
    expect((await driver.observe()).a11yYaml).toBe(plain.a11yYaml)
  })

  it('observation includes a11y YAML text from the page', async () => {
    const { a11yYaml } = await driver.observe()
    expect(a11yYaml).toContain('button')
    expect(a11yYaml).toContain('Double click me')
    expect(a11yYaml).toContain('Name')
  })

  it('type + pressKeys act on the page and return observations', async () => {
    await driver.rawPage.locator('#name-input').click()
    const obs = await actions.type('vision')
    expect(await markerState(driver)).toBe('typed:vision')
    await actions.pressKeys(['Enter'])
    expect(await markerState(driver)).toBe('enter')
    expect(obs.screenshotJpeg.length).toBeGreaterThan(0)
  })

  it('scroll moves the viewport', async () => {
    await actions.scroll(0, 500)
    const y = await driver.rawPage.evaluate(() => window.scrollY)
    expect(y).toBeGreaterThan(0)
  })

  it('video artifact exists on disk after the run', async () => {
    videoPath = await driver.close()
    // driver is closed for subsequent describe blocks; video is finalized here.
    expect(videoPath).toBeDefined()
    expect(videoPath).toMatch(/\.webm$/)
    expect(existsSync(videoPath as string)).toBe(true)
  })
})

describe('exploratory capture (U4a)', () => {
  const EXPLORE_URL = fileURLToPath(new URL('../fixtures/explore.html', import.meta.url))
  let port: number
  let target: TargetProcess | undefined

  beforeAll(async () => {
    port = 4300 + Math.floor(Math.random() * 500)
    target = await TargetProcess.start({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_SCRIPT)} ${port} ${JSON.stringify(FIXTURE_DIR)}`,
      url: `http://127.0.0.1:${port}/`,
      readyTimeoutMs: 10_000,
    })
  })

  afterAll(async () => {
    await target?.stop()
  })

  const settle = async (driver: BrowserDriver, ms = 250) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)).then(() =>
      driver.pageCaptures(),
    )

  it('is off by default — no taps, no captures', async () => {
    const driver = await BrowserDriver.launch({ browserTimeoutMs: 8_000 })
    try {
      await driver.goto(`file://${EXPLORE_URL}`)
      await new Promise((r) => setTimeout(r, 250))
      expect(driver.pageCaptures()).toEqual([])
    } finally {
      await driver.close()
    }
  })

  it('captures console errors and page errors, collapsing repeats', async () => {
    const driver = await BrowserDriver.launch({ captureErrors: true, browserTimeoutMs: 8_000 })
    try {
      await driver.goto(`file://${EXPLORE_URL}`)
      const caps = await settle(driver)
      const consoleErr = caps.find(
        (c) => c.kind === 'console-error' && c.text.includes('seeded console boom'),
      )
      expect(consoleErr?.count).toBe(3)
      expect(
        caps.some((c) => c.kind === 'pageerror' && c.text.includes('seeded page boom')),
      ).toBe(true)
    } finally {
      await driver.close()
    }
  })

  it('keeps same-origin request failures, drops third-party', async () => {
    const driver = await BrowserDriver.launch({ captureErrors: true, browserTimeoutMs: 8_000 })
    try {
      await driver.rawPage.route('**/explore-aborted', (route) => route.abort())
      await driver.goto(`http://127.0.0.1:${port}/explore.html`)
      // Same-origin request aborted → requestfailed kept.
      await driver.rawPage.evaluate(() => fetch('/explore-aborted').catch(() => 'done'))
      // Third-party (different port = different origin) connection refused → filtered.
      await driver.rawPage.evaluate(() => fetch('http://127.0.0.1:1/beacon').catch(() => 'done'))
      const caps = await settle(driver)
      const failed = caps.filter((c) => c.kind === 'request-failed')
      expect(failed).toHaveLength(1)
      expect(failed[0]?.url).toBe(`http://127.0.0.1:${port}/explore-aborted`)
    } finally {
      await driver.close()
    }
  })

  it('caps distinct signatures', async () => {
    const driver = await BrowserDriver.launch({ captureErrors: true, browserTimeoutMs: 8_000 })
    try {
      await driver.goto(`http://127.0.0.1:${port}/`)
      for (let i = 0; i < 60; i++) {
        await driver.rawPage.evaluate((n) => console.error(`distinct boom ${n}`), i)
      }
      // Console events dispatch asynchronously — poll until capped.
      let caps = driver.pageCaptures()
      for (let i = 0; i < 20 && caps.length < 50; i++) {
        await new Promise((r) => setTimeout(r, 100))
        caps = driver.pageCaptures()
      }
      expect(caps.filter((c) => c.text.startsWith('distinct boom')).length).toBe(50)
    } finally {
      await driver.close()
    }
  })
})

describe('TargetProcess boot adapter', () => {
  it('spawns the command, waits for ready, and stop() kills the child tree', async () => {
    const port = 4199
    const target = await TargetProcess.start({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SERVE_SCRIPT)} ${port} ${JSON.stringify(FIXTURE_DIR)}`,
      url: `http://127.0.0.1:${port}/`,
      readyTimeoutMs: 10_000,
    })

    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('argus fixture')

    const pid = target.pid
    await target.stop()

    if (pid !== undefined) {
      expect(() => process.kill(pid, 0)).toThrow()
    }
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })

  it('times out cleanly on a never-ready URL and kills the spawned process', async () => {
    // Command stays alive but never listens on the polled port.
    const command = `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`
    await expect(
      TargetProcess.start({
        command,
        url: 'http://127.0.0.1:1/never-ready',
        readyTimeoutMs: 1_500,
      }),
    ).rejects.toThrow(/never-ready.*1500ms|1500ms.*never-ready/s)
  })

  it('fails fast when the command exits before ready', async () => {
    await expect(
      TargetProcess.start({
        command: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
        url: 'http://127.0.0.1:1/',
        readyTimeoutMs: 10_000,
      }),
    ).rejects.toThrow(/exited before/)
  })
})
