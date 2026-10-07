import { isTrustedAssociation, fetchPrMeta, ghGet } from '../evidence/ci.js'
import { applyFixes } from '../github/apply-fixes.js'
import { parseMention, postIssueComment, MENTION_HELP, mayRunMention } from '../mention.js'
import { type GenerateLaneResult } from '../probe/generate.js'
import { decodeProbePayload, persistProbes } from '../probe/persist.js'
import { SENTINEL } from '../report/comment.js'
import { cmdCodeReview } from './code-review.js'
import { cmdRecord } from './record.js'
import { fetchPrFiles } from './review-shared.js'
import { type Ctx, type CliDeps, usageError } from './shared.js'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'


const MENTION_USAGE = `Usage: argus-reviewer mention [--report-dir <dir>]


Dispatch an @argus command from a GitHub issue_comment event. Reads
GITHUB_EVENT_PATH for the comment body, commenter association, and issue
number; runs nothing unless the comment is on a pull request and starts
with @argus. Never checks out the PR head: review runs API-diff-only
against the base checkout.

Commands: @argus review [full] · @argus record "<flow>" · @argus persist · @argus generate · @argus fix · @argus help`

interface IssueCommentPayload {
  issue?: { number?: number; pull_request?: unknown }
  comment?: { body?: string; author_association?: string }
}


/**
 * `argus-reviewer mention` — the E3.U5 dispatch lane. Everything upstream
 * of the command handler is a gate: untrusted commenters are ignored
 * silently (no reply channel for drive-by spam), fork-head PRs need the
 * per-head probe label for execution commands, and record/persist never
 * run on forks at all.
 */
