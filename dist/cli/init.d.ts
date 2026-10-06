import { type Ctx, type CliDeps } from './shared.js';
export declare const INIT_USAGE = "Usage: argus-reviewer init [options]\n\n\nScaffolds a working setup in the current directory:\n  argus-reviewer.config.ts               config (target, budget, testsDir)\n  tests/argus/smoke.test.ts              a td-API smoke test\n  .github/workflows/argus-reviewer.yml   PR workflow using the action\n  .github/workflows/argus-mention.yml    @argus PR-comment commands\n\nThen reports which optional features your environment already supports\n(OpenRouter key, Playwright browsers, gh auth, Agent Zero).\n\nOptions:\n  --force   Overwrite files that already exist\n  --pr      Open an onboarding pull request instead of writing files here\n            (uses your git and gh; never reads or sends your OpenRouter key)\n  --repo <owner/name>   With --pr: confirm the target (must match origin)\n  --branch <name>       With --pr: branch to use (default argus/onboarding)\n  -h, --help\n\n--pr refuses to overwrite existing files and, if the branch or an open PR\nalready exists, reports it instead of creating another.";
/** `argus-reviewer init --pr` — open an onboarding PR through local git + gh. */
export declare function cmdInitPr(values: {
    force?: boolean | undefined;
    repo?: string | undefined;
    branch?: string | undefined;
}, ctx: Ctx, deps: CliDeps): Promise<number>;
/** `argus-reviewer init` — scaffold config, a smoke test, and the workflow. */
export declare function cmdInit(args: string[], ctx: Ctx, deps: CliDeps): Promise<number>;
