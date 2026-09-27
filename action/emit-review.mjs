// CLI entrypoint for the approval-review lane.
//
// Reads the harness's own code-review.json, maps its verdict to a GitHub
// review event, and submits the review with the approval-capable token. Runs
// as its own composite step because actions/github-script's Octokit is pinned
// to `github.token`, which GitHub refuses to approve with.

import { readFileSync } from 'node:fs'

import {
  classifyApprovalFailure,
  classifyEvidenceFailure,
  listCheckRuns,
  prNumberFromEvent,
  readCodeReview,
  reviewBody,
  reviewEventFor,
  submitApprovalReview,
  verifyEvidenceCheck,
} from './approval-review.mjs'
import { setActionOutput } from './runtime.mjs'

function warn(message) {
  process.stdout.write(`::warning::${message}\n`)
}

function fail(message) {
  process.stdout.write(`::error::${message}\n`)
}

function readEventPayload(path) {
  if (!path) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function statusFromMessage(message) {
  const m = /HTTP (\d{3})/.exec(String(message))
  return m ? Number(m[1]) : undefined
}

function detailFrom(err) {
  const raw = String(err?.stderr ?? err?.message ?? '')
  return (
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('{'))
      .slice(-1)[0] ?? 'no detail'
  )
}

/**
 * Resolve everything the lane needs from the step environment.
 * Exported so the wiring is testable without a runner.
 */
export function resolveLane(env) {
  const token = (env.ARGUS_APPROVAL_TOKEN ?? '').trim()
  const repo = (env.GITHUB_REPOSITORY ?? '').trim()
  const reportDir = (env.ARGUS_REPORT_DIR ?? 'argus-reviewer-report').trim()
  const workDir = (env.VISION_E2E_WORKING_DIR ?? '').trim()
  const pr = Number(env.ARGUS_PR_NUMBER ?? '') || prNumberFromEvent(env.GITHUB_EVENT_NAME, env.__event)
  return {
    token,
    evidence: (env.ARGUS_APPROVAL_EVIDENCE ?? '').trim(),
    check: (env.ARGUS_APPROVAL_CHECK ?? '').trim(),
    repo,
    pr,
    reportDir: workDir === '' ? reportDir : `${workDir}/${reportDir}`,
    headSha: (env.ARGUS_HEAD_SHA ?? '').trim() || undefined,
    runUrl: env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined,
  }
}

/**
 * Run the lane and report what happened. Returns rather than setting
 * `process.exitCode` so the outcome is assertable in tests; the entrypoint
 * below is what turns a non-ok result into a failed step.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ submit?: typeof submitApprovalReview, read?: typeof readCodeReview, list?: typeof listCheckRuns }} [deps]
 * @returns {Promise<{ ok: boolean, reviewEvent: string, reviewState: string, message: string }>}
 */
