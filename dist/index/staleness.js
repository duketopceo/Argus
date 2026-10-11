import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './scan.js';
export async function indexStaleness(index, 
/** Repo-relative paths under review (post-exclude). */
files, 
/** Checked-out tree the review ran against. */
cwd) {
    const byPath = new Map(index.entries.map((e) => [e.path.replace(/^\.\//, ''), e]));
    let checked = 0;
    let stale = 0;
    let missing = 0;
    // Sequential reads are fine — reviewed-file counts are in the hundreds
    // and each read is a single small file.
    for (const f of files) {
        const entry = byPath.get(f.replace(/^\.\//, ''));
        if (entry === undefined) {
            missing++;
            continue;
        }
        checked++;
        try {
            const buf = await readFile(join(cwd, f));
            if (sha256(buf) !== entry.contentHash)
                stale++;
        }
        catch {
            stale++;
        }
    }
    return { generatedAt: index.generatedAt, checked, stale, missing };
}
