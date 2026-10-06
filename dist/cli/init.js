import { DEFAULT_BUDGET_USD, resolveConfig } from '../config.js';
import { defaultExec, detectEnvironment } from '../detect.js';
import { DEFAULT_BRANCH as DEFAULT_PR_BRANCH, validateRepo, validateBranch, initPr } from '../onboarding/pr.js';
import { renderScaffold, scaffoldChecklist } from '../onboarding/scaffold.js';
import { usageError, reportError } from './shared.js';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
export const INIT_USAGE = `Usage: argus-reviewer init [options]


Scaffolds a working setup in the current directory:
  argus-reviewer.config.ts               config (target, budget, testsDir)
  tests/argus/smoke.test.ts              a td-API smoke test
  .github/workflows/argus-reviewer.yml   PR workflow using the action
  .github/workflows/argus-mention.yml    @argus PR-comment commands

Then reports which optional features your environment already supports
(OpenRouter key, Playwright browsers, gh auth, Agent Zero).

Options:
  --force   Overwrite files that already exist
  --pr      Open an onboarding pull request instead of writing files here
            (uses your git and gh; never reads or sends your OpenRouter key)
  --repo <owner/name>   With --pr: confirm the target (must match origin)
  --branch <name>       With --pr: branch to use (default argus/onboarding)
  -h, --help

--pr refuses to overwrite existing files and, if the branch or an open PR
already exists, reports it instead of creating another.`;
/** `argus-reviewer init --pr` — open an onboarding PR through local git + gh. */
export async function cmdInitPr(values, ctx, deps) {
    const branch = values.branch ?? DEFAULT_PR_BRANCH;
    const invalid = (values.force
        ? '--force cannot be combined with --pr (a PR never overwrites files)'
        : undefined) ??
        (values.repo !== undefined ? validateRepo(values.repo) : undefined) ??
        validateBranch(branch);
    if (invalid !== undefined) {
        usageError(ctx, 'init', invalid, 'argus-reviewer init --help');
        return 2;
    }
    try {
        const result = await initPr({
            cwd: ctx.cwd,
            exec: deps.exec ?? defaultExec,
            repo: values.repo,
            branch,
            budgetUsd: DEFAULT_BUDGET_USD,
        });
        ctx.out(result.kind === 'existing'
            ? `onboarding PR already open for ${result.repo} (${result.branch}): ${result.url}`
            : `opened onboarding PR for ${result.repo} (${result.branch}): ${result.url}`);
        ctx.out('Add OPENROUTER_API_KEY as a repository secret before merging; this command never reads it.');
        return 0;
    }
    catch (e) {
        reportError(ctx, e, 'init --pr', 'COMMAND_FAILED');
        return 1;
    }
}
/** `argus-reviewer init` — scaffold config, a smoke test, and the workflow. */
export async function cmdInit(args, ctx, deps) {
    const { values } = parseArgs({
        args,
        options: {
            force: { type: 'boolean', default: false },
            pr: { type: 'boolean', default: false },
            repo: { type: 'string' },
            branch: { type: 'string' },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help) {
        ctx.out(INIT_USAGE);
        return 0;
    }
    if (values.pr)
        return cmdInitPr(values, ctx, deps);
    if (values.repo !== undefined || values.branch !== undefined) {
        usageError(ctx, 'init', '--repo and --branch only apply with --pr', 'argus-reviewer init --pr');
        return 2;
    }
    // Detect first so the generated config can auto-enable what is present
    // (e.g. an Agent Zero instance → heal: 'a0').
    const env = await detectEnvironment(ctx.env, {
        ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
    });
    const configNames = [
        'argus-reviewer.config.ts',
        'argus-reviewer.config.json',
        'vision-e2e.config.ts',
        'vision-e2e.config.json',
    ];
    const hasConfig = configNames.some((n) => existsSync(join(ctx.cwd, n)));
    const files = renderScaffold({ a0Host: env.a0.host, includeConfig: !hasConfig || values.force });
    // DESIGN.md 7.8: a three-step checklist (files, environment, next
    // command) around the unchanged "What runs and what it costs" block.
    const { style } = ctx;
    const row = (status, text) => `  ${style.glyph(status)} ${text}`;
    const fixLine = (cmd) => `      ${style.role('accent', cmd)}`;
    ctx.out(style.bold('1. Write the setup files'));
    for (const { path: rel, content } of files) {
        const path = join(ctx.cwd, rel);
        if (existsSync(path) && !values.force) {
            ctx.out(row('skipped', `exists, skipping: ${rel}`));
            continue;
        }
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, content, 'utf8');
        ctx.out(row('passed', `wrote ${rel}`));
    }
    ctx.out('');
    ctx.out(style.bold('2. Check the argus-reviewer environment'));
    if (env.openrouterKey) {
        ctx.out(row('passed', 'openrouter key  OPENROUTER_API_KEY set'));
    }
    else {
        ctx.out(row('failed', 'openrouter key  not set (BYOK, required for model calls)'));
        ctx.out(fixLine('export OPENROUTER_API_KEY=sk-or-...'));
    }
    if (env.playwrightBrowsers.length > 0) {
        ctx.out(row('passed', `playwright      ${env.playwrightBrowsers.join(' ')}`));
    }
    else {
        ctx.out(row('unavailable', 'playwright      no browsers (flow and app lanes need one)'));
        ctx.out(fixLine('npx playwright install chromium'));
    }
    if (env.ghAuth === true) {
        ctx.out(row('passed', 'github          gh authenticated'));
    }
    else if (env.ghAuth === false) {
        ctx.out(row('unavailable', 'github          gh not authenticated (enables PR workflows)'));
        ctx.out(fixLine('gh auth login'));
    }
    else {
        ctx.out(row('unavailable', 'github          gh CLI not installed (PR workflows need it)'));
    }
    ctx.out(env.a0.version !== undefined || env.a0.host !== undefined
        ? row('passed', `agent zero      ${env.a0.version !== undefined ? `a0 ${env.a0.version}` : 'CLI not on PATH'}` +
            `${env.a0.host !== undefined ? ` → ${env.a0.host}` : ''}`) + `\n${style.dim('                    opt-in only; see config comments')}`
        : row('skipped', 'agent zero      not found (optional; enables `verify --a0` delegation)'));
    // Pulled from resolveConfig so the shortlist can't drift from defaults.
    const dm = resolveConfig({});
    ctx.out(`    models        vision ${dm.model} (docs/models.md)`);
    ctx.out(`                  code ${dm.code_model}`);
    ctx.out(`                  escalation ${dm.escalation_model}`);
    // R19: name what leaves the machine, the default spend posture, and
    // the stop path before the user runs anything. Kept verbatim (DESIGN 7.8).
    ctx.out('');
    for (const line of scaffoldChecklist(DEFAULT_BUDGET_USD))
        ctx.out(line);
    ctx.out('');
    ctx.out(style.bold('3. Run the default lane (code review)'));
    ctx.out(fixLine('argus-reviewer verify'));
    ctx.out(style.dim('    Then: point target.url at your app for the flow and app lanes,'));
    ctx.out(style.dim('    record a real flow with argus-reviewer record "...", and add'));
    ctx.out(style.dim('    OPENROUTER_API_KEY to the repo secrets to enable the PR workflow.'));
    if (env.a0.version !== undefined || env.a0.host !== undefined) {
        ctx.out(style.dim('    verify --a0 and heal: a0 are opt-in; suggestions are in the config.'));
    }
    return 0;
}
