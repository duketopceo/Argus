import { type Ctx, type CliDeps } from './shared.js';
/** `argus-reviewer delegate` — hand a task to an Agent Zero instance. */
export declare function cmdDelegate(args: string[], ctx: Ctx, deps: CliDeps): Promise<number>;
