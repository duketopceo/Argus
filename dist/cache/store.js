import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomicJson } from '../fsutil.js';
export const FLOW_CACHE_SCHEMA_VERSION = 1;
function sortKeys(_, value) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
        return Object.fromEntries(entries);
    }
    return value;
}
export function flowPath(cacheDir, flowName) {
    return join(cacheDir, `${flowName}.json`);
}
export async function loadFlow(cacheDir, flowName) {
    const path = flowPath(cacheDir, flowName);
    try {
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return undefined;
        }
        const { schemaVersion, steps, asserts } = parsed;
        if (!Array.isArray(steps)) {
            return undefined;
        }
        if (schemaVersion !== undefined && schemaVersion !== FLOW_CACHE_SCHEMA_VERSION) {
            return undefined;
        }
        const out = {
            ...(schemaVersion === FLOW_CACHE_SCHEMA_VERSION ? { schemaVersion } : {}),
            steps: steps,
        };
        if (Array.isArray(asserts))
            out.asserts = asserts;
        return out;
    }
    catch (e) {
        const code = e.code;
        if (code === 'ENOENT') {
            return undefined;
        }
        throw e;
    }
}
export async function saveFlow(cacheDir, flowName, steps, asserts) {
    await writeAtomicJson(flowPath(cacheDir, flowName), { schemaVersion: FLOW_CACHE_SCHEMA_VERSION, steps, asserts: asserts ?? [] }, sortKeys);
}
