import { type Page } from 'playwright';
export interface Viewport {
    width: number;
    height: number;
}
export interface BrowserDriverOptions {
    /** Pinned viewport in CSS pixels. Model coordinates map 1:1 onto this. */
    viewport?: Viewport;
    /** Directory for the per-run webm recording. Defaults to a fresh temp dir. */
    videoDir?: string;
    /** JPEG quality 0-100 for observation screenshots. */
    screenshotQuality?: number;
    /** Optional scale factor for the observation screenshot (<=1 downscales). */
    screenshotScale?: number;
    /** Playwright browser engine: `chromium` (default), `firefox`, or `webkit`. */
    browser?: 'chromium' | 'firefox' | 'webkit' | undefined;
    /** Hard limit in ms for Playwright cleanup. */
    browserTimeoutMs?: number | undefined;
}
export interface Observation {
    screenshotJpeg: Buffer;
    a11yYaml: string;
    /** Viewport (CSS pixels) the screenshot was taken at — model coords map 1:1. */
    width: number;
    height: number;
}
/**
 * One Playwright context per run. Viewport and deviceScaleFactor are pinned so
 * vision-model pixel coordinates map 1:1 to viewport pixels (KTD2).
 */
export declare class BrowserDriver {
    private readonly browser;
    private readonly context;
    private readonly page;
    private readonly quality;
    private readonly videoDir;
    private readonly viewport;
    private readonly browserTimeoutMs;
    private video;
    private closed;
    private constructor();
    static launch(options?: BrowserDriverOptions): Promise<BrowserDriver>;
    get rawPage(): Page;
    get recordingDir(): string;
    goto(url: string): Promise<void>;
    /**
     * Capture the current observation: a bounded JPEG screenshot plus the page's
     * a11y tree as YAML via ariaSnapshot (not the deprecated accessibility API).
     *
     * `grid: true` paints a temporary coordinate overlay (lines + axis labels
     * every 100px) before the screenshot and removes it immediately after — the
     * set-of-marks trick that measurably improves vision-model pixel grounding.
     */
    observe(options?: {
        grid?: boolean;
    }): Promise<Observation>;
    private _paintGrid;
    private _removeGrid;
    /** Path of the recorded webm, available after close(). */
    videoPath(): string | undefined;
    /** Close the context and browser; resolves the video artifact path. Idempotent. */
    close(): Promise<string | undefined>;
    private _withTimeout;
}
