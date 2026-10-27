/**
 * Plans, specs, RFCs and design docs describe intended state: a finding
 * that restates or second-guesses the plan ("R6 contradicts R4") is almost
 * never a defect in the change. Findings anchored in a plan/spec document
 * are capped at `nit` unless they cite a non-doc file from the diff (the
 * real bug is in code) or carry reproduced evidence — the same escape
 * hatches as `capTestFindings`. Ordinary docs (README, CHANGELOG,
 * quickstarts) are untouched.
 */
const DOC_EXT = /\.mdx?$/i;
const PLAN_DIR = /^(plans?|specs?|rfcs?|adrs?|brainstorms|proposals)$/i;
const PLAN_NAME = /-(plan|spec|rfc|design)\.mdx?$/i;
export function isPlanDocPath(path) {
    const p = path.replace(/^\.\//, '');
    if (!DOC_EXT.test(p))
        return false;
    const segs = p.split('/');
    const base = segs[segs.length - 1] ?? '';
    if (PLAN_NAME.test(base))
        return true;
    return segs.slice(0, -1).some((s) => PLAN_DIR.test(s));
}
const CAPPED = new Set(['bug', 'risk']);
export function capPlanDocFindings(findings, diffFiles) {
    const codeFiles = diffFiles.filter((p) => !isPlanDocPath(p));
    let capped = 0;
    const out = findings.map((f) => {
        if (!isPlanDocPath(f.file) || !CAPPED.has(f.severity))
            return f;
        if (f.evidence?.status === 'reproduced')
            return f;
        if (codeFiles.some((p) => f.message.includes(p)))
            return f;
        capped++;
        return { ...f, severity: 'nit' };
    });
    return { findings: out, capped };
}
