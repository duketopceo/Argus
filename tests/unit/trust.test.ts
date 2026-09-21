import { describe, expect, it } from 'vitest'

import { resolveTrust } from '../../src/trust.js'
import type { PrMeta } from '../../src/evidence/ci.js'

const META_FORK: PrMeta = {
  headSha: 'abc',
  baseSha: 'def',
  isFork: true,
  authorAssociation: 'NONE',
  labels: [],
  pushedAt: undefined,
  labelApprovedAt: undefined,
}

const META_SAME_REPO: PrMeta = { ...META_FORK, isFork: false, authorAssociation: 'MEMBER' }

function prPayload(fork: boolean | null): string {
  return JSON.stringify({ pull_request: { head: { repo: fork === null ? null : { fork } } } })
}

function issueCommentPayload(number: number, isPr = true): string {
  return JSON.stringify({ issue: { number, ...(isPr ? { pull_request: {} } : {}) } })
}

describe('resolveTrust', () => {
  it('resolves trusted on a local run with no CI event context', async () => {
    const r = await resolveTrust({ env: {} })
    expect(r.trust).toBe('trusted')
    expect(r.pr).toBeUndefined()
  })

  it('ARGUS_UNTRUSTED=1 forces untrusted even locally', async () => {
    const r = await resolveTrust({ env: { ARGUS_UNTRUSTED: '1' } })
    expect(r.trust).toBe('untrusted')
  })

  it('ARGUS_UNTRUSTED=1 beats ARGUS_TRUSTED=1', async () => {
    const r = await resolveTrust({ env: { ARGUS_UNTRUSTED: '1', ARGUS_TRUSTED: '1' } })
    expect(r.trust).toBe('untrusted')
  })

  it('ARGUS_TRUSTED=1 overrides an unlisted CI event', async () => {
    const r = await resolveTrust({
      env: { GITHUB_EVENT_NAME: 'workflow_run', ARGUS_TRUSTED: '1' },
    })
    expect(r.trust).toBe('trusted')
  })

  it('pull_request fork resolves untrusted from the payload with no token', async () => {
    const r = await resolveTrust({
      env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/tmp/event.json' },
      readEventFile: async () => prPayload(true),
    })
    expect(r.trust).toBe('untrusted')
    expect(r.reason).toContain('fork')
  })

  it('pull_request same-repo resolves trusted from the payload', async () => {
    const r = await resolveTrust({
      env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/tmp/event.json' },
      readEventFile: async () => prPayload(false),
    })
    expect(r.trust).toBe('trusted')
  })

  it('pull_request_target follows the same payload rule', async () => {
    const r = await resolveTrust({
      env: { GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: '/tmp/event.json' },
      readEventFile: async () => prPayload(true),
    })
    expect(r.trust).toBe('untrusted')
  })

  it('pull_request with a deleted fork (head.repo null) fails closed', async () => {
    const r = await resolveTrust({
      env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/tmp/event.json' },
      readEventFile: async () => prPayload(null),
    })
    expect(r.trust).toBe('untrusted')
  })

  it('pull_request with unreadable payload falls back to fetchMeta', async () => {
    const r = await resolveTrust({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: '/tmp/missing.json',
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_TOKEN: 't',
        ARGUS_REVIEWER_TRACE: '{"pr":"7"}',
      },
      readEventFile: async () => {
        throw new Error('ENOENT')
      },
      fetchMeta: async () => META_SAME_REPO,
    })
    expect(r.trust).toBe('trusted')
  })

  it('pull_request with unreadable payload and no metadata fails closed', async () => {
    const r = await resolveTrust({
      env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/tmp/missing.json' },
      readEventFile: async () => {
        throw new Error('ENOENT')
      },
    })
    expect(r.trust).toBe('untrusted')
  })

  it('issue_comment on a fork PR resolves untrusted and surfaces pr', async () => {
    const r = await resolveTrust({
      env: {
        GITHUB_EVENT_NAME: 'issue_comment',
        GITHUB_EVENT_PATH: '/tmp/event.json',
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_TOKEN: 't',
      },
      readEventFile: async () => issueCommentPayload(42),
      fetchMeta: async (_repo, pr) => {
        expect(pr).toBe('42')
        return META_FORK
      },
    })
    expect(r.trust).toBe('untrusted')
    expect(r.pr).toBe('42')
  })

  it('issue_comment without usable metadata fails closed', async () => {
    const r = await resolveTrust({
      env: { GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: '/tmp/event.json' },
      readEventFile: async () => issueCommentPayload(42),
    })
    expect(r.trust).toBe('untrusted')
    expect(r.pr).toBe('42')
  })

  it('issue_comment on a non-PR issue fails closed with no pr', async () => {
    const r = await resolveTrust({
      env: { GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: '/tmp/event.json' },
      readEventFile: async () => issueCommentPayload(9, false),
    })
    expect(r.trust).toBe('untrusted')
    expect(r.pr).toBeUndefined()
  })

  it('an unlisted event name fails closed', async () => {
    for (const name of ['workflow_run', 'workflow_dispatch', 'push', 'merge_group', 'schedule']) {
      const r = await resolveTrust({ env: { GITHUB_EVENT_NAME: name } })
      expect(r.trust).toBe('untrusted')
    }
  })

  it('invokes note with the resolved decision', async () => {
    const notes: string[] = []
    await resolveTrust({ env: {}, note: (l) => notes.push(l) })
    expect(notes[0]).toContain('trusted')
  })
})
