import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error plain-node action helper — no type declarations
import {
  classifyApprovalFailure,
  classifyEvidenceFailure,
  prNumberFromEvent,
  reviewBody,
  reviewEventFor,
  staleApprovals,
  verifyEvidenceCheck,
} from '../../action/approval-review.mjs'

// @ts-expect-error plain-node action helper — no type declarations
import { emitApprovalReview, resolveLane } from '../../action/emit-review.mjs'

/** The two refusals measured on duketopceo/orchestral, verbatim from the API. */
const GITHUB_TOKEN_422 =
  'gh: Unprocessable Entity (HTTP 422)\n{"message":"Unprocessable Entity","errors":["GitHub Actions is not permitted to approve pull requests."]}'
const SELF_APPROVAL_422 =
  '{"message":"Unprocessable Entity","errors":["Review Can not approve your own pull request"]}'

describe('review event mapping', () => {
  it('approves only on a passing verdict', () => {
    expect(reviewEventFor('pass')).toBe('APPROVE')
    expect(reviewEventFor('approve')).toBe('APPROVE')
  })

  it('requests changes on anything that is not a pass', () => {
    expect(reviewEventFor('needs_changes')).toBe('REQUEST_CHANGES')
    expect(reviewEventFor('fail')).toBe('REQUEST_CHANGES')
  })

  it('never approves on a skipped run', () => {
    // A run that did not read the diff must not manufacture an approval.
    expect(reviewEventFor('skipped')).toBe('COMMENT')
    expect(reviewEventFor(undefined)).toBe('REQUEST_CHANGES')
  })
})

describe('approval failure classification', () => {
  it('names the identity problem when the Actions token is refused', () => {
    const remedy = classifyApprovalFailure(422, GITHUB_TOKEN_422)
    expect(remedy).toMatch(/GITHUB_TOKEN cannot approve/)
    expect(remedy).toMatch(/installation token/)
  })

  it('names self-approval when the token belongs to the author', () => {
    expect(classifyApprovalFailure(422, SELF_APPROVAL_422)).toMatch(/did not open the pull request/)
  })

  it('maps 403 and 404 to credential problems, not to a widened scope', () => {
    expect(classifyApprovalFailure(403, '')).toMatch(/lacks pull-request write access/)
    expect(classifyApprovalFailure(404, '')).toMatch(/cannot see this repository/)
  })

  it('stays silent on failures it does not recognise', () => {
    expect(classifyApprovalFailure(500, 'Internal Server Error')).toBeUndefined()
  })
})

describe('review body', () => {
  it('leads with the verdict and never inlines the token', () => {
    const body = reviewBody(
      { verdict: 'needs_changes', summary: 'budget cap is not enforced', findings: [] },
      'https://github.com/o/r/actions/runs/1',
    )
    expect(body).toContain('`needs_changes`')
    expect(body).toContain('budget cap is not enforced')
    expect(body).toContain('actions/runs/1')
  })

  it('lists blocking findings with file and line, capped at five', () => {
    // 12 findings, 6 blocking: the 6th must be cut, and the non-blocking nits
    // must never be listed as reasons to block.
    const findings = Array.from({ length: 12 }, (_, i) => ({
      severity: i < 6 ? 'high' : 'nit',
      file: `f${i}.py`,
      line: i + 1,
      message: `problem ${i}\nsecond line`,
    }))
    const body = reviewBody({ verdict: 'needs_changes', findings }, undefined)
    expect(body).toContain('12 finding(s), 6 blocking')
    expect(body).toContain('`f0.py:1`')
    expect(body).toContain('`f4.py:5`')
    expect(body).not.toContain('`f5.py:6`')
    expect(body).not.toContain('`f6.py:7`')
    // Multi-line messages must not break the list.
    expect(body).toContain('problem 0 second line')
  })

  it('cites the test command the approval stands on', () => {
    const body = reviewBody({ verdict: 'pass' }, undefined, 'python -m unittest -v && ruff check .')
    expect(body).toContain('**Verified by:** `python -m unittest -v && ruff check .`')
  })

  it('says so plainly when no command is cited, rather than implying one', () => {
    const body = reviewBody({ verdict: 'pass' }, undefined)
    expect(body).toContain('cites no test command')
  })

  it('keeps a multi-line evidence string on one line so it stays a command', () => {
    const body = reviewBody({ verdict: 'pass' }, undefined, 'pytest -q\nruff check .')
    expect(body).toContain('`pytest -q ruff check .`')
  })

  it('omits the finding block entirely when there are none', () => {
    const body = reviewBody({ verdict: 'pass', findings: [] }, undefined)
    expect(body).not.toContain('finding(s)')
  })
})

