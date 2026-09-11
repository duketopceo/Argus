import { JournalEntry } from './schema.js';
export declare function journalDir(cacheDir: string): string;
/**
 * Append one immutable run record. Atomic via tmp+rename (src/fsutil.ts).
 * Returns the written path, or undefined on failure — a journal write must
 * never abort a run.
 */
export declare function writeJournal(cacheDir: string, entry: JournalEntry): Promise<string | undefined>;
/** runId: timestamp + short random suffix — sortable and collision-safe. */
export declare function newRunId(): string;
