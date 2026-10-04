/**
 * Test files describe expected behavior: a finding that restates an
 * assertion is almost never a defect. Findings anchored in a test file
 * are capped at `nit` unless they cite a non-test file from the diff
 * (the real bug is elsewhere) or carry reproduced evidence.
 */
export declare function isTestPath(path: string): boolean;
export declare function capTestFindings<T extends {
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
