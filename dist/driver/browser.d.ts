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
    /**
     * Exploratory capture (U4a): record page errors, console errors, and
     * failed same-origin requests during the run. Free — no model calls.
     */
    captureErrors?: boolean;
}
/**
 * One runtime anomaly observed while the browser was driving the app —
 * becomes an `observed` finding on the run report. Captures never change a
 * verdict; they are evidence, not adjudication.
 */
export interface PageCapture {
    kind: 'console-error' | 'pageerror' | 'request-failed';
    /** Normalized, truncated message or failure signature. */
    text: string;
    /** Failing request URL (request-failed only, same-origin only). */
    url?: string;
    /** Collapsed repeat count for this signature. */
    count: number;
}
/** Distinct capture signatures kept per browser session. */
export declare const MAX_CAPTURE_SIGNATURES = 50;
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
    private readonly captures;
    private constructor();
    static launch(options?: BrowserDriverOptions): Promise<BrowserDriver>;
    /**
     * Exploratory capture taps (U4a). Noise controls are applied at collection:
     * identical signatures collapse into one capture with a repeat count,
     * request-failed events drop third-party origins (analytics/tag beacons
     * failing is noise, not signal), and distinct signatures are capped.
     */
    private _attachCaptureTaps;
    private _addCapture;
    /** Captured page anomalies for this session — empty unless captureErrors. */
    pageCaptures(): PageCapture[];
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
