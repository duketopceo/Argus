import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { writeAtomicJson } from '../fsutil.js';
export const INDEX_SCHEMA_VERSION = 1;
const EXCLUDE_DIRS = new Set([
    'node_modules', 'dist', 'dist-e2e-vision', '.git', 'coverage',
    '.vision-e2e-cache', '.argus-reviewer-cache', 'argus-reviewer-report', 'vision-e2e-report', 'journal',
]);
const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const LOCKFILE_RE = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock)$/;
const BINARY_RE = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|mp4|webm|pdf|zip|gz|tar|wasm|so|dylib|exe|bin)$/i;
const MAX_FILES = 50_000;
async function walk(root, dir, out) {
    if (out.length >= MAX_FILES)
        return;
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return; // unreadable/missing dirs are skipped, never fatal
    }
    for (const e of entries) {
        if (out.length >= MAX_FILES)
            return;
        if (e.name.startsWith('.') && e.name !== '.storybook')
            continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            if (EXCLUDE_DIRS.has(e.name))
                continue;
            await walk(root, p, out);
        }
        else if (e.isFile()) {
            if (LOCKFILE_RE.test(e.name) || BINARY_RE.test(e.name))
                continue;
            out.push(p);
        }
    }
}
function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}
/** Resolve an import specifier to a repo-relative path when it's local. */
function resolveImport(spec, fromFile, files) {
    if (!spec.startsWith('.'))
        return undefined;
    const base = resolve(dirname(fromFile), spec);
    const exts = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'];
    const candidates = [base, ...exts.map((e) => `${base}.${e}`), ...exts.map((e) => `${base}/index.${e}`)];
    for (const cand of candidates) {
        if (files.has(cand))
            return cand;
    }
    return undefined;
}
/** Memoized per directory — sibling files share the same ancestor walk. */
async function nearestPackageVersion(file, root, cache) {
    const start = dirname(file);
    const cached = cache.get(start);
    if (cached !== undefined)
        return cached;
    const promise = (async () => {
        let dir = start;
        // Path-boundary containment: `startsWith(root)` alone would accept a
        // sibling like `/repo-extra`; require an exact match or a subpath.
        while (dir === root || dir.startsWith(root + '/')) {
            try {
                const raw = await readFile(join(dir, 'package.json'), 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed.version)
                    return parsed.version;
            }
            catch {
                // no package.json at this level — keep walking up
            }
            if (dir === root)
                break;
            dir = dirname(dir);
        }
        return undefined;
    })();
    cache.set(start, promise);
    return promise;
}
function inferPurpose(source, isSource) {
    if (!isSource)
        return undefined;
    const doc = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
    if (doc) {
        const first = (doc[1] ?? '').split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean)[0];
        if (first !== undefined && first !== '')
            return first.slice(0, 160);
    }
    const exports_ = [...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+(\w+)/g)]
        .map((m) => m[1])
        .slice(0, 4);
    if (exports_.length > 0)
        return `exports: ${exports_.join(', ')}`;
    return undefined;
}
/** Scan a repo into a RepoIndex. Never throws on individual file failures. */
export async function scanRepo(root) {
    const abs = resolve(root);
    const files = [];
    await walk(abs, abs, files);
    const fileSet = new Set(files);
    const pkgCache = new Map();
    // Bounded concurrency — Promise.all over up to 50k files would exhaust
    // file descriptors. Chunks of 64 keep I/O saturated without EMFILE risk.
    const CONCURRENCY = 64;
    const sorted = files.sort();
    const entries = [];
    for (let i = 0; i < sorted.length; i += CONCURRENCY) {
        const chunk = sorted.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(chunk.map(async (file) => {
            const rel = relative(abs, file);
            let buf;
            try {
                buf = await readFile(file);
            }
            catch {
                return undefined; // unreadable files are skipped, never fatal
            }
            const isSource = SOURCE_RE.test(file);
            const text = isSource ? buf.toString('utf8') : undefined;
            const imports = [];
            if (isSource && text !== undefined) {
                try {
                    const info = ts.preProcessFile(text, true, true);
                    for (const spec of [...info.importedFiles.map((f) => f.fileName), ...info.referencedFiles.map((f) => f.fileName)]) {
                        const dep = resolveImport(spec, file, fileSet);
                        if (dep !== undefined)
                            imports.push(relative(abs, dep));
                    }
                }
                catch {
                    // unparseable file — entry still exists with empty imports
                }
            }
            const purpose = inferPurpose(text?.slice(0, 4000) ?? '', isSource);
            const packageVersion = await nearestPackageVersion(file, abs, pkgCache);
            const entry = { path: rel, imports, importedBy: [], contentHash: sha256(buf) };
            if (purpose !== undefined)
                entry.purpose = purpose;
            if (packageVersion !== undefined)
                entry.packageVersion = packageVersion;
            return entry;
        }));
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value !== undefined)
                entries.push(r.value);
        }
    }
    // Build reverse edges in a second pass — no shared-map races during the
    // parallel scan.
    const importedBy = new Map();
    for (const e of entries) {
        for (const dep of e.imports) {
            const list = importedBy.get(dep) ?? [];
            list.push(e.path);
            importedBy.set(dep, list);
        }
    }
    for (const e of entries) {
        e.importedBy = (importedBy.get(e.path) ?? []).sort();
        e.imports.sort();
    }
    return {
        schemaVersion: INDEX_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        root: abs,
        entries,
    };
}
export async function writeIndex(index, outPath) {
    await writeAtomicJson(outPath, index);
}
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
function isIndexEntry(v) {
    const e = v;
    return (typeof e === 'object' &&
        e !== null &&
        typeof e.path === 'string' &&
        Array.isArray(e.imports) &&
        Array.isArray(e.importedBy) &&
        typeof e.contentHash === 'string');
}
/** Load a previously written index; undefined when absent, oversized, or malformed. */
export async function readIndex(path) {
    try {
        const stat = await import('node:fs/promises').then((fs) => fs.stat(path));
        if (stat.size > MAX_INDEX_BYTES)
            return undefined;
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
            return undefined;
        }
        if (!parsed.entries.every(isIndexEntry))
            return undefined;
        return parsed;
    }
    catch {
        return undefined;
    }
}
