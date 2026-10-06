import { addedLines } from './difftext.js';
import { scanSecrets, } from './secrets.js';
import { isTestPath } from './testfiles.js';
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
/** The rule registry — curated, not a plugin surface. */
export const REVIEW_RULES = [
    secretsRule,
    hardcodedEndpointRule,
    leftoverTodoRule,
    syncInAsyncRule,
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
    for (const rule of registry) {
        if (!enabled.includes(rule.id))
            continue;
        ran.push(rule.id);
        let out;
        try {
            out = await rule.run(diff, ctx);
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
