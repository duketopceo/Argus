import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/**
 * Atomic text write via tmp+rename — the one place the pattern lives.
 * Callers: cache store, journal store, repo index, evidence report.
 */
export async function writeAtomicText(path, text) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
}
export async function writeAtomicJson(path, value, replacer) {
    await writeAtomicText(path, `${JSON.stringify(value, replacer, 2)}\n`);
}
