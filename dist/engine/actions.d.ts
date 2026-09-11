import type { BrowserDriver, Observation } from '../driver/browser.js';
/**
 * Action primitives over the driver page. All coordinates are plain viewport
 * pixels — the pinned viewport + deviceScaleFactor: 1 means model coordinates
 * map 1:1 (KTD2). Every action returns a post-action observation so callers
 * can verify the result immediately.
 */
export declare class Actions {
    private readonly driver;
    constructor(driver: BrowserDriver);
    /** Single click at viewport pixel (x, y). */
    click(x: number, y: number): Promise<Observation>;
    /** Double click at viewport pixel (x, y). */
    doubleClick(x: number, y: number): Promise<Observation>;
    /** Type text into the currently focused element. */
    type(text: string): Promise<Observation>;
    /**
     * Press keys in sequence. Each entry is a key name ('Enter', 'Tab') or a
     * chord ('Control+a', 'Shift+ArrowLeft').
     */
    pressKeys(keys: string[]): Promise<Observation>;
    /** Scroll the page by (dx, dy) viewport pixels. */
    scroll(dx: number, dy: number): Promise<Observation>;
    /** Wait ms milliseconds, then observe. */
    wait(ms: number): Promise<Observation>;
}
