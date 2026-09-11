import { TestReport } from '../report/run.js';
import { ErrorRecord, JournalEntry } from './schema.js';
/** Assemble the immutable run record — lives here so the schema mapping is owned by the journal module. */
export declare function buildJournalEntry(opts: {
    runId: string;
    repo: string;
    commitSha: string | undefined;
    branch: string | undefined;
    startedAt: Date;
    durationMs: number;
    reports: TestReport[];
    runErrors: ErrorRecord[];
    /** Overall run outcome — aborts before the first test must record ok:false. */
    ok?: boolean;
}): JournalEntry;
