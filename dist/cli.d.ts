#!/usr/bin/env node
import { Config } from './config.js';
import { BrowserDriver } from './driver/browser.js';
import { VisionClient } from './engine/loop.js';
export interface CliDeps {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    out?: (line: string) => void;
    err?: (line: string) => void;
    /** Inject a vision client (tests stub this; default builds OpenRouterClient). */
    createClient?: (config: Config) => VisionClient;
    /** Inject a driver factory (tests may stub browser launch). */
    launchDriver?: (config: Config) => Promise<BrowserDriver>;
}
export declare function main(argv: string[], deps?: CliDeps): Promise<number>;
interface PrFile {
    filename: string;
    previous_filename?: string;
    patch?: string;
}
export declare function buildPatchChunks(files: PrFile[], contexts?: Record<string, string>): string[];
export {};
