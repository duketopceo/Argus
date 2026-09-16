import { PROBE_LABEL } from './gate.js';
const GH_API = 'https://api.github.com';
const MAX_CHECK_RUN_PAGES = 5;
async function ghGet(url, token, ctx) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
        if (!res.ok) {
            ctx.err(`evidence: github ${res.status} ${res.statusText} — ${url}`);
            return undefined;
        }
        return await res.json();
    }
    catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
            ctx.err(`evidence: github request timed out — ${url}`);
            return undefined;
        }
        throw e;
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * PR metadata for the evidence + probe lanes — the head SHA check-runs attach
 * to, plus the fork/association/label signals the sandbox fork gate (KTD5)
 * evaluates. One `/pulls/{pr}` request; undefined when the request fails.
 */
export async function fetchPrMeta(repo, pr, token, ctx) {
    const data = (await ghGet(`${GH_API}/repos/${repo}/pulls/${pr}`, token, ctx));
    if (data === undefined)
        return undefined;
    const labels = Array.isArray(data.labels)
        ? data.labels.map((l) => l?.name).filter((n) => typeof n === 'string')
        : [];
    const labelApprovedAt = labels.includes(PROBE_LABEL)
        ? await fetchLabelApprovedAt(repo, pr, token, ctx)
        : undefined;
    return {
        headSha: data.head?.sha,
        baseSha: data.base?.sha,
        // head.repo is null when the source fork was deleted — fail closed and
        // treat it as a fork so the probe gate still applies.
        isFork: data.head?.repo?.fork !== false,
        authorAssociation: typeof data.author_association === 'string' ? data.author_association : undefined,
        labels,
        pushedAt: data.head?.repo?.pushed_at,
        labelApprovedAt,
    };
}
/**
 * Newest `labeled` event for `argus-probe` on the PR's issue timeline. The
 * label on the payload proves it's currently applied; the event timestamp is
 * what binds approval to the current head (a `synchronize` push after the
 * label must not inherit it). One extra request, only when the label exists.
 */
async function fetchLabelApprovedAt(repo, pr, token, ctx) {
    const events = (await ghGet(
    // per_page=100 widens the single allowed call — the timeline endpoint
    // pages oldest-first, so a tiny page can miss the newest labeled event.
    `${GH_API}/repos/${repo}/issues/${pr}/timeline?per_page=100`, token, ctx));
    if (!Array.isArray(events))
        return undefined;
    let latest;
    for (const e of events) {
        if (e?.event === 'labeled' && e.label?.name === PROBE_LABEL && typeof e.created_at === 'string') {
            if (latest === undefined || e.created_at > latest)
                latest = e.created_at;
        }
    }
    return latest;
}
/** Check-runs on a commit — the consumer's own CI signal. */
export async function fetchCheckRuns(repo, sha, token, ctx) {
    const runs = [];
    let page = 1;
    while (page <= MAX_CHECK_RUN_PAGES) {
        const data = (await ghGet(`${GH_API}/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`, token, ctx));
        if (data === undefined || !Array.isArray(data.check_runs))
            return undefined;
        for (const r of data.check_runs) {
            const cr = r;
            if (typeof cr.name !== 'string')
                continue;
            runs.push({
                name: cr.name,
                conclusion: cr.conclusion ?? undefined,
                completed: cr.status === 'completed',
                url: typeof cr.html_url === 'string' ? cr.html_url : undefined,
            });
        }
        if (data.check_runs.length < 100)
            break;
        page++;
    }
    return runs;
}