describe('pull request number resolution', () => {
  it('reads the pull_request payload', () => {
    expect(prNumberFromEvent('pull_request', { pull_request: { number: 101 } })).toBe(101)
  })

  it('reads the pull_request_target payload', () => {
    expect(prNumberFromEvent('pull_request_target', { number: 7 })).toBe(7)
  })

  it('reads the issue_comment payload', () => {
    expect(prNumberFromEvent('issue_comment', { issue: { number: 9 } })).toBe(9)
  })

  it('returns undefined when there is no pull request', () => {
    expect(prNumberFromEvent('push', {})).toBeUndefined()
  })
})

describe('evidence check verification', () => {
  const green = { name: 'test (22)', status: 'completed', conclusion: 'success' }

  it('accepts a completed successful run of the named check', () => {
    expect(verifyEvidenceCheck([green], 'test (22)')).toEqual({ ok: true, check: green })
  })

  it('matches the name case-insensitively but not loosely', () => {
    // 'test' must not match 'test (22)' — a loose match would let a green
    // unit job stand in for the whole suite.
    expect(verifyEvidenceCheck([green], 'test').ok).toBe(false)
    expect(verifyEvidenceCheck([green], 'TEST (22)').ok).toBe(true)
  })

  it('distinguishes still-running from failed', () => {
    const running = verifyEvidenceCheck(
      [{ name: 'test (22)', status: 'in_progress', conclusion: null }],
      'test (22)',
    )
    expect(running.reason).toBe('not-completed')
    const failed = verifyEvidenceCheck(
      [{ name: 'test (22)', status: 'completed', conclusion: 'failure' }],
      'test (22)',
    )
    expect(failed.reason).toBe('not-successful')
  })

  it('picks the green run when a check name appears more than once', () => {
    const stale = { name: 'test (22)', status: 'completed', conclusion: 'failure' }
    expect(verifyEvidenceCheck([stale, green], 'test (22)')).toEqual({ ok: true, check: green })
  })

  it('refuses an empty or absent name', () => {
    expect(verifyEvidenceCheck([green], '').reason).toBe('no-check-named')
    expect(verifyEvidenceCheck(undefined, 'test (22)').reason).toBe('no-check-named')
  })

  it('explains a missing check as a missing check, not as a credential problem', () => {
    const msg = classifyEvidenceFailure('test (22)', { ok: false, reason: 'no-check-named' })
    expect(msg).toContain('No check run named `test (22)`')
    // The remedy is a config fix, so it must not send anyone hunting a scope.
    expect(msg).not.toContain('lacks pull-request write access')
    expect(msg).not.toContain('cannot see this repository')
  })

  it('reports the observed conclusion and the run URL when a check is red', () => {
    const msg = classifyEvidenceFailure('test (22)', {
      ok: false,
      reason: 'not-successful',
      check: { conclusion: 'failure', html_url: 'https://github.com/o/r/runs/7' },
    })
    expect(msg).toContain('`failure`')
    expect(msg).toContain('https://github.com/o/r/runs/7')
  })
})

describe('stale approval retirement', () => {
  const head = 'b'.repeat(40)
  const old = 'a'.repeat(40)
  const approveAt = (over: Record<string, unknown> = {}) => ({
    id: 1,
    state: 'APPROVED',
    commit_id: old,
    user: { login: 'argus-reviewer[bot]' },
    ...over,
  })

  it('selects this identity approvals of commits that are no longer the head', () => {
    const found = staleApprovals([approveAt()], { login: 'argus-reviewer[bot]', headSha: head })
    expect(found).toHaveLength(1)
  })

  it('leaves an approval of the current head alone', () => {
    expect(
      staleApprovals([approveAt({ commit_id: head })], {
        login: 'argus-reviewer[bot]',
        headSha: head,
      }),
    ).toHaveLength(0)
  })

  it("never touches another identity's review", () => {
    // An approver revoking its own outgrown approval is self-correction.
    // Revoking a colleague's is not something a bot should do.
    expect(
      staleApprovals([approveAt({ user: { login: 'coderabbitai[bot]' } })], {
        login: 'argus-reviewer[bot]',
        headSha: head,
      }),
    ).toHaveLength(0)
  })

  it('ignores non-approvals and already-dismissed reviews', () => {
    expect(
      staleApprovals([approveAt({ state: 'COMMENTED' }), approveAt({ state: 'DISMISSED', id: 2 })], {
        login: 'argus-reviewer[bot]',
        headSha: head,
      }),
    ).toHaveLength(0)
  })

  it('does nothing when the submitting identity is unknown', () => {
    expect(staleApprovals([approveAt()], { login: undefined, headSha: head })).toEqual([])
  })
})

