import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyFixes } from '../../src/github/apply-fixes.js'
import type { PrMeta } from '../../src/evidence/ci.js'
import { mayRunMention, parseMention } from '../../src/mention.js'
import { main } from '../../src/cli.js'

const HEAD = 'h'.repeat(40)
const OLD_HEAD = 'o'.repeat(40)

const meta = (overrides: Partial<PrMeta> = {}): PrMeta => ({
  headSha: HEAD,
  baseSha: 'b'.repeat(40),
  baseRef: 'main',
  headRef: 'feature',
  isFork: false,
  authorAssociation: 'MEMBER',
  labels: [],
  pushedAt: undefined,
  labelApprovedAt: undefined,
  title: undefined,
  body: undefined,
  ...overrides,
})

const suggestionBody = (message: string, suggestion: string): string =>
  `<!-- argus-reviewer:inline -->\n**bug** · proven 90%\n${message}\n\n\`\`\`\`suggestion\n${suggestion}\n\`\`\`\``

const reviewComment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  path: 'src/a.ts',
  line: 2,
  side: 'RIGHT',
  commit_id: HEAD,
  body: suggestionBody('use the constant', 'const x = 2'),
  user: { login: 'github-actions[bot]' },
  html_url: 'https://github.com/a/b/pull/7#c1',
  ...over,
})

/** The file at head: three lines the suggestions rewrite. */
const FILE_AT_HEAD = 'one\ntwo\nthree\n'

const prFiles = [
  { filename: 'src/a.ts', patch: '@@ -1,3 +1,3 @@\n one\n-two\n+two\n three' },
]

interface Captured {
  replies: string[]
  puts: { path: string; body: Record<string, unknown> }[]
  prPosts: Record<string, unknown>[]
  refPosts: Record<string, unknown>[]
}

/**
 * Fetch stub covering every endpoint the fix lane touches. `headSha` is
 * mutable so a test can move the head between the meta fetch and the
 * preOpen re-verify (TOCTOU).
 */
const stubGitHub = (
  state: { headSha: string; comments: Record<string, unknown>[]; fileContent?: string },
): Captured & { fetch: typeof fetch } => {
  const cap: Captured = { replies: [], puts: [], prPosts: [], refPosts: [] }
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (method === 'POST' && url.endsWith('/issues/7/comments')) {
      cap.replies.push(String(init?.body))
      return new Response('{}', { status: 201 })
    }
    if (url.includes('/pulls/7/files')) {
      return new Response(JSON.stringify(prFiles), { status: 200 })
    }
    if (url.includes('/pulls/7/comments')) {
      return new Response(JSON.stringify(state.comments), { status: 200 })
    }
    if (url.endsWith('/pulls/7')) {
      return new Response(
        JSON.stringify({
          head: { sha: state.headSha, ref: 'feature', repo: { fork: false } },
          base: { sha: 'b'.repeat(40), ref: 'main' },
          author_association: 'MEMBER',
          labels: [],
        }),
        { status: 200 },
      )
    }
    if (url.includes('/compare/')) {
      return new Response(
        JSON.stringify({ merge_base_commit: { sha: 'b'.repeat(40) } }),
        { status: 200 },
      )
    }
    if (method === 'GET' && url.includes('/contents/')) {
      const ref = new URL(url).searchParams.get('ref') ?? ''
      if (ref === 'argus/fix-7-hhhhhhhh') {
        // Blob sha lookup on the write branch (upsert mode).
        return new Response(JSON.stringify({ sha: 'blob-sha' }), { status: 200 })
      }
      if (state.fileContent === undefined) return new Response('{}', { status: 404 })
      return new Response(
        JSON.stringify({
          content: Buffer.from(state.fileContent, 'utf8').toString('base64'),
          encoding: 'base64',
        }),
        { status: 200 },
      )
    }
    if (method === 'POST' && url.endsWith('/git/refs')) {
      cap.refPosts.push(body)
      return new Response('{}', { status: 201 })
    }
    if (method === 'PUT' && url.includes('/contents/')) {
      cap.puts.push({ path: decodeURIComponent(url.split('/contents/')[1]?.split('?')[0] ?? ''), body })
      return new Response('{}', { status: 201 })
    }
    if (url.includes('/pulls?head=')) return new Response('[]', { status: 200 })
    if (method === 'POST' && url.endsWith('/pulls')) {
      cap.prPosts.push(body)
      return new Response(
        JSON.stringify({ html_url: 'https://github.com/a/b/pull/42' }),
        { status: 201 },
      )
    }
    return new Response('{}', { status: 404 })
  }
  return { ...cap, fetch: fetchStub as typeof fetch }
}

const silence: { err: (l: string) => void } = { err: () => {} }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseMention fix', () => {
  it('parses @argus fix', () => {
    expect(parseMention('@argus fix')).toEqual({ name: 'fix' })
  })
})

describe('mayRunMention fix', () => {
  it('is refused on fork PRs', () => {
    const gate = mayRunMention({ name: 'fix' }, 'MEMBER', meta({ isFork: true }))
    expect(gate.allowed).toBe(false)
    expect(gate.reply).toContain('fix')
  })

  it('is allowed on same-repo PRs for trusted commenters', () => {
    expect(mayRunMention({ name: 'fix' }, 'MEMBER', meta()).allowed).toBe(true)
  })
})

