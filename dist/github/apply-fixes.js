import { fetchFileContent, fetchPrMeta, fetchReviewComments, } from '../evidence/ci.js';
import { extractSuggestion, isArgusInlineBody, parseInlineBody, } from '../review/inline.js';
import { isOnDiff, rightSideLines } from '../review/validate.js';
import { createFilesPr } from './write-pr.js';
/**
 * `@argus fix` apply lane (U5). Applies every *posted, still-valid* inline
 * suggestion to a dedicated branch and opens one PR back onto the PR's head
 * branch.
 *
 * Trust model: suggestions come from review comments Argus itself posted
 * (`isArgusInlineBody`), re-read from the live API — never from a stored
 * report artifact a commenter could have edited. Each anchor is re-validated
 * against the CURRENT diff (`rightSideLines`/`isOnDiff` parity with the
 * poster), and each comment must be bound to the current head commit
 * (`commit_id === headSha`). The write branch forks at the exact head SHA
 * and the head is re-verified before the PR opens (TOCTOU).
 */
/** Largest suggestion span applied — a suggestion over this many lines is a
 *  rewrite, not a fix, and is skipped with a named reason. */
export const MAX_FIX_SPAN = 50;
/** Repo-relative path guard — suggestions come from API payloads, but the
 *  write path must never leave the tree anyway. */
function safePath(path) {
    return (path.length > 0 &&
        !path.startsWith('/') &&
        !path.split('/').includes('..') &&
        !path.includes('\0'));
}
/**
 * Apply posted inline suggestions for `pr` at `meta.headSha`. `files` is the
 * CURRENT `/pulls/{pr}/files` list (the anchor re-validation surface).
 */
