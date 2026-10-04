/**
 * Review prompt packs (roadmap E1.U2): named rubric blocks appended to the
 * code-review prompt. Packs shape the rubric only — findings still flow
 * through the same severity gate, dedup, adjudication, and cap path, so a
 * pack can shift recall but cannot bypass posting policy.
 *
 * The `security` pack's deterministic half is the secrets lane
 * (`src/review/secrets.ts`) — regex candidates over the local merge-base
 * diff, adjudicated by the confidence model, masked in every output. It runs regardless of
 * profile selection; the rubric below additionally tunes the model toward
 * security-shaped defects.
 */
export const REVIEW_PROFILES = ['security', 'perf', 'debloat'];
export function isReviewProfile(value) {
    return REVIEW_PROFILES.includes(value);
}
const RUBRICS = {
    security: 'Security lens – additionally weigh: injection (SQL, shell, template, prompt), ' +
        'missing or bypassable authorization checks, unsafe deserialization, secret-shaped ' +
        'literals committed in the diff (report file/line and pattern class only – never ' +
        'reproduce the literal), weak or misused crypto, path traversal, SSRF, and ' +
        'unsanitized input reaching HTML or a shell. Only report a path actually ' +
        'exploitable from the changed code.',
    perf: 'Performance lens – additionally weigh: N+1 or per-item queries, work repeated ' +
        'inside loops that could hoist, accidental O(n^2) or worse on unbounded inputs, ' +
        'sync or blocking calls on hot paths, unnecessary copies or allocations of large ' +
        'structures, and missing pagination or bounds on data fetched. Cite the scaling ' +
        'input the cost depends on.',
    debloat: 'Debloat lens – additionally weigh: dead code added but never reachable, logic ' +
        'duplicating an existing helper visible in the diff or index context, dependencies ' +
        'or abstractions introduced for a single trivial use, commented-out code, and ' +
        'params/exports added without a caller. Do not flag removal opportunities that ' +
        'the diff itself already deletes.',
};
/**
 * Render the rubric section for the configured profiles. Returns undefined
 * when no valid profile is configured so the prompt stays byte-identical to
 * the no-packs form.
 */
export function packRubric(profiles) {
    if (profiles === undefined || profiles.length === 0)
        return undefined;
    const blocks = profiles.filter(isReviewProfile).map((p) => `- ${RUBRICS[p]}`);
    if (blocks.length === 0)
        return undefined;
    return `Active review lenses:\n${blocks.join('\n')}`;
}
