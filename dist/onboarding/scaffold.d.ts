/**
 * Pure scaffold generator shared by `argus-reviewer init` and `init --pr`
 * (and, later, the App's onboarding Worker, so the surfaces cannot drift).
 * No I/O, no config execution, no environment reads. Workflow templates keep
 * `persist-credentials: false`, a pinned action SHA, least-privilege
 * `permissions`, and never `pull_request_target`.
 */
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
export declare const INIT_WORKFLOW = "name: argus-reviewer\n\non:\n  pull_request:\n    # 'labeled' lets a maintainer re-trigger with the argus-probe label when\n    # sandbox probes are enabled for fork PRs.\n    types: [opened, synchronize, reopened, labeled]\n\njobs:\n  argus:\n    runs-on: ubuntu-latest\n    # 'labeled' fires on EVERY label \u2014 only argus-probe is the fork-gate\n    # signal worth a full review run.\n    if: github.event.action != 'labeled' || github.event.label.name == 'argus-probe'\n    permissions:\n      contents: read\n      issues: write\n      pull-requests: write\n      checks: write\n      statuses: write\n    steps:\n      # persist-credentials: false keeps the GITHUB_TOKEN out of .git/config \u2014\n      # the probe sandbox masks .git regardless, but don't store it at all.\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n        with:\n          persist-credentials: false\n          ref: ${{ github.event.pull_request.head.sha || github.sha }}\n      # Optional verdict-as-review: let Argus submit APPROVE / REQUEST_CHANGES\n      # so require_approving_reviews counts it. GITHUB_TOKEN cannot approve, so\n      # create + install your own GitHub App (docs/github-app.md), set the\n      # ARGUS_APP_ID variable and ARGUS_APP_PRIVATE_KEY secret, then uncomment:\n      #      - uses: actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349 # v2\n      #        id: argus-app\n      #        with:\n      #          app-id: ${{ vars.ARGUS_APP_ID }}\n      #          private-key: ${{ secrets.ARGUS_APP_PRIVATE_KEY }}\n      # and pass approval-token plus its evidence inputs to the action below:\n      #          approval-token: ${{ steps.argus-app.outputs.token }}\n      #          approval-evidence: 'npm test'   # command the approval stands on\n      #          approval-check: 'test'          # check-run name, green on head SHA\n      - uses: duketopceo/Argus/action@63c9575622afef8bf4a8f2ea2d2909c6e54505d3 # v0.4.1\n        with:\n          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}\n";
export declare const INIT_MENTION_WORKFLOW = "name: argus-mention\n\n# @argus mention commands on PR comments \u2014 '@argus review', '@argus\n# record \"<flow>\"', '@argus persist', '@argus help'. issue_comment is\n# strictly more privileged than pull_request (secrets + write token are\n# present), so the checkout below deliberately resolves the BASE ref \u2014\n# never the PR head. Argus reviews the head diff over the API.\non:\n  issue_comment:\n    types: [created]\n\njobs:\n  argus-mention:\n    runs-on: ubuntu-latest\n    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '@argus')\n    permissions:\n      # contents: write \u2014 '@argus persist' commits reproduced probes to an\n      # argus/ branch via the git/refs + contents APIs and opens a PR.\n      contents: write\n      issues: write\n      pull-requests: write\n      checks: write\n      statuses: write\n    steps:\n      # No 'ref' \u2014 the default checkout resolves the base branch. persist\n      # writes via the API, so checkout credentials stay disabled.\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n        with:\n          persist-credentials: false\n      # Record commands need the app's dependencies to boot its target.\n      # Uncomment if you use '@argus record':\n      # - run: npm ci\n      - uses: duketopceo/Argus/action@63c9575622afef8bf4a8f2ea2d2909c6e54505d3 # v0.4.1\n        with:\n          openrouter-api-key: ${{ secrets.OPENROUTER_API_KEY }}\n      # '@argus record' uploads the generated test + flow cache as an\n      # artifact \u2014 committing to a PR branch is intentionally not done.\n      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        if: contains(github.event.comment.body, 'record')\n        with:\n          name: argus-recorded-flow\n          path: |\n            tests/argus/\n            .argus-reviewer-cache/\n          if-no-files-found: ignore\n";
export declare const CONFIG_PATH = "argus-reviewer.config.ts";
/** The files `init` writes, in write order. */
export declare function renderScaffold(opts: ScaffoldOptions): ScaffoldFile[];
/**
 * "What runs and what it costs": what is sent to the provider, the default
 * budget, and the stop path. Kept verbatim (DESIGN 7.8). `budgetUsd` comes
 * from the caller's resolved defaults so it cannot go stale here.
 */
export declare function scaffoldChecklist(budgetUsd: number): string[];
