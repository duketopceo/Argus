/**
 * Plans, specs, RFCs and design docs describe intended state: a finding
 * that restates or second-guesses the plan ("R6 contradicts R4") is almost
 * never a defect in the change. Findings anchored in a plan/spec document
 * are capped at `nit` unless they cite a non-doc file from the diff (the
 * real bug is in code) or carry reproduced evidence — the same escape
 * hatches as `capTestFindings`. Ordinary docs (README, CHANGELOG,
 * quickstarts) are untouched.
 */
export declare function isPlanDocPath(path: string): boolean;
export declare function capPlanDocFindings<T extends {
    file: string;
    severity: string;
    message: string;
    evidence?: {
        status?: string;
    };
}>(findings: T[], diffFiles: string[]): {
    findings: T[];
    capped: number;
};
