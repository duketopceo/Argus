/**
 * Test files describe expected behavior: a finding that restates an
 * assertion is almost never a defect. Findings anchored in a test file
 * are capped at `nit` unless they cite a non-test file from the diff
 * (the real bug is elsewhere) or carry reproduced evidence.
 */
export declare function isTestPath(path: string): boolean;
/**
 * testSiblingKey (U5): the stem-group key the test-sibling rule pairs
 * on — `src/foo.test.ts`, `src/__tests__/foo.ts`, `pkg/foo_test.go`, and
 * `src/foo.stories.ts` all share their source's key. The directory is
 * preserved: `tests/test_foo.py` never pairs with `pkg/foo.go`, so
 * mirror-tree layouts stay out of reach by design.
 */
export declare function testSiblingKey(path: string): string;
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
