import { ghGet, ghWrite } from '../evidence/ci.js';
const GH_API = 'https://api.github.com';
/**
 * Commit `files` to `branch` (created off `baseRef` or reused) and open one
 * PR. Idempotent: an existing branch is reused and an already-open PR on the
 * branch is returned rather than duplicated.
 */
export async function createFilesPr(opts, token, ctx) {
    const { repo, baseRef, branch, files, title, body, exists } = opts;
    const empty = { written: [], updated: [], skipped: [] };
    const base = (await ghGet(`${GH_API}/repos/${repo}/git/ref/heads/${baseRef}`, token, ctx));
    const baseSha = base?.object?.sha;
    if (typeof baseSha !== 'string') {
        return { ...empty, error: `couldn't resolve base ref ${baseRef}` };
    }
    const created = await ghWrite('POST', `${GH_API}/repos/${repo}/git/refs`, token, ctx, {
        ref: `refs/heads/${branch}`,
        sha: baseSha,
    });
    // 422 = ref already exists — reuse the branch (idempotent re-write).
    if (created.status !== 201 && created.status !== 422) {
        return { ...empty, error: `couldn't create branch ${branch} (github ${created.status})` };
    }
    const written = [];
    const updated = [];
    const skipped = [];
    for (const file of files) {
        let sha;
        if (exists === 'upsert') {
            const current = (await ghGet(`${GH_API}/repos/${repo}/contents/${encodeURIComponent(file.path)}?ref=${encodeURIComponent(branch)}`, token, ctx));
            sha = typeof current?.sha === 'string' ? current.sha : undefined;
        }
        const put = await ghWrite('PUT', `${GH_API}/repos/${repo}/contents/${encodeURIComponent(file.path)}`, token, ctx, {
            message: `${title}: ${file.path}`,
            content: Buffer.from(file.content, 'utf8').toString('base64'),
            branch,
            ...(sha !== undefined ? { sha } : {}),
        });
        if (put.status === 201 || put.status === 200) {
            ;
            (sha !== undefined ? updated : written).push(file.path);
        }
        else if (put.status === 422 && exists === 'create') {
            // File already exists on the branch — exclusive create honors the
            // never-overwrite contract.
            skipped.push(file.path);
        }
        else {
            return {
                written,
                updated,
                skipped,
                error: `couldn't write ${file.path} (github ${put.status})`,
            };
        }
    }
    const owner = repo.split('/')[0] ?? repo;
    const open = (await ghGet(`${GH_API}/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`, token, ctx));
    const existing = Array.isArray(open) ? open[0]?.html_url : undefined;
    if (typeof existing === 'string') {
        return { prUrl: existing, existing: true, written, updated, skipped };
    }
    const createdPr = await ghWrite('POST', `${GH_API}/repos/${repo}/pulls`, token, ctx, {
        title,
        head: branch,
        base: baseRef,
        body: typeof body === 'string' ? body : body({ written, updated, skipped }),
    });
    const url = createdPr.data?.html_url;
    if (createdPr.status !== 201 || typeof url !== 'string') {
        return {
            written,
            updated,
            skipped,
            error: `file(s) committed but PR open failed (github ${createdPr.status})`,
        };
    }
    return { prUrl: url, existing: false, written, updated, skipped };
}