export async function emitApprovalReview(env, deps = {}) {
  const submit = deps.submit ?? submitApprovalReview
  const read = deps.read ?? readCodeReview
  const list = deps.list ?? listCheckRuns
  const log = (line) => process.stdout.write(`${line}\n`)
  const { token, evidence, check, repo, pr, reportDir, headSha, runUrl } = resolveLane(env)

  if (token === '') {
    // Not an error. The sticky comment is Argus's default behaviour; approving
    // is opt-in and needs a credential this step was not handed.
    const message = 'argus-reviewer: no approval-token supplied — comment only, no formal review.'
    log(message)
    setActionOutput('review-event', 'none')
    setActionOutput('review-state', 'not-submitted')
    return { ok: true, reviewEvent: 'none', reviewState: 'not-submitted', message }
  }

  if (evidence === '') {
    // Enforced, not advisory. An approval on a protected branch that cites no
    // command is a rubber stamp with extra steps: nobody can re-run what the
    // approval is standing on. Refuse rather than emit an uncited APPROVE.
    const message =
      'argus-reviewer: approval-token was supplied without approval-evidence. An approval must ' +
      'cite the test command it stands on. Set approval-evidence to the command(s) that verify ' +
      'this pull request, or drop approval-token to stay on the comment lane.'
    fail(message)
    return { ok: false, reviewEvent: 'none', reviewState: 'no-evidence', message }
  }

  if (repo === '') {
    const message = 'argus-reviewer: GITHUB_REPOSITORY is empty; cannot submit a review.'
    fail(message)
    return { ok: false, reviewEvent: 'none', reviewState: 'no-repo', message }
  }

  if (!pr) {
    // workflow_dispatch and push carry no pull request. Not a failure.
    const message = 'argus-reviewer: no pull request in this event — skipping the review lane.'
    log(message)
    setActionOutput('review-event', 'none')
    setActionOutput('review-state', 'no-pull-request')
    return { ok: true, reviewEvent: 'none', reviewState: 'no-pull-request', message }
  }

  let codeReview
  try {
    codeReview = await read(reportDir)
  } catch (err) {
    // The code-review step failed or never ran. Fail closed and loudly: a
    // missing report must never become an approval, and must never be silent.
    const message =
      `argus-reviewer: cannot read ${reportDir}/code-review.json — ${err?.message ?? err}. ` +
      'No review was submitted.'
    fail(message)
    setActionOutput('review-event', 'none')
    setActionOutput('review-state', 'no-report')
    return { ok: false, reviewEvent: 'none', reviewState: 'no-report', message }
  }

  const event = reviewEventFor(codeReview.verdict)

  // APPROVE is the only event that satisfies a protected branch, so it is the
  // only one that has to be backed by a check which actually ran. A negative
  // review is exempt on purpose: red CI is exactly when a REQUEST_CHANGES
  // should still go out.
  let evidenceCheck
  if (event === 'APPROVE') {
    // Two ways to have no evidence, both cheap to detect without an API call:
    // nobody named a check, or the head commit is unknown so the check cannot
    // be bound to anything. Binding to a branch tip instead is the hole this
    // exists to close, so an unknown SHA is a refusal rather than a guess.
    if (check === '' || headSha === undefined) {
      const message = `argus-reviewer: ${classifyEvidenceFailure(check, { ok: false, reason: 'no-check-named' })}`
      fail(message)
      setActionOutput('review-event', 'none')
      setActionOutput('review-state', 'unverified-evidence')
      return { ok: false, reviewEvent: 'none', reviewState: 'unverified-evidence', message }
    }
    let verdictOnCheck
    try {
      verdictOnCheck = verifyEvidenceCheck(await list({ repo, ref: headSha, token }), check)
    } catch (err) {
      const message =
        `argus-reviewer: could not read check runs for ${headSha} — ${err?.message ?? err}. ` +
        'No review was submitted.'
      fail(message)
      setActionOutput('review-event', 'none')
      setActionOutput('review-state', 'no-check-runs')
      return { ok: false, reviewEvent: 'none', reviewState: 'no-check-runs', message }
    }
    if (!verdictOnCheck.ok) {
      const message = `argus-reviewer: ${classifyEvidenceFailure(check, verdictOnCheck)}`
      fail(message)
      setActionOutput('review-event', 'none')
      setActionOutput('review-state', 'unverified-evidence')
      return { ok: false, reviewEvent: 'none', reviewState: 'unverified-evidence', message }
    }
    evidenceCheck = verdictOnCheck.check
  }

  try {
    const { stdout } = await submit({
      repo,
      pr,
      token,
      event,
      body: reviewBody(codeReview, runUrl, evidence, evidenceCheck),
      commitId: headSha,
    })
    const review = JSON.parse(stdout)
    const message =
      `argus-reviewer: submitted ${event} on #${pr} as ${review.user?.login ?? 'unknown'} ` +
      `(review ${review.id}, state ${review.state}).`
    log(message)
    setActionOutput('review-event', event)
    setActionOutput('review-state', review.state ?? 'unknown')
    return { ok: true, reviewEvent: event, reviewState: review.state ?? 'unknown', message }
  } catch (err) {
    const status = err?.status ?? statusFromMessage(err?.message ?? '')
    const remedy = classifyApprovalFailure(status, `${err?.message ?? ''} ${err?.stderr ?? ''}`)
    const message =
      `argus-reviewer: could not submit the ${event} review on #${pr}. ` +
      (remedy ?? `GitHub returned ${status ?? 'an error'}: ${detailFrom(err)}`)
    fail(message)
    setActionOutput('review-event', event)
    setActionOutput('review-state', 'failed')
    return { ok: false, reviewEvent: event, reviewState: 'failed', message }
  }
}

if (process.argv[1] && process.argv[1].endsWith('emit-review.mjs')) {
  const event = readEventPayload(process.env.GITHUB_EVENT_PATH)
  const result = await emitApprovalReview({ ...process.env, __event: event })
  if (!result.ok) process.exitCode = 1
}
