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
    apiBase: string;
    /** Web base for links and git remotes — `https://github.com` or the GHE origin. */
    webBase: string;
}
export declare function resolveGitHost(env: Record<string, string | undefined> | undefined): GitHost;
/** Git config key matching `actions/checkout`'s token header for this host. */
export declare function gitHeaderKey(host: GitHost): string;
/**
 * Env for `gh` subprocesses: `gh` defaults to github.com, so only a
 * non-default host needs `GH_HOST` exported. The runner does not set it.
 */
export declare function ghSubprocessEnv(webBase: string): Record<string, string>;
