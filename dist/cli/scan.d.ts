import { type Ctx, type CliDeps } from './shared.js';
/**
 * `argus scan` — U7 audit mode. Deterministic rules + secrets over a
 * synthesized tree diff (or `git diff <base>`), optional model pass under
 * the same exclusion contract, standalone scan-report.json.
 */
export declare function cmdScan(args: string[], ctx: Ctx, deps: CliDeps): Promise<number>;
