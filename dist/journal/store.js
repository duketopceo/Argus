import { join } from 'node:path';
import { writeAtomicJson } from '../fsutil.js';
export function journalDir(cacheDir) {
    return join(cacheDir, 'journal');
}
/**
 * Append one immutable run record. Atomic via tmp+rename (src/fsutil.ts).
 * Returns the written path, or undefined on failure — a journal write must
 * never abort a run.
 */
export async function writeJournal(cacheDir, entry) {
    const path = join(journalDir(cacheDir), `${entry.runId}.json`);
    try {
        await writeAtomicJson(path, entry);
        return path;
    }
    catch {
        return undefined;
    }
}
/** runId: timestamp + short random suffix — sortable and collision-safe. */
export function newRunId() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
}
