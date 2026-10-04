/**
 * Pure scaffold generator shared by `argus-reviewer init` and `init --pr`
 * (and, later, the App's onboarding Worker, so the surfaces cannot drift).
 * No I/O, no config execution, no environment reads. Workflow templates keep
 * `persist-credentials: false`, a pinned action SHA, least-privilege
 * `permissions`, and never `pull_request_target`.
 */
/**
 * The one place the user-facing action pin lives. Bump it here (and the golden
 * fixtures) on release; see RELEASING.md. v0.4.0 and v0.4.1 ship an action.yml
 * GitHub cannot parse, so never pin to them.
 */
export declare const ACTION_PIN_SHA = "c2bcd160272c67ec0bd531fa664435a2456c0d47";
export declare const ACTION_PIN_TAG = "v0.4.2";
export interface ScaffoldFile {
    path: string;
    content: string;
}
export interface ScaffoldOptions {
    /** Detected Agent Zero host: earns a commented suggestion in the config, never an enabled lane. */
    a0Host: string | undefined;
    /** False when a config file already exists (init without --force). */
    includeConfig: boolean;
}
export declare function initConfig(a0Host: string | undefined): string;
export declare const INIT_TEST = "test('home renders', async (td) => {\n  const ok = await td.assert('the page rendered without obvious errors')\n  if (!ok) throw new Error('home did not render')\n})\n";
export declare const INIT_WORKFLOW: string;
export declare const INIT_MENTION_WORKFLOW: string;
export declare const CONFIG_PATH = "argus-reviewer.config.ts";
/** The files `init` writes, in write order. */
export declare function renderScaffold(opts: ScaffoldOptions): ScaffoldFile[];
/**
 * "What runs and what it costs": what is sent to the provider, the default
 * budget, and the stop path. Kept verbatim (DESIGN 7.8). `budgetUsd` comes
 * from the caller's resolved defaults so it cannot go stale here.
 */
export declare function scaffoldChecklist(budgetUsd: number): string[];
