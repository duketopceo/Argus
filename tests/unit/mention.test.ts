import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PrMeta } from '../../src/evidence/ci.js'
import {
  MENTION_HELP,
  mayRunMention,
  parseMention,
  postIssueComment,
} from '../../src/mention.js'

const meta = (overrides: Partial<PrMeta> = {}): PrMeta => ({
  headSha: 'abc',
  baseSha: 'def',
  isFork: false,
  authorAssociation: 'MEMBER',
  labels: [],
  pushedAt: undefined,
  labelApprovedAt: undefined,
  title: undefined,
  body: undefined,
  ...overrides,
})

describe('parseMention', () => {
  it('parses whitelisted commands', () => {
    expect(parseMention('@argus review')).toEqual({ name: 'review' })
    expect(parseMention('@argus help')).toEqual({ name: 'help' })
    expect(parseMention('@argus persist')).toEqual({ name: 'persist' })
    expect(parseMention('@argus')).toEqual({ name: 'help' })
    expect(parseMention('@argus   ')).toEqual({ name: 'help' })
  })

  it('parses record flow descriptions, quoted or bare', () => {
    expect(parseMention('@argus record "sign in with Google"')).toEqual({
      name: 'record',
      arg: 'sign in with Google',
    })
    expect(parseMention('@argus record sign in')).toEqual({ name: 'record', arg: 'sign in' })
    expect(parseMention('@argus record')).toEqual({ name: 'record' })
  })

  it('sanitizes the commenter-controlled flow arg', () => {
    // Commands are single-line — the newline ends the command, and the
    // backtick is stripped for the public reply echo.
    const parsed = parseMention('@argus record "boom`evil\nnext line"')
    expect(parsed).toEqual({ name: 'record', arg: 'boom evil' })
  })

  it('only fires at the start of a comment', () => {
    expect(parseMention('please look at this @argus review')).toBeUndefined()
    expect(parseMention('no mention here')).toBeUndefined()
    expect(parseMention('@argusnotacommand review')).toBeUndefined()
  })

  it('returns unknown for non-whitelisted verbs', () => {
    expect(parseMention('@argus rm -rf /')).toBe('unknown')
    expect(parseMention('@argus deploy prod')).toBe('unknown')
  })
})

describe('mayRunMention', () => {
  it('ignores untrusted commenters silently', () => {
    for (const assoc of ['CONTRIBUTOR', 'FIRST_TIMER', 'NONE', undefined]) {
      const gate = mayRunMention({ name: 'review' }, assoc, meta())
      expect(gate.allowed).toBe(false)
      expect(gate.reply).toBeUndefined()
    }
  })

  it('lets help through with just a trusted association', () => {
    expect(mayRunMention({ name: 'help' }, 'MEMBER', undefined).allowed).toBe(true)
  })

  it('fails closed when PR metadata is unavailable', () => {
    const gate = mayRunMention({ name: 'review' }, 'MEMBER', undefined)
    expect(gate.allowed).toBe(false)
    expect(gate.reply).toContain('metadata')
  })

  it('allows execution commands on same-repo PRs', () => {
    for (const name of ['review', 'record', 'persist'] as const) {
      expect(mayRunMention({ name }, 'MEMBER', meta()).allowed).toBe(true)
    }
  })

  it('disables record and persist entirely on fork PRs', () => {
    const fork = meta({ isFork: true, labels: ['argus-probe'], labelApprovedAt: '2', pushedAt: '1' })
    for (const name of ['record', 'persist'] as const) {
      const gate = mayRunMention({ name }, 'OWNER', fork)
      expect(gate.allowed).toBe(false)
      expect(gate.reply).toContain('fork')
    }
  })

  it('requires the head-bound probe label for review on fork PRs', () => {
    const fork = meta({ isFork: true })
    expect(mayRunMention({ name: 'review' }, 'MEMBER', fork).allowed).toBe(false)
    // Label present but not covering the current head → still denied.
    const stale = meta({
      isFork: true,
      labels: ['argus-probe'],
      labelApprovedAt: '2026-01-01T00:00:00Z',
      pushedAt: '2026-01-02T00:00:00Z',
    })
    expect(mayRunMention({ name: 'review' }, 'MEMBER', stale).allowed).toBe(false)
    const covered = meta({
      isFork: true,
      labels: ['argus-probe'],
      labelApprovedAt: '2026-01-02T00:00:00Z',
      pushedAt: '2026-01-01T00:00:00Z',
    })
    expect(mayRunMention({ name: 'review' }, 'MEMBER', covered).allowed).toBe(true)
  })
})

describe('postIssueComment', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the reply body to the issue comments endpoint', async () => {
    const calls: { url: string; body: string }[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body) })
      return new Response('{}', { status: 201 })
    })
    const errs: string[] = []
    const ok = await postIssueComment('a/b', '7', 'hello', 'tok', { err: (l) => errs.push(l) })
    expect(ok).toBe(true)
    expect(calls[0]?.url).toBe('https://api.github.com/repos/a/b/issues/7/comments')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ body: 'hello' })
    expect(errs).toEqual([])
  })

  it('returns false and logs on a failed post', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 403 }))
    const errs: string[] = []
    const ok = await postIssueComment('a/b', '7', 'hi', 'tok', { err: (l) => errs.push(l) })
    expect(ok).toBe(false)
    expect(errs[0]).toContain('403')
  })
})

describe('MENTION_HELP', () => {
  it('lists the whitelisted commands', () => {
    expect(MENTION_HELP).toContain('@argus review')
    expect(MENTION_HELP).toContain('@argus record')
    expect(MENTION_HELP).toContain('@argus persist')
    expect(MENTION_HELP).toContain('@argus help')
  })
})
