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
export const ACTION_PIN_SHA = 'bc462fa66018e149eac1b32e36ac34b4f2eb2d56'
export const ACTION_PIN_TAG = 'v0.4.2'
const ACTION_PIN = `${ACTION_PIN_SHA} # ${ACTION_PIN_TAG}`

export interface ScaffoldFile {
  path: string
  content: string
}

export interface ScaffoldOptions {
  /** Detected Agent Zero host: earns a commented suggestion in the config, never an enabled lane. */
  a0Host: string | undefined
  /** False when a config file already exists (init without --force). */
  includeConfig: boolean
}

export function initConfig(a0Host: string | undefined): string {
  // R19 — a detected Agent Zero host earns a labeled suggestion, never an
  // enabled lane: `verify --a0` is explicit opt-in per run, and completed
  // delegations cap at inconclusive (self-reported evidence).
  const a0Block =
    a0Host !== undefined
      ? `
  // Optional: Agent Zero detected at ${a0Host}. Nothing below runs unless
  // you ask for it — both stays commented until you opt in deliberately.
  //   a0: { url: ${JSON.stringify(a0Host)} },  // enables \`verify --a0\` (self-reported, unmetered)
  //   heal: 'a0',                             // escalates a failed heal to the A0 host
`
      : ''
  return `import { defineConfig } from 'argus-reviewer-e2e'

export default defineConfig({
  // The app under test. command boots it (omit if it is already running);
  // argus-reviewer polls url until it responds before running tests.
  target: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    readyTimeoutMs: 30_000,
  },
  // Hard per-run cap on vision-model spend (USD). Steps replayed from the
  // fingerprint cache cost $0 regardless of this cap.
  budgetUsd: 1,
  testsDir: 'tests/argus',
  // Exploratory lane: after the test loop, a bounded agent pass probes the
  // app itself — same-origin navigation, clicks, invalid input — while taps
  // capture console errors, page errors, and failed requests. Findings
  // render as 'observed' — evidence only, never verdict-changing.
  // maxSteps caps acts per run; budgetUsd caps explore model spend (falls
  // back to budgetUsd). Point it at disposable targets only — clicks and
  // form submits have real side effects.
  // explore: { enabled: true, maxSteps: 20, budgetUsd: 0.25 },${a0Block}
})
`
}

export const INIT_TEST = `test('home renders', async (td) => {
  const ok = await td.assert('the page rendered without obvious errors')
  if (!ok) throw new Error('home did not render')
})
`

export const INIT_WORKFLOW = `name: argus-reviewer

on:
  pull_request:
    # 'labeled' lets a maintainer re-trigger with the argus-probe label when
    # sandbox probes are enabled for fork PRs.
    types: [opened, synchronize, reopened, labeled]

jobs:
  argus:
    runs-on: ubuntu-latest
    # 'labeled' fires on EVERY label — only argus-probe is the fork-gate
    # signal worth a full review run.
    if: github.event.action != 'labeled' || github.event.label.name == 'argus-probe'
    permissions:
      contents: read
      issues: write
      pull-requests: write
      checks: write
      statuses: write
    steps:
      # persist-credentials: false keeps the GITHUB_TOKEN out of .git/config —
      # the probe sandbox masks .git regardless, but don't store it at all.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
      # Optional verdict-as-review: let Argus submit APPROVE / REQUEST_CHANGES
      # so require_approving_reviews counts it. GITHUB_TOKEN cannot approve, so
      # create + install your own GitHub App (docs/github-app.md), set the
      # ARGUS_APP_ID variable and ARGUS_APP_PRIVATE_KEY secret, then uncomment:
      #      - uses: actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349 # v2
      #        id: argus-app
      #        with:
      #          app-id: \${{ vars.ARGUS_APP_ID }}
      #          private-key: \${{ secrets.ARGUS_APP_PRIVATE_KEY }}
      # and pass approval-token plus its evidence inputs to the action below:
      #          approval-token: \${{ steps.argus-app.outputs.token }}
      #          approval-evidence: 'npm test'   # command the approval stands on
      #          approval-check: 'test'          # check-run name, green on head SHA
      - uses: duketopceo/Argus/action@@@ACTION_PIN@@
        with:
          openrouter-api-key: \${{ secrets.OPENROUTER_API_KEY }}
`.replace('@@ACTION_PIN@@', ACTION_PIN)

export const INIT_MENTION_WORKFLOW = `name: argus-mention

# @argus mention commands on PR comments — '@argus review', '@argus
# record "<flow>"', '@argus persist', '@argus help'. issue_comment is
# strictly more privileged than pull_request (secrets + write token are
# present), so the checkout below deliberately resolves the BASE ref —
# never the PR head. Argus reviews the head diff over the API.
on:
  issue_comment:
    types: [created]

jobs:
  argus-mention:
    runs-on: ubuntu-latest
    if: github.event.issue.pull_request && startsWith(github.event.comment.body, '@argus')
    permissions:
      # contents: write — '@argus persist' commits reproduced probes to an
      # argus/ branch via the git/refs + contents APIs and opens a PR.
      contents: write
      issues: write
      pull-requests: write
      checks: write
      statuses: write
    steps:
      # No 'ref' — the default checkout resolves the base branch. persist
      # writes via the API, so checkout credentials stay disabled.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false
      # Record commands need the app's dependencies to boot its target.
      # Uncomment if you use '@argus record':
      # - run: npm ci
      - uses: duketopceo/Argus/action@@@ACTION_PIN@@
        with:
          openrouter-api-key: \${{ secrets.OPENROUTER_API_KEY }}
      # '@argus record' uploads the generated test + flow cache as an
      # artifact — committing to a PR branch is intentionally not done.
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        if: contains(github.event.comment.body, 'record')
        with:
          name: argus-recorded-flow
          path: |
            tests/argus/
            .argus-reviewer-cache/
          if-no-files-found: ignore
`.replace('@@ACTION_PIN@@', ACTION_PIN)

export const CONFIG_PATH = 'argus-reviewer.config.ts'

/** The files `init` writes, in write order. */
export function renderScaffold(opts: ScaffoldOptions): ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    { path: 'tests/argus/smoke.test.ts', content: INIT_TEST },
    { path: '.github/workflows/argus-reviewer.yml', content: INIT_WORKFLOW },
    { path: '.github/workflows/argus-mention.yml', content: INIT_MENTION_WORKFLOW },
  ]
  if (opts.includeConfig) files.unshift({ path: CONFIG_PATH, content: initConfig(opts.a0Host) })
  return files
}

/**
 * "What runs and what it costs": what is sent to the provider, the default
 * budget, and the stop path. Kept verbatim (DESIGN 7.8). `budgetUsd` comes
 * from the caller's resolved defaults so it cannot go stale here.
 */
export function scaffoldChecklist(budgetUsd: number): string[] {
  return [
    'What runs and what it costs:',
    '  sent to provider  PR diffs, page screenshots/DOM snapshots, and',
    '                    review prompts — via your OpenRouter key (BYOK)',
    `  default budget    $${budgetUsd}/run cap (budgetUsd); cached replay costs $0`,
    '  how to stop       Ctrl+C locally; in CI remove the workflow file',
    '                    or delete the OPENROUTER_API_KEY secret',
  ]
}
