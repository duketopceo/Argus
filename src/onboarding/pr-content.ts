/**
 * Pure, runtime-neutral pieces of the onboarding PR: name validation and the
 * PR body. No Node imports, so the CLI (`init --pr`) and the App Worker
 * (bundled for Cloudflare) render the same PR and cannot drift.
 */
import { scaffoldChecklist } from './scaffold.js'

export const DEFAULT_BRANCH = 'argus/onboarding'

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
/** A validation message, or undefined when the repo slug is safe to use in argv and URLs. */
export function validateRepo(repo: string): string | undefined {
  if (!REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
    return `--repo must look like owner/name (letters, digits, . _ -), got ${JSON.stringify(repo)}`
  }
  return undefined
}

export function validateBranch(branch: string): string | undefined {
  if (
    !BRANCH_RE.test(branch) ||
    branch.includes('..') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock')
  ) {
    return `--branch is not a safe branch name: ${JSON.stringify(branch)}`
  }
  return undefined
}

interface PrBodyInput {
  repo: string
  /** Default per-run budget in USD, from the resolved config defaults. */
  budgetUsd: number
  /** Files this PR adds. */
  paths: string[]
}

export function renderPrBody(input: PrBodyInput): string {
  const { repo, budgetUsd, paths } = input
  return `## Add Argus reviewer

This PR adds a review-only [Argus](https://github.com/duketopceo/Argus) setup. Nothing runs until it is merged.

### Files added

${paths.map((p) => `- \`${p}\``).join('\n')}

### Before merging: add the secret

- [ ] Add \`OPENROUTER_API_KEY\` as a repository secret: https://github.com/${repo}/settings/secrets/actions/new?name=OPENROUTER_API_KEY
  - Or from your own terminal: \`gh secret set OPENROUTER_API_KEY --repo ${repo}\`
- [ ] Review the workflow files above. They use \`pull_request\` (never \`pull_request_target\`), \`persist-credentials: false\`, a pinned action SHA and least-privilege \`permissions\`.

Argus never sees your key. It is your OpenRouter key (BYOK) and it stays in your repository secrets. The command that opened this PR did not read it.

### What runs and what it costs

\`\`\`
${scaffoldChecklist(budgetUsd).join('\n')}
\`\`\`

### How to stop or uninstall

- Remove \`.github/workflows/argus-reviewer.yml\` and \`.github/workflows/argus-mention.yml\`, or
- delete the \`OPENROUTER_API_KEY\` repository secret (reviews stop, nothing else changes).
- Optionally delete \`argus-reviewer.config.ts\` and \`tests/argus/\`.
`
}
