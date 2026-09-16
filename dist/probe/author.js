/**
 * Probe authoring (KTD7): one bounded model call per `not_exercised`
 * finding produces a single test file asserting the *correct* behavior —
 * so the defect's presence fails the test on head while the base checkout
 * passes. The file is written on the HOST (inside the ro workspace mount),
 * so `filename` and `content` are validated hard: the model's input includes
 * PR-controlled file contents, and a prompt-injected traversal or secret
 * read would escape the sandbox's whole purpose.
 */
export const PROBE_SCHEMA = {
    name: 'argus-probe',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            filename: {
                type: 'string',
                description: 'Bare test filename matching the repo convention, e.g. probe-xyz.test.ts',
            },
            content: { type: 'string', description: 'Complete test file contents' },
            reasoning: { type: 'string' },
        },
        required: ['filename', 'content', 'reasoning'],
        additionalProperties: false,
    },
};
/**
 * Basename-only, forced test extension — no separators, no `..`. The write
 * happens on the host, so this is the traversal boundary.
 */
export const PROBE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.test\.[jt]sx?$/;
/** Probe files are bounded — a runaway generation is rejected, not truncated. */
export const PROBE_CONTENT_CAP = 32 * 1024;
/** Reads of secret-looking env vars are forbidden — defense in depth on the stripped container env. */
const SECRET_ENV_RE = /process\.env\s*(?:\.|\[)\s*['"]?\w*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;
/** Only relative repo paths and packages that could plausibly be installed devDeps. */
const IMPORT_RE = /(?:from\s+|import\s*\(|require\()\s*['"]([^'"]+)['"]/g;
export function parseProbe(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, reason: 'unparseable model response' };
    }
    if (typeof parsed.filename !== 'string' || !PROBE_FILENAME_RE.test(parsed.filename)) {
        return { ok: false, reason: `unsafe filename: ${String(parsed.filename)}` };
    }
    if (typeof parsed.content !== 'string' || parsed.content.trim() === '') {
        return { ok: false, reason: 'missing or empty content' };
    }
    if (parsed.content.length > PROBE_CONTENT_CAP) {
        return { ok: false, reason: `content exceeds ${PROBE_CONTENT_CAP} bytes` };
    }
    if (SECRET_ENV_RE.test(parsed.content)) {
        return { ok: false, reason: 'probe reads secret-looking env vars' };
    }
    for (const m of parsed.content.matchAll(IMPORT_RE)) {
        const spec = m[1];
        if (spec === undefined)
            continue;
        // Relative imports must stay inside the repo (no absolute paths).
        if (spec.startsWith('/') || /^[a-zA-Z]:/.test(spec)) {
            return { ok: false, reason: `absolute import: ${spec}` };
        }
    }
    return {
        ok: true,
        probe: {
            filename: parsed.filename,
            content: parsed.content,
            reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
        },
    };
}
export function buildProbeMessages(target, fileContents, exemplarTest, harness) {
    const exemplar = exemplarTest === undefined
        ? '(no existing test file was available as an exemplar — follow standard idiom)'
        : `Exemplar test file (${exemplarTest.path}) — match its imports, naming, and assertion style:\n\n${exemplarTest.content}`;
    const implicated = fileContents === undefined
        ? `(file contents unavailable; the finding references ${target.file ?? 'unknown'})`
        : `Contents of ${target.file}:\n\n${fileContents}`;
    return [
        {
            role: 'system',
            content: [
                {
                    type: 'text',
                    text: `You author a single failing test — a "probe" — that reproduces a suspected defect ` +
                        `found by code review. The probe runs under ${harness.kind} in an offline sandbox. ` +
                        `Write a self-contained ${harness.kind} test that asserts the CORRECT behavior: if the ` +
                        `defect is real, the test fails; if the code is fine, it passes. Import only repo ` +
                        `modules via relative paths and packages the repo already uses. No network, no ` +
                        `filesystem outside the repo, no timers, no process.env reads. filename must be a ` +
                        `bare filename ending in .test.ts/.test.js matching the exemplar's convention.`,
                },
            ],
        },
        {
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: `Finding (${target.severity}) in ${target.file ?? 'unknown'}${target.line ? `:${target.line}` : ''}:\n` +
                        `${target.message}\n\n${implicated}\n\n${exemplar}`,
                },
            ],
        },
    ];
}