export async function cmdMention(args: string[], ctx: Ctx, deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      'report-dir': { type: 'string' },
    },
  })
  if (values.help) {
    ctx.out(MENTION_USAGE)
    return 0
  }
  const reportDir = resolve(ctx.cwd, values['report-dir'] ?? 'argus-reviewer-report')

  const eventName = ctx.env.GITHUB_EVENT_NAME
  if (eventName !== undefined && eventName !== '' && eventName !== 'issue_comment') {
    usageError(
      ctx,
      'mention',
      `mention: GITHUB_EVENT_NAME is "${eventName}", expected issue_comment`,
    )
    return 2
  }
  const eventPath = ctx.env.GITHUB_EVENT_PATH
  if (eventPath === undefined || eventPath === '') {
    usageError(
      ctx,
      'mention',
      'mention: GITHUB_EVENT_PATH not set; this command runs on issue_comment events',
    )
    return 2
  }
  let payload: IssueCommentPayload
  try {
    payload = JSON.parse(await readFile(eventPath, 'utf8')) as IssueCommentPayload
  } catch (e) {
    usageError(ctx, 'mention', `mention: could not read event payload: ${(e as Error).message}`)
    return 2
  }
  const issue = payload.issue
  const comment = payload.comment
  if (issue?.pull_request === undefined || typeof issue.number !== 'number') {
    ctx.out('mention: comment is not on a pull request; ignoring')
    return 0
  }
  const parsed = parseMention(typeof comment?.body === 'string' ? comment.body : '')
  if (parsed === undefined) {
    ctx.out('mention: no @argus command; ignoring')
    return 0
  }

  const repo = ctx.env.GITHUB_REPOSITORY
  const token = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN
  const issueNum = String(issue.number)
  const reply = async (text: string): Promise<void> => {
    if (repo === undefined || token === undefined) {
      ctx.err(`mention: reply suppressed (no repo/token): ${text}`)
      return
    }
    await postIssueComment(repo, issueNum, `**argus:** ${text}`, token, ctx)
  }

  // Silent ignore: a reply would hand untrusted commenters a spam channel.
  if (!isTrustedAssociation(comment?.author_association)) {
    ctx.err(
      `mention: ignored, commenter association "${comment?.author_association ?? 'unknown'}" is not trusted`,
    )
    return 0
  }
  if (parsed === 'unknown' || parsed.name === 'help') {
    await reply(MENTION_HELP)
    return 0
  }

  const meta =
    repo !== undefined && token !== undefined
      ? await fetchPrMeta(repo, issueNum, token, ctx)
      : undefined
  const gate = mayRunMention(parsed, comment?.author_association, meta)
  if (!gate.allowed) {
    ctx.err(`mention: ${parsed.name} denied`)
    if (gate.reply !== undefined) await reply(gate.reply)
    return 0
  }

  if (parsed.name === 'persist') {
    // E1.U3 — decode the reproduced-probe payload embedded in the Argus
    // sticky comment, then commit it to a regression-test branch + PR via
    // the contents API. Runs on the base checkout — nothing executes.
    if (repo === undefined || token === undefined) {
      ctx.err('mention: persist needs GITHUB_REPOSITORY + GITHUB_TOKEN')
      return 2
    }
    if (meta?.baseRef === undefined) {
      await reply("I couldn't resolve this PR's base branch, so persist is unavailable right now.")
      return 0
    }
    const comments = (await ghGet(
      `https://api.github.com/repos/${repo}/issues/${issueNum}/comments?per_page=100`,
      token,
      ctx,
    )) as { body?: string }[] | undefined
    const sticky = comments?.find((c) => typeof c.body === 'string' && c.body.includes(SENTINEL))
    const decoded = sticky?.body === undefined ? undefined : decodeProbePayload(sticky.body)
    if (decoded === undefined) {
      await reply('no reproduced probes to persist: only a reproduced probe carries the payload.')
      return 0
    }
    // Stale-head guard: probes were authored against a specific head — a
    // moved head can mean the finding (and probe) no longer applies.
    if (decoded.head !== undefined && meta.headSha !== undefined && decoded.head !== meta.headSha) {
      await reply(
        `the persisted probes were authored against head \`${decoded.head.slice(0, 8)}\`, ` +
          `but the PR is now at \`${meta.headSha.slice(0, 8)}\`. Run \`@argus review\` first.`,
      )
      return 0
    }
    const result = await persistProbes(repo, issueNum, meta.baseRef, decoded.probes, token, ctx)
    if (result.error !== undefined) {
      await reply(
        `persist failed: ${result.error}. The probe source is still in the sticky comment.`,
      )
      return 1
    }
    const wrote = result.written.map((p) => `\`${p}\``).join(', ')
    const dup = result.skipped.length > 0 ? ` (${result.skipped.length} already present)` : ''
    await reply(`persisted ${wrote}. Regression-test PR: ${result.prUrl}${dup}`)
    return 0
  }
  if (parsed.name === 'record') {
    if (parsed.arg === undefined) {
      await reply('`record` needs a flow description — e.g. `@argus record "sign in with Google"`')
      return 0
    }
    ctx.out(`mention: recording flow "${parsed.arg}"`)
    // `--` keeps a commenter-controlled description starting with `-` from
    // being parsed as record flags (e.g. a smuggled `--url` retarget).
    const code = await cmdRecord(['--', parsed.arg], ctx, deps)
    const runId = ctx.env.GITHUB_RUN_ID
    const runLink =
      repo !== undefined && runId !== undefined && runId !== ''
        ? ` [workflow artifacts](https://github.com/${repo}/actions/runs/${runId})`
        : ''
    await reply(
      code === 0
        ? `recorded \`${parsed.arg}\` — the generated test and flow cache are in the run's artifacts.${runLink}`
        : `record failed for \`${parsed.arg}\` — see the workflow log.${runLink}`,
    )
    return code
  }

  if (parsed.name === 'generate') {
    // U2 — runs the review path with --generate-tests: the mention lane is
    // a base checkout, so sandbox validation is impossible here and every
    // authored spec lands as an unvalidated draft on the write PR. Forks
    // are refused upstream by mayRunMention.
    ctx.out(`mention: generating spec coverage for PR #${issueNum}`)
    await reply('generating spec coverage - the specs land on a reviewable PR linked below.')
    const code = await cmdCodeReview(['--report-dir', reportDir, '--generate-tests'], ctx, deps)
    const report = await readFile(join(reportDir, 'code-review.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as { generated?: GenerateLaneResult })
      .catch(() => undefined)
    const gen = report?.generated
    if (gen === undefined) {
      await reply('the generate lane did not run - check the workflow log for the reason.')
    } else if (gen.skipReason !== undefined) {
      await reply(`generation skipped: ${gen.skipReason}`)
    } else {
      const committed = gen.records.filter((r) => r.status === 'committed').length
      const drafts = gen.records.length - committed
      await reply(
        gen.prUrl !== undefined
          ? `generated ${committed} spec(s)${drafts > 0 ? ` (${drafts} held back as drafts)` : ''} - ` +
              `reviewable PR: ${gen.prUrl}`
          : `${committed} spec(s) authored but no PR opened - ` +
              (gen.records[0]?.detail ?? 'see code-review.json for details'),
      )
    }
    return code
  }

  if (parsed.name === 'fix') {
    // U5 — apply posted inline suggestions to a branch off the exact head
    // SHA and open one PR back onto the PR's head branch. Anchors are
    // re-validated against the live diff; the head is re-verified before
    // the PR opens. Forks are refused upstream by mayRunMention.
    if (repo === undefined || token === undefined) {
      ctx.err('mention: fix needs GITHUB_REPOSITORY + GITHUB_TOKEN')
      return 2
    }
    if (meta === undefined || meta.headSha === undefined || meta.headRef === undefined) {
      await reply("I couldn't resolve this PR's head - fix is unavailable right now.")
      return 0
    }
    const files = await fetchPrFiles(repo, issueNum, token, ctx)
    if (files === undefined) {
      await reply("I couldn't list this PR's files - fix is unavailable right now.")
      return 0
    }
    const result = await applyFixes(
      { repo, pr: issueNum, meta, files, actor: ctx.env.GITHUB_ACTOR },
      token,
      ctx,
    )
    if (result.stale === true) {
      await reply(
        'the PR head moved while I was applying suggestions - re-run `@argus fix` to retry.',
      )
      return 0
    }
    if (result.error !== undefined && result.applied.length === 0) {
      await reply(result.error)
      return 1
    }
    const named = result.skipped
      .slice(0, 5)
      .map((s) => `\`${s.path ?? '?'}\`${s.line !== undefined ? ` L${s.line}` : ''} (${s.reason})`)
      .join(', ')
    const skippedNote =
      result.skipped.length === 0
        ? ''
        : ` Skipped ${result.skipped.length}: ${named}${result.skipped.length > 5 ? ', …' : ''}.`
    if (result.applied.length === 0) {
      await reply(`no suggestions could be applied.${skippedNote}`)
      return 0
    }
    if (result.error !== undefined) {
      await reply(
        `applied ${result.applied.length} suggestion(s) but the PR did not open: ${result.error}.${skippedNote}`,
      )
      return 1
    }
    await reply(
      result.prUrl !== undefined
        ? `opened ${result.prUrl} - applied ${result.applied.length} suggestion(s).${skippedNote}`
        : `applied ${result.applied.length} suggestion(s) but no PR URL came back.${skippedNote}`,
    )
    return 0
  }

  // review — `full` is the U4 manual escape: it bypasses the incremental
  // baseline and re-diffs the whole PR.
  if (parsed.arg !== undefined && parsed.arg !== 'full') {
    await reply('unknown argument - try `@argus review` or `@argus review full`.')
    return 0
  }
  ctx.out(`mention: running review on PR #${issueNum}`)
  await reply('running review — results land in the Argus comment below.')
  return cmdCodeReview(
    ['--report-dir', reportDir, ...(parsed.arg === 'full' ? ['--full'] : [])],
    ctx,
    deps,
  )
}
