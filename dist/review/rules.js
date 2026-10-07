import { addedLines, diffLines } from './difftext.js';
import { scanSecrets, } from './secrets.js';
import { isTestPath } from './testfiles.js';
/**
 * Post-runRules report assembly — shared by `code-review` and `scan` so
 * the secretsScan skipped-reason chain can't diverge between lanes:
 * a secrets-rule failure is distinct from "secrets rule not enabled".
 */
export function rulesLaneScans(result) {
    return {
        rulesScan: { ran: result.ran, records: result.records, failures: result.failures },
        secretsScan: result.secretsScan ??
            (result.ran.includes('secrets')
                ? { skipped: 'the secrets rule failed; see rulesScan.failures' }
                : result.ran.length === 0
                    ? { skipped: 'the rules lane is disabled (review.rules)' }
                    : { skipped: 'the secrets rule is not enabled (review.rules)' }),
    };
}
/** Per-rule hit cap — a formatter churning TODOs must not flood the report. */
export const RULE_HITS_CAP = 200;
/**
 * Per-rule audit-record bound — records stay complete for realistic
 * inputs; a pathological diff (generated churn) collapses past the cap
 * into one count-preserving aggregate record instead of an unbounded
 * report payload.
 */
export const RULE_RECORDS_CAP = 2000;
/**
 * Paths where a pattern hit is data or prose, not code — sample
 * manifests, docs, fixtures. Hits there are suppressed WITH a record
 * (the audit keeps them inspectable), never silently dropped.
 */
const DATA_PATH_RE = /(^|\/)(docs?|examples?|samples?|fixtures?|testdata|goldens?|__snapshots__)\/|\.(md|mdx|txt|rst|jsonc?|ya?ml|toml|lock|snap|golden|sample|example)$/i;
/** Script/eval dirs where sync IO is idiomatic — test paths ride isTestPath. */
const SCRIPT_PATH_RE = /(^|\/)(scripts?|evals?)\//i;
const isNonProdPath = (file) => isTestPath(file) || SCRIPT_PATH_RE.test(file);
/** Loopback/unspecified addresses — a hardcoded 127.0.0.1 is not a hit. */
const LOCAL_IP_RE = /^(?:127\.|0\.0\.0\.0$)/;
/**
 * Why a hit was suppressed — data/prose paths and non-production paths
 * (tests, scripts, evals) are different reasons and stay distinguishable
 * in the audit.
 */
const suppressedReason = (file) => DATA_PATH_RE.test(file)
    ? 'data/prose path'
    : isNonProdPath(file)
        ? 'non-production path'
        : undefined;
