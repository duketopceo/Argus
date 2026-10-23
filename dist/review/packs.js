/**
 * Review prompt packs (roadmap E1.U2 + competitive U10): named rubric blocks
 * appended to the code-review prompt. Packs shape the rubric only — findings
 * still flow through the same severity gate, dedup, adjudication, and cap
 * path, so a pack can shift recall but cannot bypass posting policy.
 *
 * The `security` pack's deterministic half is the secrets lane
 * (`src/review/secrets.ts`) — regex candidates over the local merge-base
 * diff, adjudicated by the confidence model, masked in every output. It runs regardless of
 * profile selection; the rubric below additionally tunes the model toward
 * security-shaped defects.
 *
 * Language packs (U10 / #154) auto-select from the chunk's file extensions
 * and stack under any configured profiles. `review.langPacks: false` (or
 * `ARGUS_REVIEW_LANG_PACKS=0`) disables them.
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
/** Language pack ids in stable declaration order (U10). */
export const LANG_PACK_IDS = ['ts', 'py', 'go', 'sql'];
export function isLangPackId(value) {
    return LANG_PACK_IDS.includes(value);
}
const LANG_RUBRICS = {
    ts: 'TypeScript/JavaScript lens – additionally weigh: unawaited promises, floating ' +
        'promises in event handlers, `any`/`as unknown as` leaks that erase safety at a ' +
        'boundary, missing null/undefined guards on optional chaining chains that throw, ' +
        'incorrect `this` binding, and race-prone shared mutable state across async tasks. ' +
        'Only report issues visible in the changed code.',
    py: 'Python lens – additionally weigh: mutable default arguments, bare `except:` / ' +
        'swallowed exceptions, missing context-manager closes on files/locks, ' +
        '`is` used for value equality, and path handling that mixes `str` with unsanitized ' +
        'user input. Only report issues visible in the changed code.',
    go: 'Go lens – additionally weigh: goroutine leaks (started without cancel/wait), ' +
        'unlocked mutex paths, ignored errors (`_ = err` on fallible calls), data races ' +
        'on shared maps/slices, and `defer` in loops that holds resources until return. ' +
        'Only report issues visible in the changed code.',
    sql: 'SQL lens – additionally weigh: injection via string-concatenated queries, ' +
        'missing transaction boundaries around multi-step writes, full-table scans on ' +
        'unbounded SELECT without LIMIT/WHERE, and destructive migrations without a ' +
        'rollback path. Only report issues visible in the changed code.',
};
/** Extension (lowercase, with dot) → language pack. */
const EXT_TO_LANG = {
    '.ts': 'ts',
    '.tsx': 'ts',
    '.js': 'ts',
    '.jsx': 'ts',
    '.mjs': 'ts',
    '.cjs': 'ts',
    '.py': 'py',
    '.go': 'go',
    '.sql': 'sql',
};
/**
 * Select language packs for a chunk from its file paths. Unknown extensions
 * contribute nothing. Order follows `LANG_PACK_IDS`.
 */
export function selectLangPacks(files) {
    const found = new Set();
    for (const file of files) {
        const base = file.includes('/') ? file.slice(file.lastIndexOf('/') + 1) : file;
        const dot = base.lastIndexOf('.');
        if (dot < 0)
            continue;
        const ext = base.slice(dot).toLowerCase();
        const id = EXT_TO_LANG[ext];
        if (id !== undefined)
            found.add(id);
    }
    return LANG_PACK_IDS.filter((id) => found.has(id));
}
/**
 * Render the rubric section for configured profiles and optional language
 * packs. Returns undefined when neither contributes a block so the prompt
 * stays byte-identical to the no-packs form.
 */
export function packRubric(profiles, langIds = undefined) {
    const parts = [];
    if (profiles !== undefined && profiles.length > 0) {
        const blocks = profiles.filter(isReviewProfile).map((p) => `- ${RUBRICS[p]}`);
        if (blocks.length > 0)
            parts.push(`Active review lenses:\n${blocks.join('\n')}`);
    }
    if (langIds !== undefined && langIds.length > 0) {
        const ordered = LANG_PACK_IDS.filter((id) => langIds.includes(id));
        const blocks = ordered.map((id) => `- ${LANG_RUBRICS[id]}`);
        if (blocks.length > 0)
            parts.push(`Active language lenses:\n${blocks.join('\n')}`);
    }
    if (parts.length === 0)
        return undefined;
    return parts.join('\n\n');
}