describe('emit-review lane', () => {
  let workdir: string
  let stdout: string[]
  let headAt: ReturnType<typeof vi.fn>
  let listRev: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'argus-approve-'))
    stdout = []
    // Defaults: the head has not moved, and there are no prior reviews to retire.
    headAt = vi.fn().mockResolvedValue(HEAD_SHA)
    listRev = vi.fn().mockResolvedValue([])
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk))
      return true
    })
  })

  const lines = (): string => stdout.join('')

  const baseEnv = {
    GITHUB_REPOSITORY: 'duketopceo/orchestral',
    ARGUS_REPORT_DIR: 'argus-reviewer-report',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '42',
  }
  const approved = {
    ARGUS_APPROVAL_TOKEN: 'ghs_secret',
    ARGUS_APPROVAL_EVIDENCE: 'python -m unittest discover -s tests',
    ARGUS_APPROVAL_CHECK: 'test (22)',
    ARGUS_HEAD_SHA: 'a'.repeat(40),
  }
  const HEAD_SHA = 'a'.repeat(40)
  const greenCheck = {
    name: 'test (22)',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/o/r/runs/7',
  }
  const listGreen = vi.fn().mockResolvedValue([greenCheck])

  async function writeReport(report: unknown): Promise<void> {
    await mkdir(join(workdir, 'argus-reviewer-report'), { recursive: true })
    await writeFile(
      join(workdir, 'argus-reviewer-report', 'code-review.json'),
      JSON.stringify(report),
      'utf8',
    )
  }

  it('submits APPROVE and reports the state', async () => {
    const submit = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ id: 1, state: 'APPROVED', user: { login: 'argus[bot]' } }),
    })
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews: listRev,
        list: listGreen,
        read: async () => ({ verdict: 'pass', findings: [], summary: 'clean' }),
      },
    )
    expect(submit).toHaveBeenCalledOnce()
    const arg = submit.mock.calls[0][0]
    expect(arg).toMatchObject({ repo: 'duketopceo/orchestral', pr: 101, event: 'APPROVE' })
    expect(arg.body).toContain('`pass`')
    // AC: an approval must cite the command it stands on.
    expect(arg.body).toContain('`python -m unittest discover -s tests`')
    // ...and the citation is checked against a real run, not trusted.
    expect(arg.body).toContain('Green on this commit')
    expect(arg.body).toContain('https://github.com/o/r/runs/7')
    // Bound to the same commit the review is submitted against.
    expect(listGreen).toHaveBeenCalledWith(expect.objectContaining({ ref: 'a'.repeat(40) }))
    expect(arg.commitId).toBe('a'.repeat(40))
    expect(result).toMatchObject({ ok: true, reviewEvent: 'APPROVE', reviewState: 'APPROVED' })
    expect(lines()).toContain('as argus[bot]')
  })

  it('refuses to approve when the named check is not green', async () => {
    // A cited command is a claim. This is the control: the named check must
    // have actually finished green on the head commit.
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews: listRev,
        list: async () => [{ ...greenCheck, conclusion: 'failure' }],
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.reviewState).toBe('unverified-evidence')
    expect(lines()).toContain('Refusing to approve a commit whose named check is not green')
  })

  it('refuses to approve while the named check is still running', async () => {
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews: listRev,
        list: async () => [{ ...greenCheck, status: 'in_progress', conclusion: null }],
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.reviewState).toBe('unverified-evidence')
    expect(lines()).toContain('has not finished on the head commit')
  })

  it('refuses to approve when no check of that name exists at all', async () => {
    // The rubber-stamp route: cite a command, name a check that does not exist.
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews: listRev,
        list: async () => [{ ...greenCheck, name: 'smoke' }],
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.reviewState).toBe('unverified-evidence')
    expect(lines()).toContain('cannot be shown to have run')
  })

  it('refuses to approve when no approval-check is named', async () => {
    const submit = vi.fn()
    const result = await emitApprovalReview(
      {
        ...baseEnv,
        ARGUS_APPROVAL_TOKEN: 'ghs_secret',
        ARGUS_APPROVAL_EVIDENCE: 'pytest -q',
        ARGUS_HEAD_SHA: 'a'.repeat(40),
        __event: { pull_request: { number: 101 } },
      },
      { submit, head: headAt, reviews: listRev, read: async () => ({ verdict: 'pass', findings: [] }) },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.reviewState).toBe('unverified-evidence')
  })

  it('refuses to approve when the head commit is unknown', async () => {
    // Without a SHA the check cannot be bound to anything, and binding it to a
    // moving branch tip is the hole this closes.
    const submit = vi.fn()
    const list = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, ARGUS_HEAD_SHA: '', __event: { pull_request: { number: 101 } } },
      { submit, list, read: async () => ({ verdict: 'pass', findings: [] }) },
    )
    expect(list).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(result.reviewState).toBe('unverified-evidence')
  })

  it('fails closed when the check runs cannot be read', async () => {
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews: listRev,
        list: async () => {
          throw new Error('HTTP 403')
        },
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.reviewState).toBe('no-check-runs')
  })

  it('refuses to submit once the head has moved under the run', async () => {
    // The run reviewed the code at the event's head SHA. If the head has moved,
    // submitting would attach a verdict about old code to a new commit.
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: async () => 'c'.repeat(40),
        reviews: listRev,
        list: listGreen,
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.reviewState).toBe('head-moved')
    expect(lines()).toContain('The push triggers a new run')
  })

  it('fails closed when the current head cannot be read', async () => {
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: async () => {
          throw new Error('HTTP 404')
        },
        reviews: listRev,
        list: listGreen,
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.reviewState).toBe('no-head')
  })

  it('retires its own stale approvals after submitting a new one', async () => {
    // `dismiss_stale_reviews` is false on the protected branch, so an APPROVE
    // of an old head keeps counting until something dismisses it.
    const submit = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ id: 9, state: 'APPROVED', user: { login: 'argus-reviewer[bot]' } }),
    })
    const dismiss = vi.fn().mockResolvedValue({})
    const reviews = vi.fn().mockResolvedValue([
      { id: 5, state: 'APPROVED', commit_id: 'd'.repeat(40), user: { login: 'argus-reviewer[bot]' } },
      { id: 6, state: 'APPROVED', commit_id: 'e'.repeat(40), user: { login: 'argus-reviewer[bot]' } },
    ])
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews,
        dismiss,
        list: listGreen,
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(result.ok).toBe(true)
    expect(dismiss).toHaveBeenCalledTimes(2)
    expect(dismiss.mock.calls[0][0]).toMatchObject({ pr: 101, reviewId: 5 })
    expect(dismiss.mock.calls[0][0].message).toContain('no longer the head')
    expect(lines()).toContain('retired 2 of 2 stale approval(s)')
  })

  it('never dismisses a review by a different identity', async () => {
    const submit = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ id: 9, state: 'APPROVED', user: { login: 'argus-reviewer[bot]' } }),
    })
    const dismiss = vi.fn()
    const reviews = vi.fn().mockResolvedValue([
      { id: 5, state: 'APPROVED', commit_id: 'd'.repeat(40), user: { login: 'coderabbitai[bot]' } },
    ])
    await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews,
        dismiss,
        list: listGreen,
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('keeps the submitted approval when retiring stale ones fails', async () => {
    // The review already landed. Failing the step now would report a good
    // review as broken, and must not retract what was just approved.
    const submit = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ id: 9, state: 'APPROVED', user: { login: 'argus-reviewer[bot]' } }),
    })
    const dismiss = vi.fn().mockRejectedValue(new Error('HTTP 403'))
    const reviews = vi.fn().mockResolvedValue([
      { id: 5, state: 'APPROVED', commit_id: 'd'.repeat(40), user: { login: 'argus-reviewer[bot]' } },
    ])
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews,
        dismiss,
        list: listGreen,
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(result.ok).toBe(true)
    expect(result.reviewState).toBe('APPROVED')
    expect(lines()).toContain('::warning::')
  })

  it('does not retire anything when the submit itself failed', async () => {
    // Fail-safe ordering: a rejected review must never destroy the approval the
    // pull request already had.
    const submit = vi.fn().mockRejectedValue(
      Object.assign(new Error(GITHUB_TOKEN_422), { status: 422 }),
    )
    const dismiss = vi.fn()
    const reviews = vi.fn().mockResolvedValue([
      { id: 5, state: 'APPROVED', commit_id: 'd'.repeat(40), user: { login: 'argus-reviewer[bot]' } },
    ])
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews,
        dismiss,
        list: listGreen,
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(result.ok).toBe(false)
    expect(dismiss).not.toHaveBeenCalled()
    expect(reviews).not.toHaveBeenCalled()
  })

  it('submits REQUEST_CHANGES without requiring a green check', async () => {
    // Red CI is exactly when a negative review must still go out, so the
    // evidence gate must not gate the negative path.
    await writeReport({ verdict: 'needs_changes', findings: [] })
    const submit = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ id: 2, state: 'CHANGES_REQUESTED', user: { login: 'argus[bot]' } }),
    })
    const list = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      { submit, list, head: headAt, reviews: listRev, read: async () => ({ verdict: 'needs_changes', findings: [] }) },
    )
    expect(list).not.toHaveBeenCalled()
    expect(submit.mock.calls[0][0].event).toBe('REQUEST_CHANGES')
    expect(result).toMatchObject({ ok: true, reviewEvent: 'REQUEST_CHANGES' })
  })

  it('refuses to approve when no test command is cited', async () => {
    // The rule is enforced, not documented: an uncited approval is a signature.
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ARGUS_APPROVAL_TOKEN: 'ghs_secret', __event: { pull_request: { number: 101 } } },
      { submit, head: headAt, reviews: listRev, read: async () => ({ verdict: 'pass', findings: [] }) },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.reviewState).toBe('no-evidence')
    expect(lines()).toContain('must cite the test command')
  })

  it('is a no-op, not a failure, when no approval token is supplied', async () => {
    // No token means the evidence rule does not apply — commenting is the default.
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, __event: { pull_request: { number: 101 } } },
      { submit, head: headAt, reviews: listRev },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(lines()).toContain('no approval-token supplied')
  })

  it('fails closed when the report is missing rather than approving', async () => {
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews: listRev,
        read: async () => {
          throw new Error('ENOENT')
        },
      },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.reviewState).toBe('no-report')
    expect(lines()).toContain('No review was submitted')
  })

  it('surfaces the Actions-token refusal with a remedy instead of a raw 422', async () => {
    const submit = vi.fn().mockRejectedValue(
      Object.assign(new Error(GITHUB_TOKEN_422), { status: 422 }),
    )
    const result = await emitApprovalReview(
      { ...baseEnv, ...approved, __event: { pull_request: { number: 101 } } },
      {
        submit,
        head: headAt,
        reviews: listRev,
        list: listGreen,
        read: async () => ({ verdict: 'pass', findings: [] }),
      },
    )
    expect(result.ok).toBe(false)
    const out = lines()
    expect(out).toContain('GITHUB_TOKEN cannot approve')
    expect(out).not.toContain('ghs_secret')
  })

  it('skips quietly on an event with no pull request', async () => {
    const submit = vi.fn()
    const result = await emitApprovalReview({ ...baseEnv, ...approved }, { submit, head: headAt, reviews: listRev })
    expect(submit).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(lines()).toContain('no pull request in this event')
  })
})

describe('lane resolution', () => {
  it('joins the working directory onto the report dir', () => {
    expect(
      resolveLane({ GITHUB_REPOSITORY: 'o/r', VISION_E2E_WORKING_DIR: 'apps/web' }).reportDir,
    ).toBe('apps/web/argus-reviewer-report')
  })

  it('prefers an explicit pull request number over the event payload', () => {
    expect(
      resolveLane({
        GITHUB_REPOSITORY: 'o/r',
        ARGUS_PR_NUMBER: '5',
        __event: { pull_request: { number: 101 } },
      }).pr,
    ).toBe(5)
  })
})
