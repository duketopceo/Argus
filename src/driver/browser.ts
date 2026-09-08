import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

export interface Viewport {
  width: number
  height: number
}

export interface BrowserDriverOptions {
  /** Pinned viewport in CSS pixels. Model coordinates map 1:1 onto this. */
  viewport?: Viewport
  /** Directory for the per-run webm recording. Defaults to a fresh temp dir. */
  videoDir?: string
  /** JPEG quality 0-100 for observation screenshots. */
  screenshotQuality?: number
  /** Optional scale factor for the observation screenshot (<=1 downscales). */
  screenshotScale?: number
}

export interface Observation {
  screenshotJpeg: Buffer
  a11yYaml: string
}

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 }
const DEFAULT_QUALITY = 70

/**
 * One Playwright context per run. Viewport and deviceScaleFactor are pinned so
 * vision-model pixel coordinates map 1:1 to viewport pixels (KTD2).
 */
export class BrowserDriver {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly quality: number,
    private readonly videoDir: string,
    private video: string | undefined,
    private closed = false,
  ) {}

  static async launch(options: BrowserDriverOptions = {}): Promise<BrowserDriver> {
    const viewport = options.viewport ?? DEFAULT_VIEWPORT
    const videoDir = options.videoDir ?? (await mkdtemp(join(tmpdir(), 'vision-e2e-video-')))
    await mkdir(videoDir, { recursive: true })

    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        recordVideo: { dir: videoDir, size: viewport },
      })
      const page = await context.newPage()
      return new BrowserDriver(
        browser,
        context,
        page,
        options.screenshotQuality ?? DEFAULT_QUALITY,
        videoDir,
        undefined,
      )
    } catch (e) {
      await browser.close()
      throw e
    }
  }

  get rawPage(): Page {
    return this.page
  }

  get recordingDir(): string {
    return this.videoDir
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'load' })
  }

  /**
   * Capture the current observation: a bounded JPEG screenshot plus the page's
   * a11y tree as YAML via ariaSnapshot (not the deprecated accessibility API).
   */
  async observe(): Promise<Observation> {
    const screenshotJpeg = await this.page.screenshot({
      type: 'jpeg',
      quality: this.quality,
      scale: 'css',
    })
    const a11yYaml = await this.page.locator('body').ariaSnapshot()
    return { screenshotJpeg, a11yYaml }
  }

  /** Path of the recorded webm, available after close(). */
  videoPath(): string | undefined {
    return this.video
  }

  /** Close the context and browser; resolves the video artifact path. Idempotent. */
  async close(): Promise<string | undefined> {
    if (this.closed) return this.video
    this.closed = true
    const video = this.page.video()
    await this.context.close()
    if (video) {
      try {
        this.video = await video.path()
      } catch {
        this.video = undefined
      }
    }
    await this.browser.close()
    return this.video
  }
}
