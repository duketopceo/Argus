import { Config } from '../config.js';
import { BrowserDriver } from '../driver/browser.js';
import { type Ctx, type CliDeps } from './shared.js';
export declare function cmdRecord(args: string[], ctx: Ctx, deps: CliDeps): Promise<number>;
export declare function discoverTestFiles(dir: string): Promise<string[]>;
export declare function importModule(file: string, tmpDir: string): Promise<Record<string, unknown>>;
export declare function importTestFile(file: string, tmpDir: string): Promise<void>;
export type PageSetupFn = (page: unknown) => void | Promise<void>;
/**
 * Optional `config.pageSetup` module: default-exported function invoked with
 * the Playwright Page after launch, before navigation — the seam for
 * page.route mocks and pre-navigation seeding.
 */
export declare function applyPageSetup(config: Config, driver: BrowserDriver, ctx: Ctx, tmpDir: string): Promise<void>;
export interface GlobalPatch {
    key: string;
    previous: unknown;
}
export declare function patchGlobals(): GlobalPatch[];
export declare function restoreGlobals(patches: GlobalPatch[]): void;