function secretRecord(r) {
    return {
        file: r.file,
        line: r.line,
        detail: r.patternClass,
        adjudicated: r.adjudicated,
        ...(r.pLive !== undefined ? { pLive: r.pLive } : {}),
        ...(r.suppressed === true ? { suppressed: 'below adjudication threshold' } : {}),
    };
}
const secretsRule = {
    id: 'secrets',
    description: 'secret-pattern scan, confidence-adjudicated when a decision client is wired',
    async run(diff, ctx) {
        const res = await scanSecrets({
            diff,
            ...(ctx.secretsThreshold !== undefined ? { threshold: ctx.secretsThreshold } : {}),
            ...(ctx.decisionClient !== undefined ? { client: ctx.decisionClient } : {}),
            ...(ctx.decisionModel !== undefined ? { model: ctx.decisionModel } : {}),
        });
        const records = res.records.map(secretRecord);
        if (res.overflow > 0) {
            records.push({
                file: '-',
                detail: `${res.overflow} candidate(s) over the adjudication cap`,
                suppressed: 'candidate-cap',
            });
        }
        return { findings: res.findings, records, secretsScan: res };
    },
};
// The `(?![\w.])` right boundary stops `127.0.0.1.evil.com` capturing
// `127.0.0.1` and suppressing as loopback — a dotted-quad-prefixed
// domain is a domain, not an IP literal.
const IP_URL_RE = /https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/;
const IP_ASSIGN_RE = /\b(?:host|addr|address|ip|endpoint|server|url|baseurl|base_url)\w*\s*[:=]\s*['"`]?(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/i;
const hardcodedEndpointRule = {
    id: 'hardcoded-endpoint',
    description: 'hardcoded URLs/IP literals added in code',
    run(diff) {
        const findings = [];
        const records = [];
        for (const { file, line, text } of addedLines(diff)) {
            const url = IP_URL_RE.exec(text);
            const m = url ?? IP_ASSIGN_RE.exec(text);
            if (m === null)
                continue;
            const detail = url !== null ? 'url-with-ip-host' : 'ip-literal-assignment';
            const suppressed = suppressedReason(file);
            if (suppressed !== undefined) {
                records.push({ file, line, detail, suppressed });
                continue;
            }
            if (LOCAL_IP_RE.test(m[1] ?? '')) {
                records.push({ file, line, detail, suppressed: 'loopback/unspecified host' });
                continue;
            }
            findings.push({
                file,
                line,
                severity: 'nit',
                category: 'security',
                message: `L${line}: nit: hardcoded endpoint (${detail}) added at \`${file}\` - ` +
                    'prefer config or secret injection over a literal address.',
            });
            records.push({ file, line, detail });
        }
        return { findings, records };
    },
};
const TODO_RE = /\b(?:TODO|FIXME|XXX|HACK)\b/;
const leftoverTodoRule = {
    id: 'leftover-todo',
    description: 'leftover TODO/FIXME/XXX/HACK markers in added lines',
    run(diff) {
        const findings = [];
        const records = [];
        for (const { file, line, text } of addedLines(diff)) {
            if (!TODO_RE.test(text))
                continue;
            // Only data/prose suppresses — TODOs in tests stay flagged
            // (skipped-coverage markers are real signal).
            if (DATA_PATH_RE.test(file)) {
                records.push({ file, line, detail: 'todo-marker', suppressed: 'data/prose path' });
                continue;
            }
            findings.push({
                file,
                line,
                severity: 'nit',
                category: 'convention',
                message: `L${line}: nit: leftover TODO/FIXME-style marker added at \`${file}\` - ` +
                    'resolve it or link a tracking issue.',
            });
            records.push({ file, line, detail: 'todo-marker' });
        }
        return { findings, records };
    },
};
const SYNC_CALL_RE = /\b(execSync|execFileSync|spawnSync|readFileSync|writeFileSync|appendFileSync|readdirSync|mkdirSync|rmSync)\s*\(/;
const syncInAsyncRule = {
    id: 'sync-in-async',
    description: 'synchronous fs/process calls added in code paths',
    run(diff) {
        const findings = [];
        const records = [];
        for (const { file, line, text } of addedLines(diff)) {
            const m = SYNC_CALL_RE.exec(text);
            if (m === null)
                continue;
            const call = m[1] ?? m[0];
            const suppressed = suppressedReason(file);
            if (suppressed !== undefined) {
                records.push({ file, line, detail: call, suppressed });
                continue;
            }
            findings.push({
                file,
                line,
                severity: 'nit',
                category: 'performance',
                message: `L${line}: nit: synchronous call \`${call}\` added at \`${file}\` - ` +
                    'it blocks the event loop; prefer the async variant.',
            });
            records.push({ file, line, detail: call });
        }
        return { findings, records };
    },
};
// --- U5 coverage rules -----------------------------------------------------
const MANIFEST_RE = /(^|\/)package\.json$/;
// package.json fails DATA_PATH_RE on its .json extension — dep-diff's
// suppression is dir-level only (fixture/example manifests are data).
const MANIFEST_DATA_RE = /(^|\/)(docs?|examples?|samples?|fixtures?|testdata)\//i;
const DEP_BLOCK_RE = /^(?:dev|peer|optional)?[Dd]ependencies$/;
const NAMED_BLOCK_RE = /^(\s*)"([^"]+)"\s*:\s*\{/;
const DEP_ENTRY_RE = /^\s*"([^"]+)"\s*:\s*"([^"]+)"/;
const CLOSE_RE = /^(\s*)\}/;
// Hunk context is ±3 lines — a dep added mid-block never shows the
// "dependencies": { opener. Outside a tracked block, entries count only
// when the value is a version spec (rejects script commands like
// "build": "esbuild ..." and metadata like "name": "app"). A wholesale-
// added overrides/engines block IS visible, so its entries are skipped
// by block tracking rather than reaching this fallback.
const VER_SPEC_RE = /^(?:\^|~|>=?|<=?|=)?v?\d+\.\d+\.\d+|^(?:workspace|npm|file|link|git\+|https?):/;
// URL/metadata fields whose values can look like specs in bare mode,
// plus runtime/tooling names an engines/volta block would pin.
const NON_DEP_KEYS = new Set([
    'version',
    'packageManager',
    'name',
    'repository',
    'homepage',
    'bugs',
    'funding',
    'url',
    'node',
    'npm',
    'pnpm',
    'yarn',
    'bun',
    'deno',
]);
// dep-diff needs kind-tagged hunk lines (block membership + removed
// entries) — the shared diffLines walker owns `@@` resets and header
// quirks so this rule never re-implements them.
/**
 * dep-diff (U5): new dependencies and major version jumps in package.json.
 * Supply-chain surface is reviewable signal — a new production dep or a
 * major bump is a real event, not an opinion. Minor/patch bumps are
 * audit-records only.
 */
const depDiffRule = {
    id: 'dep-diff',
    description: 'new dependencies and major version jumps in package.json diffs',
    run(diff) {
        const findings = [];
        const records = [];
        // Track the innermost named object block, not just dep blocks — a
        // wholesale-added overrides/engines/scripts block IS visible in the
        // hunk and must keep its entries out of the bare-version-spec path.
        let blockIndent = null;
        let blockIsDeps = false;
        const added = new Map();
        const removed = new Map();
        let file = '';
        const flush = () => {
            if (file === '' || (added.size === 0 && removed.size === 0)) {
                added.clear();
                removed.clear();
                return;
            }
            const suppressed = MANIFEST_DATA_RE.test(file)
                ? 'data/prose path'
                : isNonProdPath(file)
                    ? 'non-production path'
                    : undefined;
            for (const [name, { ver, line }] of added) {
                const oldVer = removed.get(name);
                const detail = oldVer === undefined ? `dependency-added ${name}@${ver}` : `version-jump ${name} ${oldVer}->${ver}`;
                if (suppressed !== undefined) {
                    records.push({ file, line, detail, suppressed });
                    continue;
                }
                const major = oldVer !== undefined &&
                    (oldVer.match(/\d+/)?.[0] ?? '') !== (ver.match(/\d+/)?.[0] ?? '');
                if (oldVer === undefined) {
                    findings.push({
                        file,
                        line,
                        severity: 'nit',
                        category: 'dependencies',
                        message: `L${line}: nit: new dependency \`${name}@${ver}\` added at \`${file}\` - ` +
                            'confirm source, license, and whether a lighter in-repo option exists.',
                    });
                    records.push({ file, line, detail });
                }
                else if (major) {
                    findings.push({
                        file,
                        line,
                        severity: 'nit',
                        category: 'dependencies',
                        message: `L${line}: nit: major version jump \`${name} ${oldVer} -> ${ver}\` at \`${file}\` - ` +
                            'check the migration notes before merge.',
                    });
                    records.push({ file, line, detail });
                }
                else {
                    records.push({ file, line, detail, suppressed: 'minor/patch bump' });
                }
            }
            added.clear();
            removed.clear();
        };
        let isManifest = false;
        let hunk = -1;
        for (const l of diffLines(diff)) {
            if (l.file !== file) {
                flush();
                file = l.file;
                blockIndent = null;
                blockIsDeps = false;
                isManifest = MANIFEST_RE.test(l.file);
            }
            if (!isManifest)
                continue;
            if (l.hunk !== hunk) {
                // Block state only tracks within a hunk's window — a `@@` jump
                // hides whether the opener it depended on still scopes here, so
                // entries fall back to the bare version-spec gate.
                hunk = l.hunk;
                blockIndent = null;
                blockIsDeps = false;
            }
            const close = CLOSE_RE.exec(l.text);
            if (close !== null && blockIndent !== null && close[1].length <= blockIndent) {
                blockIndent = null;
            }
            const open = NAMED_BLOCK_RE.exec(l.text);
            if (open !== null &&
                (blockIndent === null || open[1].length <= blockIndent)) {
                // Opener lines are never dep entries themselves.
                blockIndent = open[1].length;
                blockIsDeps = DEP_BLOCK_RE.test(open[2]);
                continue;
            }
            if (l.kind === 'ctx')
                continue;
            const entry = DEP_ENTRY_RE.exec(l.text);
            if (entry === null)
                continue;
            const name = entry[1];
            const ver = entry[2];
            if (blockIndent !== null && !blockIsDeps)
                continue;
            if (blockIndent === null && (NON_DEP_KEYS.has(name) || !VER_SPEC_RE.test(ver)))
                continue;
            if (l.kind === 'add')
                added.set(name, { ver, line: l.line });
            else
                removed.set(name, ver);
        }
        flush();
        return { findings, records };
    },
};
const CODE_FILE_RE = /\.(?:c|cc|cpp|cs|cts|go|h|hpp|java|jsx|kt|mjs|mts|php|py|rb|rs|scala|swift|ts|tsx)$/;
const GENERATED_FILE_RE = /(^|\/)dist\/|\.min\.|\.map$|\.generated\./i;
/**
 * missing-test (U5): a diff that changes source files but touches no test
 * file gets one file-level nit on its highest-churn source file. Precision
 * stays high because the event is factual (zero test paths in the diff);
 * the finding asks for evidence, not a mandate. One finding max — this is
 * a signal, not a per-file nag.
 */
const missingTestRule = {
    id: 'missing-test',
    description: 'source-only diffs that touch no test file get one file-level nit',
    run(diff) {
        let topFile = '';
        let topAdds = 0;
        const addsPerFile = new Map();
        let lastFile = '';
        let eligible = false;
        for (const { file } of addedLines(diff)) {
            if (file !== lastFile) {
                lastFile = file;
                // A test file anywhere in the diff kills the rule — exit before
                // spending per-line regex work on the rest.
                if (isTestPath(file))
                    return { findings: [], records: [] };
                eligible =
                    CODE_FILE_RE.test(file) &&
                        !DATA_PATH_RE.test(file) &&
                        !GENERATED_FILE_RE.test(file) &&
                        !SCRIPT_PATH_RE.test(file);
            }
            if (eligible)
                addsPerFile.set(file, (addsPerFile.get(file) ?? 0) + 1);
        }
        const srcFiles = addsPerFile.size;
        for (const [f, n] of addsPerFile) {
            if (n > topAdds) {
                topAdds = n;
                topFile = f;
            }
        }
        if (srcFiles === 0 || topFile === '') {
            return { findings: [], records: [] };
        }
        const detail = `source-only diff: ${srcFiles} source file(s), no test file`;
        return {
            findings: [
                {
                    file: topFile,
                    severity: 'nit',
                    category: 'testing',
                    message: `nit: this diff modifies ${srcFiles} source file(s) and no test file - ` +
                        'if the change is behavior-bearing, point at the coverage that exercises it.',
                },
            ],
            records: [{ file: topFile, detail }],
        };
    },
};
/** The rule registry — curated, not a plugin surface. */
export const REVIEW_RULES = [
    secretsRule,
    hardcodedEndpointRule,
    leftoverTodoRule,
    syncInAsyncRule,
    depDiffRule,
    missingTestRule,
];
/** All registered rule ids — the default `review.rules` enabled set. */
export const REVIEW_RULE_IDS = REVIEW_RULES.map((r) => r.id);
/**
 * Run the enabled rules over the materialized scan diff. Additive union
 * input for the review — output feeds report.rulesScan plus, for the
 * secrets rule, report.secretsScan (unchanged shape).
 */
export async function runRules(diff, opts = {}) {
    const registry = opts.rules ?? REVIEW_RULES;
    const enabled = opts.enabled ?? registry.map((r) => r.id);
    // Rules see only the context contract, never the runner's opts bag.
    const { enabled: _enabled, rules: _rules, ...ctx } = opts;
    const findings = [];
    const records = [];
    const failures = [];
    let secretsScan;
    const ran = [];
    const enabledRules = registry.filter((r) => enabled.includes(r.id));
    // Rules are independent — run them together so a secrets adjudication
    // network call overlaps the CPU-bound rules. Results merge in registry
    // order regardless of settle order.
    const settled = await Promise.allSettled(
    // Defer invocation into the promise so a synchronous `run` that throws
    // lands as a rejection instead of escaping the runner.
    enabledRules.map((r) => Promise.resolve().then(() => r.run(diff, ctx))));
    for (let i = 0; i < enabledRules.length; i++) {
        const rule = enabledRules[i];
        ran.push(rule.id);
        let out;
        const s = settled[i];
        try {
            if (s === undefined)
                throw new Error('rule settle slot missing');
            if (s.status === 'rejected')
                throw s.reason;
            out = s.value;
            // A malformed resolve escapes the contract — count it as a rule
            // failure inside the same boundary so the lane still completes.
            if (out === null ||
                typeof out !== 'object' ||
                !Array.isArray(out.findings) ||
                !Array.isArray(out.records)) {
                throw new Error('malformed RuleOutput (needs { findings, records })');
            }
        }
        catch (e) {
            // Failures are the audit channel for a throwing rule — no
            // double-record under `records`.
            failures.push({ rule: rule.id, error: e instanceof Error ? e.message : String(e) });
            continue;
        }
        if (out.secretsScan !== undefined)
            secretsScan = out.secretsScan;
        // Findings cap at RULE_HITS_CAP; records keep every hit up to
        // RULE_RECORDS_CAP, then collapse into a count-preserving aggregate.
        const overflow = Math.max(0, out.records.length - RULE_RECORDS_CAP);
        for (const r of out.records.slice(0, RULE_RECORDS_CAP)) {
            records.push({ ...r, rule: rule.id });
        }
        if (overflow > 0) {
            records.push({
                rule: rule.id,
                file: '-',
                detail: `${overflow} hit(s) over the ${RULE_RECORDS_CAP}-record cap`,
                suppressed: 'record-cap',
            });
        }
        // Severity ceiling + hit cap in one pass — records stay complete
        // (every hit is an audit entry) while findings bound the union.
        let emitted = 0;
        let over = 0;
        for (const f of out.findings) {
            let g = f;
            if (f.severity === 'bug' && f.p === undefined) {
                // A deterministic hit cannot claim `bug` without adjudicated
                // confidence riding on it. The `bug:` token inside the message
                // text must demote with the field — downstream readers derive
                // severity from that prefix.
                records.push({
                    rule: rule.id,
                    file: f.file,
                    ...(f.line !== undefined ? { line: f.line } : {}),
                    detail: 'unadjudicated bug claim',
                    suppressed: 'severity-ceiling',
                });
                g = { ...f, severity: 'risk', message: f.message.replace(/\bbug:/, 'risk:') };
            }
            if (emitted < RULE_HITS_CAP) {
                findings.push({ ...g, rule: rule.id });
                emitted++;
            }
            else {
                over++;
            }
        }
        if (over > 0) {
            findings.push({
                file: '-',
                severity: 'nit',
                message: `${rule.id}: ${over} further hit(s) over the ${RULE_HITS_CAP}-finding ` +
                    'cap; see rulesScan records for the full audit.',
            });
            records.push({
                rule: rule.id,
                file: '-',
                detail: `${over} finding(s) over cap`,
                suppressed: 'hit-cap',
            });
        }
    }
    return {
        findings,
        records,
        failures,
        ran,
        ...(secretsScan !== undefined ? { secretsScan } : {}),
    };
}
