import { scanSecrets, } from './secrets.js';
/** Per-rule hit cap — a formatter churning TODOs must not flood the report. */
export const RULE_HITS_CAP = 200;
/**
 * Iterate added (`+`) lines of a unified diff with post-change
 * coordinates. Same walk as `scanDiffForSecrets`: `+++`/`---` are file
 * headers only before the first `@@`; inside a hunk they are content.
 */
function addedLines(diff) {
    const out = [];
    let file = '';
    let newLine = 0;
    let inHunk = false;
    for (const raw of diff.split('\n')) {
        if (raw.startsWith('diff --git')) {
            inHunk = false;
            continue;
        }
        if (raw.startsWith('@@')) {
            inHunk = true;
            const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
            newLine = m !== null ? parseInt(m[1], 10) : 0;
            continue;
        }
        if (!inHunk) {
            if (raw.startsWith('+++ ')) {
                const m = /^\+\+\+ b\/(.+)$/.exec(raw);
                file = m?.[1] ?? '';
            }
            continue;
        }
        if (raw.startsWith(' ')) {
            newLine++;
            continue;
        }
        if (!raw.startsWith('+') || file === '')
            continue;
        out.push({ file, line: newLine, text: raw.slice(1) });
        newLine++;
    }
    return out;
}
/**
 * Paths where a pattern hit is data or prose, not code — sample
 * manifests, docs, fixtures. Hits there are suppressed WITH a record
 * (the audit keeps them inspectable), never silently dropped.
 */
const DATA_PATH_RE = /(^|\/)(docs?|examples?|samples?|fixtures?|testdata|goldens?|__snapshots__)\/|\.(md|mdx|txt|rst|jsonc?|ya?ml|toml|lock|snap|golden|sample|example)$/i;
/** Tests/scripts where sync IO and marker comments are idiomatic. */
const NON_PROD_PATH_RE = /(^|\/)(tests?|__tests__|e2e|scripts?|evals?)\/|\.(test|spec)\.[jt]sx?$/i;
/** Loopback/unspecified addresses — a hardcoded 127.0.0.1 is not a hit. */
const LOCAL_IP_RE = /^(?:127\.|0\.0\.0\.0$)/;
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
const IP_URL_RE = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/;
const IP_ASSIGN_RE = /\b(?:host|addr|address|ip|endpoint|server|url|baseurl|base_url)\w*\s*[:=]\s*['"`]?\d{1,3}(?:\.\d{1,3}){3}/i;
const hardcodedEndpointRule = {
    id: 'hardcoded-endpoint',
    description: 'hardcoded URLs/IP literals added in code',
    run(diff) {
        const findings = [];
        const records = [];
        for (const { file, line, text } of addedLines(diff)) {
            const m = IP_URL_RE.exec(text) ?? IP_ASSIGN_RE.exec(text);
            if (m === null)
                continue;
            const detail = IP_URL_RE.exec(text) !== null ? 'url-with-ip-host' : 'ip-literal-assignment';
            if (DATA_PATH_RE.test(file) || NON_PROD_PATH_RE.test(file)) {
                records.push({ file, line, detail, suppressed: 'non-code path' });
                continue;
            }
            if (LOCAL_IP_RE.test(/(\d{1,3}(?:\.\d{1,3}){3})/.exec(m[0])?.[1] ?? '')) {
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
            if (DATA_PATH_RE.test(file)) {
                records.push({ file, line, detail: 'todo-marker', suppressed: 'non-code path' });
                continue;
            }
            findings.push({
                file,
                line,
                severity: 'nit',
                category: 'maintainability',
                message: `L${line}: nit: leftover TODO/FIXME-style marker added at \`${file}\` - ` +
                    'resolve it or link a tracking issue.',
            });
            records.push({ file, line, detail: 'todo-marker' });
        }
        return { findings, records };
    },
};
const SYNC_CALL_RE = /\b(?:execSync|execFileSync|spawnSync|readFileSync|writeFileSync|appendFileSync|readdirSync|mkdirSync|rmSync)\s*\(/;
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
            if (DATA_PATH_RE.test(file) || NON_PROD_PATH_RE.test(file)) {
                records.push({ file, line, detail: m[0].replace(/\($/, ''), suppressed: 'non-production path' });
                continue;
            }
            findings.push({
                file,
                line,
                severity: 'nit',
                category: 'performance',
                message: `L${line}: nit: synchronous call \`${m[0].replace(/\($/, '')}\` added at \`${file}\` - ` +
                    'it blocks the event loop; prefer the async variant.',
            });
            records.push({ file, line, detail: m[0].replace(/\($/, '') });
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
    const enabled = opts.enabled ?? REVIEW_RULE_IDS;
    const findings = [];
    const records = [];
    const failures = [];
    let secretsScan;
    const ran = [];
    for (const rule of opts.rules ?? REVIEW_RULES) {
        if (!enabled.includes(rule.id))
            continue;
        ran.push(rule.id);
        let out;
        try {
            out = await rule.run(diff, opts);
        }
        catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            failures.push({ rule: rule.id, error });
            records.push({
                rule: rule.id,
                file: '-',
                detail: `rule threw: ${error.slice(0, 160)}`,
                suppressed: 'rule-error',
            });
            continue;
        }
        if (out.secretsScan !== undefined)
            secretsScan = out.secretsScan;
        for (const r of out.records)
            records.push({ rule: rule.id, ...r });
        const capped = [];
        for (const f of out.findings) {
            if (f.severity === 'bug' && f.p === undefined) {
                // Severity ceiling — a deterministic hit cannot claim `bug`
                // without adjudicated confidence riding on it.
                records.push({
                    rule: rule.id,
                    file: f.file,
                    ...(f.line !== undefined ? { line: f.line } : {}),
                    detail: 'unadjudicated bug claim',
                    suppressed: 'severity-ceiling',
                });
                capped.push({ ...f, severity: 'risk' });
            }
            else {
                capped.push(f);
            }
        }
        // Findings bound the union; records stay complete (every hit is an
        // audit entry) — over-cap findings collapse into one aggregate.
        if (capped.length > RULE_HITS_CAP) {
            const over = capped.length - RULE_HITS_CAP;
            findings.push(...capped.slice(0, RULE_HITS_CAP));
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
        else {
            findings.push(...capped);
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
