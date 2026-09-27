import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error plain-node action helper — no type declarations
import {
  classifyApprovalFailure,
  prNumberFromEvent,
  reviewBody,
  reviewEventFor,
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

describe('emit-review lane', () => {
  let workdir: string
  let stdout: string[]

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'argus-approve-'))
    stdout = []
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
      { ...baseEnv, ARGUS_APPROVAL_TOKEN: 'ghs_secret', __event: { pull_request: { number: 101 } } },
      { submit, read: async () => ({ verdict: 'pass', findings: [], summary: 'clean' }) },
    )
    expect(submit).toHaveBeenCalledOnce()
    const arg = submit.mock.calls[0][0]
    expect(arg).toMatchObject({ repo: 'duketopceo/orchestral', pr: 101, event: 'APPROVE' })
    expect(arg.body).toContain('`pass`')
    expect(result).toMatchObject({ ok: true, reviewEvent: 'APPROVE', reviewState: 'APPROVED' })
    expect(lines()).toContain('as argus[bot]')
  })

  it('submits REQUEST_CHANGES on a failing verdict', async () => {
    await writeReport({ verdict: 'needs_changes', findings: [] })
    const submit = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ id: 2, state: 'CHANGES_REQUESTED', user: { login: 'argus[bot]' } }),
    })
    const result = await emitApprovalReview(
      { ...baseEnv, ARGUS_APPROVAL_TOKEN: 'ghs_secret', __event: { pull_request: { number: 101 } } },
      { submit, read: async () => ({ verdict: 'needs_changes', findings: [] }) },
    )
    expect(submit.mock.calls[0][0].event).toBe('REQUEST_CHANGES')
    expect(result).toMatchObject({ ok: true, reviewEvent: 'REQUEST_CHANGES' })
  })

  it('is a no-op, not a failure, when no approval token is supplied', async () => {
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, __event: { pull_request: { number: 101 } } },
      { submit },
    )
    expect(submit).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(lines()).toContain('no approval-token supplied')
  })

  it('fails closed when the report is missing rather than approving', async () => {
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ARGUS_APPROVAL_TOKEN: 'ghs_secret', __event: { pull_request: { number: 101 } } },
      {
        submit,
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
      { ...baseEnv, ARGUS_APPROVAL_TOKEN: 'ghs_secret', __event: { pull_request: { number: 101 } } },
      { submit, read: async () => ({ verdict: 'pass', findings: [] }) },
    )
    expect(result.ok).toBe(false)
    const out = lines()
    expect(out).toContain('GITHUB_TOKEN cannot approve')
    expect(out).not.toContain('ghs_secret')
  })

  it('skips quietly on an event with no pull request', async () => {
    const submit = vi.fn()
    const result = await emitApprovalReview(
      { ...baseEnv, ARGUS_APPROVAL_TOKEN: 'ghs_secret' },
      { submit },
    )
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
