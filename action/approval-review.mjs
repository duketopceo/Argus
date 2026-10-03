// Formal pull request review submission.
//
// The sticky comment is a PR *comment*; it is not a review object. Branch
// protection with `require_approving_reviews` reads reviews only, so an
// Argus verdict alone never satisfies that gate. This module submits a real
// review via POST /repos/{owner}/{repo}/pulls/{n}/reviews.
//
// The token used here must be approval-capable. GitHub refuses approvals from
// two sources, and both refusals are permanent rather than a missing scope:
//
//   GITHUB_TOKEN (github-actions[bot])
//     422 "GitHub Actions is not permitted to approve pull requests."
//   a PAT belonging to the PR author
//     422 "Review Can not approve your own pull request"
//
// So the token has to be a GitHub App installation token, or a PAT from an
// account that is not the author. See docs/approval-token.md.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The Ocellus verdict vocabulary has one action-side copy (KTD2), in the
// sticky-comment module; this lane reuses it rather than keeping a third.
import sticky from './sticky-comment.cjs'

const { STATUS_GLYPH, VERDICT_STATUS, VERDICT_LABEL } = sticky

const GH_API = 'https://api.github.com'

/** Verdicts that mean "ship it". Everything else blocks. */
const APPROVING = new Set(['pass', 'approve'])

/**
 * Map a code-review verdict onto a GitHub review event.
 *
 * `skipped` resolves to COMMENT, not APPROVE: a run that did not review the
 * diff must never manufacture an approval.
 */
export function reviewEventFor(verdict) {
  const v = String(verdict ?? '').trim().toLowerCase()
  if (v === 'skipped') return 'COMMENT'
  return APPROVING.has(v) ? 'APPROVE' : 'REQUEST_CHANGES'
}

/**
 * Turn a failed review submission into an actionable message.
 *
 * Both known refusals are GitHub policy, so the remedy is a different
 * identity, never a widened scope. Returns undefined for unknown failures.
 */
export function classifyApprovalFailure(status, message) {
  const text = String(message ?? '')
  if (text.includes('GitHub Actions is not permitted to approve')) {
    return (
      'GITHUB_TOKEN cannot approve. Supply the approval-token input with a GitHub App ' +
      'installation token or a PAT from an account that is not the PR author. ' +
      'See docs/approval-token.md.'
    )
  }
  if (text.includes('Can not approve your own pull request')) {
    return (
      'The approval token belongs to the PR author, and GitHub blocks self-approval. ' +
      'Use an identity that did not open the pull request.'
    )
  }
  if (status === 403) {
    return 'The approval token lacks pull-request write access. Mint an installation token with pull-requests: write.'
  }
  if (status === 404) {
    return 'The approval token cannot see this repository, or the pull request number is wrong.'
  }
  return undefined
}

/**
 * Build the review body: the verdict, the test command the approval is standing
 * on, then the finding count.
 *
 * Deliberately short. The full report, the flow results, and the cost ledger
 * already live in the sticky comment; a formal review is a gate signal, not a
 * second copy of the evidence. The one thing it must not omit is the command,
 * because an approval nobody can re-run is a signature, not a review.
 *
 * @param {{ verdict?: string, summary?: string, findings?: unknown[] }} codeReview
 * @param {string} [runUrl]
 * @param {string} [evidence] test command(s) the approval stands on
 * @param {{ name?: string, conclusion?: string, html_url?: string }} [evidenceCheck]
 *   the check run the caller verified before this approval was allowed
 */
export function reviewBody(codeReview, runUrl, evidence, evidenceCheck) {
  const lines = []
  const verdict = String(codeReview?.verdict ?? 'unknown')
  lines.push(
    Object.hasOwn(VERDICT_LABEL, verdict)
      ? `**Argus: ${STATUS_GLYPH[VERDICT_STATUS[verdict]]} ${VERDICT_LABEL[verdict]}**`
      : `**Argus:** verdict \`${oneLine(verdict).replace(/`/g, '')}\``,
  )
  if (codeReview?.summary) lines.push('', codeReview.summary)
  if (evidence !== undefined && evidence !== '') {
    lines.push('', `**Verified by:** \`${oneLine(evidence)}\``)
  } else {
    lines.push('', '**Verified by:** none. This approval cites no test command.')
  }
  if (evidenceCheck) {
    // The command above is the caller's claim; this line is the receipt. A
    // reviewer can open the run and see the result rather than trust a string.
    const cited = evidenceCheck.html_url
      ? `[\`${oneLine(evidenceCheck.name)}\` → ${evidenceCheck.html_url}](${evidenceCheck.html_url})`
      : `\`${oneLine(evidenceCheck.name)}\``
    lines.push(
      '',
      `**Green on this commit:** ${cited} reported \`${evidenceCheck.conclusion ?? 'unknown'}\`.`,
    )
  }
  const findings = codeReview?.findings
  if (Array.isArray(findings) && findings.length > 0) {
    const blocking = findings.filter((f) => isBlockingSeverity(f?.severity))
    lines.push(
      '',
      `${findings.length} finding(s), ${blocking.length} blocking. ` +
        'Full evidence and the cost ledger are in the argus-reviewer comment.',
    )
    for (const f of blocking.slice(0, 5)) {
      const where = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''
      lines.push(`- **${f.severity}**${where}: ${oneLine(f.message)}`)
    }
  }
  if (runUrl) lines.push('', `[argus-reviewer run](${runUrl})`)
  lines.push(
    '',
    '<sub>Argus is the reviewer of record. Findings come from `code-review.json` ' +
      'in the run workspace; this review is generated, not hand-written.</sub>',
  )
  return lines.join('\n')
}

