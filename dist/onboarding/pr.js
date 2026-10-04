/**
 * `argus-reviewer init --pr`: open an onboarding pull request instead of
 * writing into the working tree.
 *
 * Shells out to the local `git` and `gh` through the injected ExecFn, so the
 * user's own credentials do the pushing and nothing about the repo reaches
 * Argus. The scaffold is committed in a throwaway git worktree, never in the
 * user's checkout. This module never reads, prints or transmits
 * OPENROUTER_API_KEY: the PR only names the secret and links to the page
 * where the user adds it themselves.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from '../ui/errors.js';
import { renderScaffold, scaffoldChecklist } from './scaffold.js';
export const DEFAULT_BRANCH = 'argus/onboarding';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CONFIG_NAMES = [
    'argus-reviewer.config.ts',
    'argus-reviewer.config.json',
    'vision-e2e.config.ts',
    'vision-e2e.config.json',
];
const SHORT_MS = 30_000;
const NET_MS = 120_000;
/** A validation message, or undefined when the repo slug is safe to use in argv and URLs. */
export function validateRepo(repo) {
    if (!REPO_RE.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
        return `--repo must look like owner/name (letters, digits, . _ -), got ${JSON.stringify(repo)}`;
    }
    return undefined;
}
export function validateBranch(branch) {
    if (!BRANCH_RE.test(branch) ||
        branch.includes('..') ||
        branch.endsWith('/') ||
        branch.endsWith('.lock')) {
        return `--branch is not a safe branch name: ${JSON.stringify(branch)}`;
    }
    return undefined;
}
/** owner/name from a GitHub remote URL (ssh, https, with or without .git). */
export function parseGithubRemote(url) {
    const m = url.trim().match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
    return m?.[1];
}
export function renderPrBody(input) {
    const { repo, budgetUsd, paths } = input;
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
`;
}
function fail(message, fix) {
    return new CliError('COMMAND_FAILED', message, fix !== undefined ? { fix } : {});
}
export async function initPr(opts) {
    const { cwd, exec, branch } = opts;
    const git = (args, ms = SHORT_MS) => exec('git', ['-C', cwd, ...args], ms);
    const gh = (args, ms = SHORT_MS) => exec('gh', args, ms);
    // 1. Which repo. The checkout's origin is the push target, so --repo may
    //    only confirm it, never redirect it.
    const originRes = await git(['remote', 'get-url', 'origin']);
    const originRepo = originRes.code === 0 ? parseGithubRemote(originRes.stdout) : undefined;
    if (originRepo === undefined) {
        throw fail('this checkout has no GitHub remote named origin to push the onboarding branch to', 'git remote add origin https://github.com/<owner>/<name>.git');
    }
    if (opts.repo !== undefined && opts.repo.toLowerCase() !== originRepo.toLowerCase()) {
        throw fail(`--repo ${opts.repo} does not match this checkout's origin (${originRepo})`, `run it from a checkout of ${opts.repo}, or drop --repo`);
    }
    const repo = originRepo;
    // 2. An open onboarding PR already? Report it and stop.
    const listed = await gh([
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        branch,
        '--state',
        'open',
        '--json',
        'url',
    ]);
    if (listed.code !== 0) {
        throw fail(`could not query pull requests with gh: ${firstLine(listed.stderr) || 'gh not available'}`, 'install the GitHub CLI and run: gh auth login');
    }
    const existingUrl = firstUrl(listed.stdout);
    if (existingUrl !== undefined)
        return { kind: 'existing', url: existingUrl, repo, branch };
    // 3. Never overwrite. An existing config is not a conflict: it is kept
    //    and left out of the PR, as plain `init` does.
    const hasConfig = CONFIG_NAMES.some((n) => existsSync(join(cwd, n)));
    const files = renderScaffold({ a0Host: undefined, includeConfig: !hasConfig });
    const conflicts = files.filter((f) => existsSync(join(cwd, f.path))).map((f) => f.path);
    if (conflicts.length > 0) {
        throw fail(`refusing to overwrite existing files:\n${conflicts.map((c) => `  ${c}`).join('\n')}`, 'move or delete them, or use `argus-reviewer init` to keep your versions');
    }
    // 4. Base branch.
    const base = await defaultBranch(git, gh, repo);
    // 5. Branch: reuse whatever already exists, otherwise create and push it.
    const remoteHas = (await git(['ls-remote', '--exit-code', '--heads', 'origin', branch], NET_MS)).code === 0;
    const localHas = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    if (!remoteHas && !localHas) {
        await commitInWorktree({ ...opts, files, base, git });
    }
    else if (!remoteHas) {
        const pushed = await git(['push', '-u', 'origin', branch], NET_MS);
        if (pushed.code !== 0)
            throw fail(`git push failed: ${firstLine(pushed.stderr)}`);
    }
    // 6. Open the PR.
    const bodyDir = await mkdtemp(join(tmpdir(), 'argus-initpr-body-'));
    try {
        const bodyFile = join(bodyDir, 'body.md');
        await writeFile(bodyFile, renderPrBody({ repo, budgetUsd: opts.budgetUsd, paths: files.map((f) => f.path) }), 'utf8');
        const created = await gh([
            'pr',
            'create',
            '--repo',
            repo,
            '--head',
            branch,
            '--base',
            base,
            '--title',
            'Add Argus reviewer (review-only, bring your own key)',
            '--body-file',
            bodyFile,
        ], NET_MS);
        const url = firstUrl(created.stdout, true);
        if (created.code !== 0 || url === undefined) {
            throw fail(`gh pr create failed: ${firstLine(created.stderr) || firstLine(created.stdout)}`);
        }
        return { kind: 'created', url, repo, branch };
    }
    finally {
        await rm(bodyDir, { recursive: true, force: true });
    }
}
async function defaultBranch(git, gh, repo) {
    const sym = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const fromRef = sym.code === 0 ? sym.stdout.trim().replace(/^origin\//, '') : '';
    if (fromRef !== '' && !validateBranch(fromRef))
        return fromRef;
    const view = await gh([
        'repo',
        'view',
        '--repo',
        repo,
        '--json',
        'defaultBranchRef',
        '--jq',
        '.defaultBranchRef.name',
    ]);
    const name = view.stdout.trim();
    if (view.code === 0 && name !== '' && !validateBranch(name))
        return name;
    throw fail(`could not determine the default branch of ${repo}`, 'git remote set-head origin --auto');
}
async function commitInWorktree(o) {
    const { git, files, base, branch } = o;
    const dir = await mkdtemp(join(tmpdir(), 'argus-initpr-wt-'));
    const wt = (args, ms = SHORT_MS) => o.exec('git', ['-C', dir, ...args], ms);
    try {
        const added = await git(['worktree', 'add', '--no-track', '-b', branch, dir, `origin/${base}`]);
        if (added.code !== 0) {
            throw fail(`could not create the onboarding branch from origin/${base}: ${firstLine(added.stderr)}`, 'git fetch origin');
        }
        for (const f of files) {
            const abs = join(dir, f.path);
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, f.content, 'utf8');
        }
        const staged = await wt(['add', '--', ...files.map((f) => f.path)]);
        if (staged.code !== 0)
            throw fail(`git add failed: ${firstLine(staged.stderr)}`);
        const committed = await wt([
            'commit',
            '-m',
            'chore: add Argus reviewer (review-only, BYOK)',
            '-m',
            'Generated by `argus-reviewer init --pr`.',
        ]);
        if (committed.code !== 0) {
            throw fail(`git commit failed: ${firstLine(committed.stderr) || firstLine(committed.stdout)}`);
        }
        const pushed = await wt(['push', '-u', 'origin', branch], NET_MS);
        if (pushed.code !== 0)
            throw fail(`git push failed: ${firstLine(pushed.stderr)}`);
    }
    finally {
        await git(['worktree', 'remove', '--force', dir]);
        await rm(dir, { recursive: true, force: true });
    }
}
function firstLine(s) {
    return s.trim().split('\n')[0] ?? '';
}
/** First https URL in gh output: a JSON `[{"url":...}]` list, or (last=true) a bare line. */
function firstUrl(stdout, last = false) {
    if (last) {
        const line = stdout.trim().split('\n').pop() ?? '';
        return /^https:\/\/github\.com\/\S+$/.test(line) ? line : undefined;
    }
    try {
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed)) {
            const u = parsed[0]?.url;
            return typeof u === 'string' && u.startsWith('https://') ? u : undefined;
        }
    }
    catch {
        // fall through
    }
    return undefined;
}
