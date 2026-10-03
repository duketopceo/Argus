/**
 * Deterministic finding validation (no model). A finding must point at a
 * file that is in the reviewed diff and at a line inside the diff's
 * changed hunks (plus a small context tolerance). Anything else is a
 * hallucinated or stale anchor; it is dropped here and counted in the
 * report so the drop is never silent.
 */
/** Lines of slack around a hunk: models are often off by a line or two. */
export const HUNK_TOLERANCE = 2;
const MAX_EXAMPLES = 10;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
export function parseHunks(patch) {
    const ranges = [];
    let newFileLength;
    let sawHunk = false;
    for (const line of patch.split('\n')) {
        const m = HUNK_HEADER.exec(line);
        if (m === null)
            continue;
        sawHunk = true;
        const oldStart = Number(m[1]);
        const oldCount = m[2] === undefined ? 1 : Number(m[2]);
        const start = Number(m[3]);
        const count = m[4] === undefined ? 1 : Number(m[4]);
        if (count > 0)
            ranges.push([start, start + count - 1]);
        if (oldStart === 0 && oldCount === 0)
            newFileLength = count;
    }
    return {
        ranges,
        ...(newFileLength !== undefined ? { newFileLength } : {}),
        deleted: sawHunk && ranges.length === 0,
    };
}
const norm = (p) => p.replace(/^\.\//, '');
export function validateFindings(findings, files, excluded = new Set()) {
    const byName = new Map();
    for (const f of files)
        byName.set(f.filename, parseHunks(f.patch ?? ''));
    const kept = [];
    const dropped = [];
    for (const f of findings) {
        const file = norm(String(f.file ?? ''));
        const hunks = byName.get(file);
        const hasLine = typeof f.line === 'number' && Number.isFinite(f.line);
        const drop = (reason) => {
            dropped.push({ file: String(f.file), ...(hasLine ? { line: f.line } : {}), reason });
        };
        if (hunks === undefined) {
            drop(excluded.has(file) ? 'file_excluded' : 'file_not_in_diff');
        }
        else if (hunks.deleted) {
            drop('file_deleted');
        }
        else if (!hasLine) {
            kept.push(f);
        }
        else if (hunks.newFileLength !== undefined && f.line > hunks.newFileLength) {
            drop('line_beyond_file');
        }
        else if (!hunks.ranges.some(([s, e]) => f.line >= s - HUNK_TOLERANCE && f.line <= e + HUNK_TOLERANCE)) {
            drop('line_outside_diff');
        }
        else {
            kept.push(f);
        }
    }
    return { kept, dropped };
}
export function auditOf(dropped) {
    const byReason = {};
    for (const d of dropped)
        byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
    return { dropped: dropped.length, byReason, examples: dropped.slice(0, MAX_EXAMPLES) };
}
