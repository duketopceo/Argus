export interface JunitCase {
    name: string;
    className: string | undefined;
    durationMs: number;
    ok: boolean;
    failureMessage: string | undefined;
}
/** Render a JUnit XML report: one <testcase> per test with pass/fail + duration. */
export declare function renderJunitXml(suiteName: string, cases: JunitCase[]): string;
export declare function writeJunitXml(path: string, suiteName: string, cases: JunitCase[]): Promise<void>;
