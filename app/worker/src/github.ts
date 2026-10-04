import { redact } from './redact.js'

const API = 'https://api.github.com'

export class GitHubApiError extends Error {
  readonly status: number
  constructor(status: number, message: string, secrets: readonly (string | undefined)[] = []) {
    super(redact(message, secrets))
    this.name = 'GitHubApiError'
    this.status = status
  }
}

/** Thrown when the per-invocation subrequest budget is spent. */
export class SubrequestBudgetError extends Error {
  constructor() {
    super('subrequest budget exhausted')
    this.name = 'SubrequestBudgetError'
  }
}

export interface SubrequestBudget {
  readonly limit: number
  readonly used: number
  readonly remaining: number
  /** Wrap a fetch so every call counts (and is refused once the budget is gone). */
  wrap(f: typeof fetch): typeof fetch
}

/**
 * Counts outbound subrequests. Cloudflare's free plan allows 50 per
 * invocation; the limit passed here is the usable part of it. The hard stop
 * is a backstop: callers should gate on `remaining` before starting work.
 */
export function createBudget(limit: number): SubrequestBudget {
  let used = 0
  return {
    limit,
    get used() {
      return used
    },
    get remaining() {
      return Math.max(0, limit - used)
    },
    wrap(f) {
      return ((input: string | URL | Request, init?: RequestInit) => {
        if (used >= limit) throw new SubrequestBudgetError()
        used += 1
        return f(input, init)
      }) as typeof fetch
    },
  }
}

export interface GitHubResponse<T = unknown> {
  status: number
  data: T
}

export interface GitHubClient {
  /** Resolves for any status in `ok` (default 2xx); throws GitHubApiError otherwise. */
  request<T = unknown>(method: string, path: string, opts?: { body?: unknown; ok?: readonly number[] }): Promise<GitHubResponse<T>>
}

/**
 * Minimal REST client: one installation token, an injected fetch, redacted
 * errors. Error messages carry only the status and GitHub's short `message`
 * field, never request or response bodies.
 */
export function createGitHubClient(opts: { token: string; fetch: typeof fetch; secrets?: readonly (string | undefined)[] }): GitHubClient {
  const secrets = [opts.token, ...(opts.secrets ?? [])]
  return {
    async request<T>(method: string, path: string, o: { body?: unknown; ok?: readonly number[] } = {}) {
      let res: Response
      try {
        res = await opts.fetch(`${API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${opts.token}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'argus-app-worker',
            'x-github-api-version': '2022-11-28',
          },
          ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        })
      } catch (e) {
        if (e instanceof SubrequestBudgetError) throw e
        throw new GitHubApiError(0, `${method} request failed: ${e instanceof Error ? e.message : 'network error'}`, secrets)
      }
      const text = await res.text().catch(() => '')
      const okStatuses = o.ok
      const good = okStatuses ? okStatuses.includes(res.status) : res.status >= 200 && res.status < 300
      let data: unknown = undefined
      try {
        data = text ? JSON.parse(text) : undefined
      } catch {
        data = undefined
      }
      if (!good) {
        const m = (data as { message?: unknown } | undefined)?.message
        throw new GitHubApiError(res.status, `${method} returned ${res.status}${typeof m === 'string' ? `: ${m.slice(0, 200)}` : ''}`, secrets)
      }
      return { status: res.status, data: data as T }
    },
  }
}