describe('applyFixes', () => {
  it('applies a posted suggestion and opens a PR bound to the head sha', async () => {
    const gh = stubGitHub({ headSha: HEAD, comments: [reviewComment()], fileContent: FILE_AT_HEAD })
    vi.stubGlobal('fetch', gh.fetch)
    const result = await applyFixes(
      { repo: 'a/b', pr: '7', meta: meta(), files: prFiles },
      'tok',
      silence,
    )
    expect(result.error).toBeUndefined()
    expect(result.prUrl).toBe('https://github.com/a/b/pull/42')
    expect(result.applied).toHaveLength(1)
    // Branch forks from the exact head SHA, PR targets the head branch.
    expect(gh.refPosts[0]).toEqual({ ref: 'refs/heads/argus/fix-7-hhhhhhhh', sha: HEAD })
    expect(gh.prPosts[0]?.base).toBe('feature')
    // The PUT carries the blob sha (upsert) and the patched content.
    const put = gh.puts[0]
    expect(put?.path).toBe('src/a.ts')
    expect(put?.body.sha).toBe('blob-sha')
    expect(put?.body.branch).toBe('argus/fix-7-hhhhhhhh')
    const patched = Buffer.from(String(put?.body.content), 'base64').toString('utf8')
    expect(patched).toBe('one\nconst x = 2\nthree\n')
    // PR body renders the verbatim hunk.
    const prBody = String(gh.prPosts[0]?.body)
    expect(prBody).toContain('`src/a.ts` L2')
    expect(prBody).toContain('-two')
    expect(prBody).toContain('+const x = 2')
    expect(prBody).toContain('source comment')
  })

  it('applies multiple suggestions to one file bottom-up', async () => {
    const gh = stubGitHub({
      headSha: HEAD,
      comments: [
        reviewComment({ id: 1, line: 2, body: suggestionBody('m', 'TWO') }),
        reviewComment({ id: 2, line: 3, body: suggestionBody('m', 'THREE') }),
      ],
      fileContent: FILE_AT_HEAD,
    })
    vi.stubGlobal('fetch', gh.fetch)
    const result = await applyFixes(
      { repo: 'a/b', pr: '7', meta: meta(), files: prFiles },
      'tok',
      silence,
    )
    expect(result.applied).toHaveLength(2)
    const patched = Buffer.from(String(gh.puts[0]?.body.content), 'base64').toString('utf8')
    expect(patched).toBe('one\nTWO\nTHREE\n')
  })

  it('ignores forged sentinel bodies from non-Argus authors', async () => {
    const gh = stubGitHub({
      headSha: HEAD,
      comments: [reviewComment({ user: { login: 'stranger' } })],
      fileContent: FILE_AT_HEAD,
    })
    vi.stubGlobal('fetch', gh.fetch)
    const result = await applyFixes(
      { repo: 'a/b', pr: '7', meta: meta(), files: prFiles, actor: 'me' },
      'tok',
      silence,
    )
    expect(result.error).toContain('no applicable suggestions')
    expect(gh.refPosts).toHaveLength(0)
  })

  it('skips comments bound to an older head commit', async () => {
    const gh = stubGitHub({
      headSha: HEAD,
      comments: [reviewComment({ commit_id: OLD_HEAD })],
      fileContent: FILE_AT_HEAD,
    })
    vi.stubGlobal('fetch', gh.fetch)
    const result = await applyFixes(
      { repo: 'a/b', pr: '7', meta: meta(), files: prFiles },
      'tok',
      silence,
    )
    expect(result.error).toContain('no applicable suggestions')
    expect(result.applied).toHaveLength(0)
    expect(gh.refPosts).toHaveLength(0)
  })

  it('skips anchors that rotated off the live diff', async () => {
    const gh = stubGitHub({
      headSha: HEAD,
      comments: [reviewComment({ line: 99 })],
      fileContent: FILE_AT_HEAD,
    })
    vi.stubGlobal('fetch', gh.fetch)
    const result = await applyFixes(
      { repo: 'a/b', pr: '7', meta: meta(), files: prFiles },
      'tok',
      silence,
    )
    expect(result.applied).toHaveLength(0)
    expect(result.skipped[0]?.reason).toContain('no longer on the diff')
    expect(gh.refPosts).toHaveLength(0)
  })

  it('skips oversized spans and LEFT-side comments', async () => {
    const gh = stubGitHub({
      headSha: HEAD,
      comments: [
        // A 51-line span anchored inside the diff hits the span cap.
        reviewComment({ id: 1, line: 52, start_line: 2 }),
        reviewComment({ id: 2, line: 2, side: 'LEFT' }),
      ],
      fileContent: FILE_AT_HEAD,
    })
    vi.stubGlobal('fetch', gh.fetch)
    const bigPatch = [{ filename: 'src/a.ts', patch: `@@ -1,55 +1,55 @@` }]
    const result = await applyFixes(
      { repo: 'a/b', pr: '7', meta: meta(), files: bigPatch },
      'tok',
      silence,
    )
    expect(result.applied).toHaveLength(0)
    expect(result.skipped.map((s) => s.reason).join()).toContain('span exceeds')
  })

  it('skips overlapping suggestion spans', async () => {
    const gh = stubGitHub({
      headSha: HEAD,
      comments: [
        reviewComment({ id: 1, line: 3, start_line: 2, body: suggestionBody('m', 'X\nY') }),
        reviewComment({ id: 2, line: 2, body: suggestionBody('m', 'Z') }),
      ],
      fileContent: FILE_AT_HEAD,
    })
    vi.stubGlobal('fetch', gh.fetch)
    const result = await applyFixes(
      { repo: 'a/b', pr: '7', meta: meta(), files: prFiles },
      'tok',
      silence,
    )
    // The higher span (2-3) applies; the lower anchor overlaps it.
    expect(result.applied).toHaveLength(1)
    expect(result.skipped[0]?.reason).toContain('overlaps')
  })

  it('aborts the PR open when the head moved during apply (TOCTOU)', async () => {
    const state = { headSha: HEAD, comments: [reviewComment()], fileContent: FILE_AT_HEAD }
    const gh = stubGitHub(state)
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/pulls/7')) {
        // Module-level: the only pulls read is the preOpen re-verify — move
        // the head on it so the apply looks stale.
        state.headSha = 'n'.repeat(40)
      }
      return gh.fetch(input, init)
    }
    vi.stubGlobal('fetch', fetchStub)
    const result = await applyFixes(
      { repo: 'a/b', pr: '7', meta: meta(), files: prFiles },
      'tok',
      silence,
    )
    expect(result.stale).toBe(true)
    expect(result.prUrl).toBeUndefined()
    expect(gh.prPosts).toHaveLength(0)
  })
})