const BLOCKING_SEVERITIES = new Set(['critical', 'high', 'blocker', 'major'])

function isBlockingSeverity(severity) {
  return BLOCKING_SEVERITIES.has(String(severity ?? '').trim().toLowerCase())
}

function oneLine(s) {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

/** POST the review. Resolves with the parsed review, throws on API failure. */
export async function submitApprovalReview({ repo, pr, token, event, body, commitId }) {
  const args = [
    'api',
    '--method',
    'POST',
    `${GH_API}/repos/${repo}/pulls/${pr}/reviews`,
    '-f',
    `event=${event}`,
    '-f',
    `body=${body}`,
  ]
  if (commitId) args.push('-f', `commit_id=${commitId}`)
  const { stdout, stderr } = await execFileAsync('gh', args, {
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 8 * 1024 * 1024,
  })
  return { stdout, stderr }
}

function execFileAsync(file, args, options) {
  return new Promise((res, rej) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        rej(error)
        return
      }
      res({ stdout, stderr })
    })
  })
}

/**
 * List the check runs recorded against a commit.
 *
 * `ref` is the head SHA, not the branch tip: an approval has to describe the
 * code it was actually run against, so it is bound to the same SHA the review
 * is submitted with.
 */
export async function listCheckRuns({ repo, ref, token }) {
  const args = [
    'api',
    '--method',
    'GET',
    `${GH_API}/repos/${repo}/commits/${ref}/check-runs?per_page=100`,
  ]
  const { stdout, stderr } = await execFileAsync('gh', args, {
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 8 * 1024 * 1024,
  })
  const parsed = JSON.parse(stdout)
  return Array.isArray(parsed?.check_runs) ? parsed.check_runs : []
}

function isGreenCheck(check) {
  return (
    String(check?.status ?? '').toLowerCase() === 'completed' &&
    String(check?.conclusion ?? '').toLowerCase() === 'success'
  )
}

function norm(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
}

/**
 * Decide whether a named check run can carry an approval.
 *
 * A cited test command is a claim. This is the part that makes it evidence:
 * the named check must exist on the head commit and have finished green. It
 * returns the check on success so the review body can cite the real run rather
 * than repeat the caller's string back at them.
 *
 * Two properties matter as much as the name match:
 *
 * - **The producer is pinned.** A check *name* is not a producer. A fork can
 *   add a workflow that reports a green run called `test`, so a gate that
 *   accepts any green `test` is satisfied by whoever was under review. `appSlug`
 *   restricts the match to one App, and an empty value means "any producer",
 *   which the action never passes by default.
 * - **Every match must be green.** One green run does not speak for a failing
 *   one with the same name, and picking the greenest match is exactly how a
 *   red build gets waved through.
 *
 * @param {Array<{name?: string, status?: string, conclusion?: string, app?: {slug?: string}}>} checkRuns
 * @param {string} name
 * @param {string} [appSlug] required producer; empty matches any
 * @returns {{ ok: boolean, reason?: string, check?: object }}
 */
export function verifyEvidenceCheck(checkRuns, name, appSlug) {
  const wanted = norm(name)
  if (wanted === '') return { ok: false, reason: 'no-check-named' }
  // '' and '*' both mean "any producer". The action and the lane never pass
  // either by default; reaching this needs an explicit opt-out.
  const producer = norm(appSlug)
  const anyProducer = producer === '' || producer === '*'
  const all = Array.isArray(checkRuns) ? checkRuns : []
  const byName = all.filter((r) => norm(r?.name) === wanted)
  if (byName.length === 0) return { ok: false, reason: 'no-check-named' }
  const matches = anyProducer ? byName : byName.filter((r) => norm(r?.app?.slug) === producer)
  if (matches.length === 0) return { ok: false, reason: 'wrong-producer' }
  if (matches.every(isGreenCheck)) return { ok: true, check: matches[0] }
  // Report a still-running state ahead of a failed one: "pending" is transient,
  // "failed" is the outcome somebody has to act on.
  const running = matches.find((r) => norm(r?.status) !== 'completed')
  const red = matches.find((r) => !isGreenCheck(r))
  return { ok: false, reason: running ? 'not-completed' : 'not-successful', check: running ?? red }
}

/**
 * Explain a refused approval in terms of the check, not the token. Returns the
 * whole sentence so the caller cannot accidentally emit a vaguer one.
 */