export async function applyFixes(opts, token, ctx) {
    const { repo, pr, meta, files } = opts;
    const empty = { applied: [], skipped: [] };
    const headSha = meta.headSha;
    const headRef = meta.headRef;
    if (headSha === undefined || headRef === undefined) {
        return { ...empty, error: 'could not resolve the PR head' };
    }
    const comments = await fetchReviewComments(repo, pr, token, ctx);
    if (comments === undefined)
        return { ...empty, error: 'could not list review comments' };
    // Bound to comments posted at the current head — an older commit_id means
    // the suggestion was rendered against code that has since moved.
    const candidates = comments.filter((c) => c.commitId === headSha &&
        isArgusInlineBody(c.body) &&
        extractSuggestion(c.body) !== '' &&
        typeof c.path === 'string' &&
        typeof c.line === 'number');
    const diffLines = new Map();
    for (const f of files) {
        if (typeof f.patch === 'string')
            diffLines.set(f.filename, rightSideLines(f.patch));
    }
    const skipped = [];
    const byPath = new Map();
    for (const c of candidates) {
        const path = c.path;
        const startLine = c.startLine ?? c.line;
        const drop = (reason) => {
            skipped.push({ path, line: c.line, reason });
        };
        if (!safePath(path)) {
            drop('unsafe path');
            continue;
        }
        if (c.side === 'LEFT') {
            drop('anchor is on a removed (LEFT) line');
            continue;
        }
        if (!isOnDiff({ path, line: c.line, ...(c.startLine !== undefined ? { startLine } : {}) }, diffLines)) {
            drop('anchor no longer on the diff');
            continue;
        }
        if (c.line !== undefined && startLine > c.line) {
            drop('inverted line range');
            continue;
        }
        const span = c.line - startLine + 1;
        if (span > MAX_FIX_SPAN) {
            drop(`span exceeds ${MAX_FIX_SPAN} lines`);
            continue;
        }
        const parsed = parseInlineBody(c.body);
        const list = byPath.get(path) ?? [];
        list.push({
            comment: c,
            suggestion: extractSuggestion(c.body),
            startLine,
            message: parsed?.message ?? '',
            severity: parsed?.severity ?? 'other',
        });
        byPath.set(path, list);
    }
    if (byPath.size === 0) {
        return {
            applied: [],
            skipped,
            ...(skipped.length === 0
                ? { error: 'no applicable suggestions at the current head' }
                : {}),
        };
    }
    // Apply per file, descending line order so earlier edits never shift a
    // later suggestion's anchor. Overlapping spans keep the lower anchor.
    const applied = [];
    const writeFiles = [];
    for (const [path, suggestions] of byPath) {
        const content = await fetchFileContent(repo, path, headSha, token, ctx);
        if (content === undefined) {
            for (const s of suggestions) {
                skipped.push({ path, line: s.comment.line, reason: 'could not read file at head' });
            }
            continue;
        }
        const lines = content.split('\n');
        const ordered = [...suggestions].sort((a, b) => b.startLine - a.startLine);
        let occupiedTo = Number.POSITIVE_INFINITY; // lowest start of an applied span
        const fileApplied = [];
        for (const s of ordered) {
            const end = s.comment.line;
            if (end >= occupiedTo) {
                skipped.push({ path, line: end, reason: 'overlaps another suggestion' });
                continue;
            }
            if (end > lines.length) {
                skipped.push({ path, line: end, reason: 'line beyond file end' });
                continue;
            }
            const replaced = lines.slice(s.startLine - 1, end);
            lines.splice(s.startLine - 1, end - s.startLine + 1, ...s.suggestion.split('\n'));
            occupiedTo = s.startLine;
            fileApplied.push({
                path,
                startLine: s.startLine,
                line: end,
                message: s.message,
                severity: s.severity,
                replaced,
                replacement: s.suggestion,
                url: s.comment.htmlUrl,
            });
        }
        if (fileApplied.length === 0)
            continue;
        applied.push(...fileApplied.reverse()); // report in reading order
        writeFiles.push({ path, content: lines.join('\n') });
    }
    if (writeFiles.length === 0) {
        return { applied, skipped, error: 'no suggestions could be applied' };
    }
    const branch = `argus/fix-${pr}-${headSha.slice(0, 8)}`;
    const title = `argus: apply ${applied.length} suggestion${applied.length === 1 ? '' : 's'} from #${pr}`;
    const result = await createFilesPr({
        repo,
        baseRef: headRef,
        baseSha: headSha,
        branch,
        files: writeFiles,
        title,
        exists: 'upsert',
        preOpen: async () => {
            // TOCTOU: the head may have moved while we wrote. The branch is
            // bound to the exact reviewed SHA — if the head moved, don't open.
            const fresh = await fetchPrMeta(repo, pr, token, ctx);
            if (fresh?.headSha !== headSha)
                return 'the PR head moved during apply';
            return undefined;
        },
        body: () => {
            const hunks = applied
                .map((a) => {
                const span = a.startLine === a.line ? `L${a.line}` : `L${a.startLine}-L${a.line}`;
                const header = `### \`${a.path}\` ${span}${a.message !== '' ? ` - ${a.message}` : ''}`;
                const diff = [
                    ...a.replaced.map((l) => `-${l}`),
                    ...a.replacement.split('\n').map((l) => `+${l}`),
                ].join('\n');
                const src = a.url !== undefined ? `\n[source comment](${a.url})` : '';
                return `${header}\n\`\`\`diff\n${diff}\n\`\`\`${src}`;
            })
                .join('\n\n');
            const skippedList = skipped.length === 0
                ? ''
                : `\n\nSkipped ${skipped.length} suggestion${skipped.length === 1 ? '' : 's'}:\n${skipped
                    .map((s) => `- \`${s.path ?? '?'}\`${s.line !== undefined ? ` L${s.line}` : ''} - ${s.reason}`)
                    .join('\n')}`;
            return (`Applied ${applied.length} posted suggestion${applied.length === 1 ? '' : 's'} ` +
                `from Argus's review of #${pr} at \`${headSha.slice(0, 12)}\`.\n\n${hunks}${skippedList}\n\n` +
                `<!-- argus-reviewer:fix sha:${headSha} -->`);
        },
    }, token, ctx);
    if (result.error !== undefined) {
        return {
            applied,
            skipped,
            error: result.error,
            stale: result.error === 'the PR head moved during apply',
        };
    }
    return { applied, skipped, ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}) };
}
