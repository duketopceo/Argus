import { debug } from '../debug.js';
import { describeDecisionError, isNoulAnswer, MAX_CANDIDATES, } from '../vision/decisions.js';
/** P(grounded) below which a finding is dropped — conservative floor. */
const GROUNDED_FLOOR = 0.3;
const MAX_PATCH_EXCERPT = 4000;
/** Aggregate patch-state bound — 50 unique files x 4KB is still ~200KB. */
const MAX_PATCH_STATE_CHARS = 24_000;
/** Audit-record message bound — full text already lives in findings. */
const MAX_RECORD_MESSAGE = 300;
export async function reflectFindings(opts) {
    const capped = opts.findings.slice(0, MAX_CANDIDATES);
    const overflow = opts.findings.length - capped.length;
    const floor = opts.floor ?? GROUNDED_FLOOR;
    const groundedByIdx = new Array(capped.length);
    let reflectionFailed = false;
    if (capped.length > 0) {
        try {
            const questions = {};
            capped.forEach((_f, i) => {
                questions[`f_${i}`] = {
                    type: 'noul',
                    instructions: `state.findings[${i}]: is the claim in this code-review finding ` +
                        'actually supported by the patch under state.patches? Answer no ' +
                        'when the finding cites code or hunks absent from the patch, ' +
                        'misreads what the diff changes, or faults the diff for not ' +
                        'changing something it names but legitimately does not own.',
                };
            });
            // Patches keyed by file, sent once — same bounded-state shape as
            // adjudication; an aggregate bound caps the whole call.
            const patches = {};
            let patchBudget = MAX_PATCH_STATE_CHARS;
            for (const f of capped) {
                if (patchBudget <= 0)
                    break;
                if (patches[f.file] !== undefined)
                    continue;
                const p = opts.patchByFile?.get(f.file);
                if (p !== undefined) {
                    const excerpt = p.slice(0, Math.min(MAX_PATCH_EXCERPT, patchBudget));
                    patches[f.file] = excerpt;
                    patchBudget -= excerpt.length;
                }
            }
            const state = {
                findings: capped.map((f) => ({
                    file: f.file,
                    line: f.line,
                    severity: f.severity,
                    message: f.message,
                })),
                patches,
            };
            const { answers } = await opts.client.decide({
                ...(opts.model !== undefined ? { model: opts.model } : {}),
                state,
                questions,
            });
            capped.forEach((_f, i) => {
                const a = answers[`f_${i}`];
                groundedByIdx[i] = a !== undefined && isNoulAnswer(a) ? a.noul : undefined;
            });
        }
        catch (e) {
            reflectionFailed = true;
            debug('reflect', `decision call failed – nothing dropped: ${describeDecisionError(e)}`);
        }
    }
    const findings = [];
    const records = [];
    let dropped = 0;
    capped.forEach((f, i) => {
        const grounded = groundedByIdx[i];
        const checked = grounded !== undefined && !reflectionFailed;
        const drop = checked && grounded !== undefined && grounded < floor;
        records.push({
            file: f.file,
            ...(f.line !== undefined ? { line: f.line } : {}),
            severity: f.severity,
            message: f.message.slice(0, MAX_RECORD_MESSAGE),
            checked,
            ...(grounded !== undefined ? { grounded } : {}),
            ...(drop ? { dropped: true } : {}),
        });
        if (drop)
            dropped += 1;
        else
            findings.push(f);
    });
    // Overflow findings keep their place — never checked, never dropped.
    for (const f of opts.findings.slice(MAX_CANDIDATES))
        findings.push(f);
    return {
        findings,
        records,
        dropped,
        overflow,
        ...(reflectionFailed ? { unchecked: true } : {}),
    };
}
