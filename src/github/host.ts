/**
 * GitHub host resolution (issue #23, GHE half): every API call, web link,
 * and git-auth header goes through one resolved pair of bases so the same
 * code path serves github.com and GitHub Enterprise Server.
 *
 * Resolution honors the runner-provided variables first —
 * `GITHUB_API_URL`/`GITHUB_SERVER_URL` are set by the runner on both
 * github.com and GHE — with `ARGUS_GITHUB_*` overrides for local or
 * non-runner invocations. An explicitly set but malformed value throws:
 * silently falling back to github.com would send a GHE token to the wrong
 * host, which is a credential leak, not a recovery.
 *
 * GitLab is a second adapter behind this seam, not part of this host
 * plumbing — its merge-request/discussion API differs from `pulls`, so it
 * needs operation-level adapters, not just a different base URL.
 */

export interface GitHost {
  /** REST API base, no trailing slash — `https://api.github.com` or `<ghe>/api/v3`. */
  apiBase: string
  /** Web base for links and git remotes — `https://github.com` or the GHE origin. */
  webBase: string
}

const GH_WEB = 'https://github.com'
const GH_API = 'https://api.github.com'
const GHE_API_SUFFIX = '/api/v3'

function hostUrl(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} is not a valid URL: ${JSON.stringify(value)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} must be an http(s) URL: ${JSON.stringify(value)}`)
  }
  return url.toString().replace(/\/+$/, '')
}

/** Derives the API base from a server (web) base: github.com is special; GHE appends /api/v3. */
function apiFromWeb(webBase: string): string {
  return webBase === GH_WEB ? GH_API : `${webBase}${GHE_API_SUFFIX}`
}

/** Derives the web base from an API base: strips /api/v3, maps api.github.com, else the origin. */
function webFromApi(apiBase: string): string {
  if (apiBase === GH_API) return GH_WEB
  if (apiBase.endsWith(GHE_API_SUFFIX)) return apiBase.slice(0, -GHE_API_SUFFIX.length)
  return new URL(apiBase).origin
}

export function resolveGitHost(env: Record<string, string | undefined> | undefined): GitHost {
  const apiRaw = env?.ARGUS_GITHUB_API_URL ?? env?.GITHUB_API_URL
  const webRaw = env?.ARGUS_GITHUB_SERVER_URL ?? env?.GITHUB_SERVER_URL
  const apiName = env?.ARGUS_GITHUB_API_URL !== undefined ? 'ARGUS_GITHUB_API_URL' : 'GITHUB_API_URL'
  const webName =
    env?.ARGUS_GITHUB_SERVER_URL !== undefined ? 'ARGUS_GITHUB_SERVER_URL' : 'GITHUB_SERVER_URL'
  const api = apiRaw !== undefined && apiRaw.trim() !== '' ? hostUrl(apiRaw.trim(), apiName) : undefined
  const web = webRaw !== undefined && webRaw.trim() !== '' ? hostUrl(webRaw.trim(), webName) : undefined
  return {
    apiBase: api ?? (web !== undefined ? apiFromWeb(web) : GH_API),
    webBase: web ?? (api !== undefined ? webFromApi(api) : GH_WEB),
  }
}

/** Git config key matching `actions/checkout`'s token header for this host. */
export function gitHeaderKey(host: GitHost): string {
  return `http.${host.webBase}/.extraheader`
}

/**
 * Env for `gh` subprocesses: `gh` defaults to github.com, so only a
 * non-default host needs `GH_HOST` exported. The runner does not set it.
 */
export function ghSubprocessEnv(webBase: string): Record<string, string> {
  try {
    const name = new URL(webBase).host
    return name === 'github.com' ? {} : { GH_HOST: name }
  } catch {
    return {}
  }
}
