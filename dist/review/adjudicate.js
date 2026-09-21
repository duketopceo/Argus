import { debug } from '../debug.js';
import { DecisionError } from '../vision/decisions.js';
import { MAX_CANDIDATES } from './secrets.js';
/** Suppression is scoped to severities that never drive the verdict. */
const SUPPRESSIBLE = new Set(['nit', 'q']);
const MAX_PATCH_EXCERPT = 4000;
export async function adjudicateFindings(opts) {
    const capped = opts.findings.slice(0, MAX_CANDIDATES);
    const overflow = opts.findings.length - capped.length;
    const pByIdx = new Array(capped.length);
    let adjudicationFailed = false;
    if (capped.length > 0) {
        try {
            const questions = {};
            capped.forEach((_f, i) => {
                questions[`f_${i}`] = {
                    type: 'noul',
                    instructions: `state[${i}]: is this code-review finding a real problem the PR author ` +
                        'should act on? Answer no for speculative style nits, issues already ' +
                        'handled by guards visible in the patch, and findings that merely ' +
                        'restate what the code does.',
                };
            });
            const state = capped.map((f) => ({
                file: f.file,
                line: f.line,
                severity: f.severity,
                message: f.message,
                patch: opts.patchByFile?.get(f.file)?.slice(0, MAX_PATCH_EXCERPT),
            }));
            const { answers } = await opts.client.decide({
                ...(opts.model !== undefined ? { model: opts.model } : {}),
                state,
                questions,
            });
            capped.forEach((_f, i) => {
                const a = answers[`f_${i}`];
                pByIdx[i] = a !== undefined && 'noul' in a ? a.noul : undefined;
            });
        }
        catch (e) {
            adjudicationFailed = true;
            debug('adjudicate', `decision call failed — no suppression: ${e instanceof DecisionError ? e.kind : e.message}`);
        }
    }
    const findings = [];
    const records = [];
    capped.forEach((f, i) => {
        const p = pByIdx[i];
        const adjudicated = p !== undefined && !adjudicationFailed;
        const suppress = adjudicated && SUPPRESSIBLE.has(f.severity) && p < 1 - opts.threshold;
        records.push({
            file: f.file,
            ...(f.line !== undefined ? { line: f.line } : {}),
            severity: f.severity,
            adjudicated,
            ...(p !== undefined ? { p } : {}),
            ...(suppress ? { suppressed: true } : {}),
        });
        if (!suppress) {
            findings.push(p !== undefined ? { ...f, p } : f);
        }
    });
    // Overflow findings keep their place — never adjudicated, never
    // suppressed; count-only in the audit record like the secrets lane.
    for (const f of opts.findings.slice(MAX_CANDIDATES))
        findings.push(f);
    return {
        findings,
        records,
        overflow,
        ...(adjudicationFailed ? { unadjudicated: true } : {}),
    };
}