export function classifyEvidenceFailure(name, verdict, appSlug) {
  const label = `\`${name}\``
  const seen = verdict?.check
  const suffix = seen?.html_url ? ` (${seen.html_url})` : ''
  if (verdict?.reason === 'wrong-producer') {
    const from = appSlug ? `\`${appSlug}\`` : 'the expected App'
    return (
      `A check run named ${label} exists on the head commit${suffix}, but it did not come from ` +
      `${from}. Argus only accepts that producer's result, because a check name is not a producer. ` +
      'Set approval-check-app to the App slug that runs this check.'
    )
  }
  if (verdict?.reason === 'not-completed') {
    return (
      `${label} has not finished on the head commit${suffix}, so there is no evidence the cited ` +
      'tests ran. Refusing to approve.'
    )
  }
  if (verdict?.reason === 'not-successful') {
    return (
      `${label} reported \`${seen?.conclusion ?? 'no conclusion'}\` on the head commit${suffix}. ` +
      'Refusing to approve a commit whose named check is not green.'
    )
  }
  return (
    `No check run named ${label} is recorded on the head commit, so the test command this ` +
    'approval cites cannot be shown to have run. Set approval-check to a required check on this ' +
    'repository, or drop approval-token to stay on the comment lane.'
  )
}

// Stale approval.
//
// `dismiss_stale_reviews` is false on the protected branch, so an APPROVE
// survives every later push to the same pull request. That is not theoretical:
// on duketopceo/orchestral, 5 of 9 cursor approvals were issued at one head SHA
// and the pull request then merged at a different one — up to 8 commits landed
// after the approval. A reviewer cannot revoke their own stale approval unless
// something does it for them, so this lane does.
//
// The two operations below close different windows and neither closes all of
// it. The gap between a push and this lane starting is closed only by enabling
// `dismiss_stale_reviews`, which is a branch-protection setting and not ours
// to change.

/** Read the current head SHA of a pull request. */
export async function readPullRequestHead({ repo, pr, token }) {
  const args = ['api', '--method', 'GET', `${GH_API}/repos/${repo}/pulls/${pr}`]
  const { stdout, stderr } = await execFileAsync('gh', args, {
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 8 * 1024 * 1024,
  })
  return String(JSON.parse(stdout)?.head?.sha ?? '')
}

/** List the reviews already on a pull request. */
export async function listReviews({ repo, pr, token }) {
  const args = [
    'api',
    '--method',
    'GET',
    `${GH_API}/repos/${repo}/pulls/${pr}/reviews?per_page=100`,
  ]
  const { stdout, stderr } = await execFileAsync('gh', args, {
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 8 * 1024 * 1028,
  })
  const parsed = JSON.parse(stdout)
  return Array.isArray(parsed) ? parsed : []
}

/** Dismiss one review, so it stops counting toward the gate. */
export async function dismissReview({ repo, pr, reviewId, token, message }) {
  const args = [
    'api',
    '--method',
    'PUT',
    `${GH_API}/repos/${repo}/pulls/${pr}/reviews/${reviewId}/dismissals`,
    '-f',
    `message=${message}`,
  ]
  const { stdout, stderr } = await execFileAsync('gh', args, {
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/**
 * Prior approvals by this same identity that no longer describe the head.
 *
 * Scoped to `login` on purpose. An approver revoking *its own* outgrown
 * approval is self-correction; an approver revoking a colleague's is not
 * something a bot should do, so anyone else's review is left alone.
 *
 * @param {Array<{state?: string, commit_id?: string, user?: {login?: string}, id?: number}>} reviews
 * @param {{ login?: string, headSha?: string }} opts
 */
export function staleApprovals(reviews, { login, headSha }) {
  const want = String(login ?? '')
    .trim()
    .toLowerCase()
  if (want === '') return []
  const head = String(headSha ?? '')
  return (Array.isArray(reviews) ? reviews : []).filter(
    (r) =>
      String(r?.state ?? '').toUpperCase() === 'APPROVED' &&
      String(r?.user?.login ?? '')
        .trim()
        .toLowerCase() === want &&
      String(r?.commit_id ?? '') !== head,
  )
}

/** Read the code-review report the harness already wrote. */
export async function readCodeReview(reportDir) {  const raw = await readFile(join(reportDir, 'code-review.json'), 'utf8')
  return JSON.parse(raw)
}

/**
 * Resolve the pull request number from the event payload.
 *
 * `pull_request` events put it at `.pull_request.number`; `pull_request_target`
 * puts it at `.number`; `issue_comment` events carry it at `.issue.number`.
 * Precedence matters — a `pull_request` payload also has a top-level `number`,
 * and for a PR-triggered event they agree, but relying on that is fragile.
 */
export function prNumberFromEvent(eventName, payload) {
  const candidates = []
  if (eventName === 'issue_comment') candidates.push(payload?.issue?.number)
  candidates.push(payload?.pull_request?.number, payload?.number)
  for (const c of candidates) {
    const n = Number(c)
    if (Number.isInteger(n) && n > 0) return n
  }
  return undefined
}