describe('argus-reviewer mention fix', () => {
  const mentionEvent = async (
    body: string,
  ): Promise<{ env: Record<string, string> }> => {
    const dir = await mkdtemp(join(tmpdir(), 'argus-mention-'))
    const eventPath = join(dir, 'event.json')
    await writeFile(
      eventPath,
      JSON.stringify({
        issue: { number: 7, pull_request: {} },
        comment: { body, author_association: 'MEMBER' },
      }),
    )
    return {
      env: { GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: eventPath },
    }
  }

  it('applies suggestions and replies with the fix PR', async () => {
    const gh = stubGitHub({ headSha: HEAD, comments: [reviewComment()], fileContent: FILE_AT_HEAD })
    const original = globalThis.fetch
    globalThis.fetch = gh.fetch
    try {
      const { env } = await mentionEvent('@argus fix')
      const code = await main(['mention'], {
        env: { ...env, GITHUB_REPOSITORY: 'a/b', GITHUB_TOKEN: 'tok' },
        out: () => {},
        err: () => {},
      })
      expect(code).toBe(0)
      expect(gh.replies).toHaveLength(1)
      expect(gh.replies[0]).toContain('https://github.com/a/b/pull/42')
      expect(gh.replies[0]).toContain('applied 1 suggestion')
    } finally {
      globalThis.fetch = original
    }
  })

  it('names rotated anchors in the reply when nothing applies', async () => {
    const gh = stubGitHub({
      headSha: HEAD,
      comments: [reviewComment({ line: 99 })],
      fileContent: FILE_AT_HEAD,
    })
    const original = globalThis.fetch
    globalThis.fetch = gh.fetch
    try {
      const { env } = await mentionEvent('@argus fix')
      const code = await main(['mention'], {
        env: { ...env, GITHUB_REPOSITORY: 'a/b', GITHUB_TOKEN: 'tok' },
        out: () => {},
        err: () => {},
      })
      expect(code).toBe(0)
      expect(gh.replies[0]).toContain('no suggestions could be applied')
      expect(gh.replies[0]).toContain('src/a.ts')
      expect(gh.replies[0]).toContain('no longer on the diff')
      expect(gh.refPosts).toHaveLength(0)
    } finally {
      globalThis.fetch = original
    }
  })

  it('replies stale and opens no PR when the head moves mid-apply', async () => {
    const state = { headSha: HEAD, comments: [reviewComment()], fileContent: FILE_AT_HEAD }
    const gh = stubGitHub(state)
    let pullsCalls = 0
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/pulls/7')) {
        pullsCalls++
        if (pullsCalls > 1) state.headSha = 'n'.repeat(40)
      }
      return gh.fetch(input, init)
    }
    const original = globalThis.fetch
    globalThis.fetch = fetchStub
    try {
      const { env } = await mentionEvent('@argus fix')
      const code = await main(['mention'], {
        env: { ...env, GITHUB_REPOSITORY: 'a/b', GITHUB_TOKEN: 'tok' },
        out: () => {},
        err: () => {},
      })
      expect(code).toBe(0)
      expect(gh.replies[0]).toContain('head moved')
      expect(gh.prPosts).toHaveLength(0)
    } finally {
      globalThis.fetch = original
    }
  })
})
