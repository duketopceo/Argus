/**
 * Test-harness detection + result classification for the B.2 probe lane
 * (KTD3). v1 is deliberately Node-only: vitest, jest, and `node --test`.
 *
 * Two implementation details carry the weight:
 *  - Positional file args are *filters* intersected with the consumer's
 *    configured include/testMatch/roots, so probes must live where the
 *    runner already looks (the queue writes them beside an exemplar test).
 *  - Invocations bypass `npx` — as `nobody` on a read-only root there is no
 *    writable HOME, so the installed binary is invoked directly and each
 *    runner's cache is redirected into the /tmp tmpfs.
 */
export type ProbeOutcome = 'failed-test' | 'load-error' | 'not-collected' | 'clean';
export interface Harness {
    kind: 'vitest' | 'jest' | 'node-test';
    /** In-container argv running exactly one probe file (path relative to /work). */
    runCmd(probeRelPath: string): string[];
    /** Map captured output to the report vocabulary. */
    classify(res: {
        exitCode: number;
        stdout: string;
        stderr: string;
    }): ProbeOutcome;
}
/**
 * Detect the consumer's test harness from package.json. Returns undefined
 * when no supported harness exists — the probe lane degrades to a detail
 * note, not a failure.
 */
export declare function detectHarness(cwd: string): Promise<Harness | undefined>;
