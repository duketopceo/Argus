import { createFilesPr } from '../github/write-pr.js';
import { isSafeRepoPath } from './queue.js';
export const PERSIST_MARKER = '<!-- argus-probe-persist ';
/** Keep the embedded payload well under GitHub's 65536-char comment cap. */
const PERSIST_MAX_PROBES = 3;
const PERSIST_CONTENT_CAP = 12 * 1024;
const PERSIST_PAYLOAD_CAP = 32 * 1024;
const B64_RE = /^[A-Za-z0-9+/=]+$/;
/** Reproduced probes carrying serialized content + a safe suggested path. */
export function selectPersistable(records) {
    if (!Array.isArray(records))
        return [];
    const out = [];
    for (const r of records) {
        if (out.length >= PERSIST_MAX_PROBES)
            break;
        if (r.outcome !== 'reproduced')
            continue;
        const { path, content } = r;
        if (typeof path !== 'string' ||
            typeof content !== 'string' ||
            content === '' ||
            content.length > PERSIST_CONTENT_CAP ||
            !isSafeRepoPath(path) ||
            // The write-side contract: persist only ever creates argus-probe-*
            // files — a crafted payload must not aim at an existing test.
            !path.split('/').pop()?.startsWith('argus-probe-')) {
            continue;
        }
        out.push({ path, content, file: r.file, findingFile: r.findingFile });
    }
    return out;
}
/**
 * Serialize the payload for the sticky comment — the full marker string,
 * or undefined when nothing persistable exists or the payload would bust
 * the cap (the copy-paste tier still renders probes that don't fit).
 */
export function encodeProbePayload(records, headSha) {
    const probes = selectPersistable(records);
    if (probes.length === 0)
        return undefined;
    const payload = JSON.stringify({
        v: 1,
        ...(headSha !== undefined ? { head: headSha } : {}),
        probes,
    });
    const b64 = Buffer.from(payload, 'utf8').toString('base64');
    if (b64.length > PERSIST_PAYLOAD_CAP)
        return undefined;
    return `${PERSIST_MARKER}${b64} -->`;
}
/**
 * Parse a sticky comment body back into probes. Strict: exactly one
 * marker, alphabet-checked base64, shaped JSON, and every entry through
 * the same selectPersistable validation — a hand-edited comment fails
 * closed to undefined rather than persisting attacker-controlled paths.
 */
export function decodeProbePayload(body) {
    const start = body.indexOf(PERSIST_MARKER);
    if (start === -1)
        return undefined;
    if (body.indexOf(PERSIST_MARKER, start + PERSIST_MARKER.length) !== -1)
        return undefined;
    const end = body.indexOf('-->', start + PERSIST_MARKER.length);
    if (end === -1)
        return undefined;
    const b64 = body.slice(start + PERSIST_MARKER.length, end).trim();
    if (b64.length > PERSIST_PAYLOAD_CAP || !B64_RE.test(b64))
        return undefined;
    let raw;
    try {
        raw = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    }
    catch {
        return undefined;
    }
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.probes)) {
        return undefined;
    }
    const r = raw;
    if (r.v !== 1)
        return undefined;
    // Re-run the records through the selector's validation by shape — the
    // payload must contain only what selectPersistable would emit.
    const probes = [];
    for (const p of r.probes.slice(0, PERSIST_MAX_PROBES)) {
        const c = p;
        if (typeof c !== 'object' ||
            c === null ||
            typeof c.path !== 'string' ||
            typeof c.content !== 'string' ||
            c.content === '' ||
            c.content.length > PERSIST_CONTENT_CAP ||
            !isSafeRepoPath(c.path) ||
            !c.path.split('/').pop()?.startsWith('argus-probe-')) {
            return undefined;
        }
        probes.push({
            path: c.path,
            content: c.content,
            file: typeof c.file === 'string' ? c.file : '(probe)',
            findingFile: typeof c.findingFile === 'string' ? c.findingFile : undefined,
        });
    }
    if (probes.length === 0)
        return undefined;
    return { head: typeof r.head === 'string' ? r.head : undefined, probes };
}
const PERSIST_BRANCH_PREFIX = 'argus/probe-regression-pr-';
/**
 * Commit persistable probes to `argus/probe-regression-pr-<pr>` and open a
 * regression-test PR against `baseRef`. Idempotent: an existing branch is
 * reused, an existing file is skipped (never overwritten — contents API
 * exclusive create), and an already-open PR on the branch is returned
 * rather than duplicated.
 */
export async function persistProbes(repo, pr, baseRef, probes, token, ctx) {
    const branch = `${PERSIST_BRANCH_PREFIX}${pr}`;
    const result = await createFilesPr({
        repo,
        baseRef,
        branch,
        files: probes.map((p) => ({ path: p.path, content: p.content })),
        title: `test: Argus reproduced-probe regression for #${pr}`,
        body: ({ written, skipped }) => `Argus reproduced blocking finding(s) on #${pr} with a sandbox probe ` +
            `(fails on head, clean on base). This PR commits the probe source as a ` +
            `regression test.\n\n` +
            `Files:\n${[...written.map((p) => `- \`${p}\` (new)`), ...skipped.map((p) => `- \`${p}\` (already present)`)].join('\n')}\n\n` +
            `**Warning:** Probe source is model-authored; review before merging. ` +
            `Generated by [argus-reviewer](https://github.com/duketopceo/argus-reviewer).`,
        exists: 'create',
    }, token, ctx);
    return {
        written: result.written,
        skipped: result.skipped,
        ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
        ...(result.error !== undefined
            ? {
                error: result.error.replace(/^file\(s\) committed/, 'probe file(s) committed'),
            }
            : {}),
    };
}
