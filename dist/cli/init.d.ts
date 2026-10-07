import { type Ctx, type CliDeps } from './shared.js';
/** `argus-reviewer init` — scaffold config, a smoke test, and the workflow. */
export declare function cmdInit(args: string[], ctx: Ctx, deps: CliDeps): Promise<number>;
