import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const vitestHarness = {
    kind: 'vitest',
    runCmd: (file) => ['node', 'node_modules/vitest/vitest.mjs', 'run', file],
    classify: ({ exitCode, stdout, stderr }) => {
        const out = `${stdout}\n${stderr}`;
        if (/no test files? found/i.test(out))
            return 'not-collected';
        if (/test files?\s+\d+ failed|tests\s+\d+ failed/i.test(out))
            return 'failed-test';
        return exitCode === 0 ? 'clean' : 'load-error';
    },
};
const jestHarness = {
    kind: 'jest',
    runCmd: (file) => [
        'node',
        'node_modules/jest-cli/bin/jest.js',
        '--runTestsByPath',
        '--cacheDirectory=/tmp/jest',
        file,
    ],
    classify: ({ exitCode, stdout, stderr }) => {
        const out = `${stdout}\n${stderr}`;
        if (/no tests found/i.test(out))
            return 'not-collected';
        if (/tests:\s+\d+ failed/i.test(out))
            return 'failed-test';
        return exitCode === 0 ? 'clean' : 'load-error';
    },
};
/**
 * `node --test` in a TS repo only works because `scripts.test` carries the
 * loader flags (`--import tsx`, `--experimental-strip-types`, `--loader`) —
 * capture them verbatim or the authored .ts probe dies with
 * ERR_UNKNOWN_FILE_EXTENSION.
 */
const NODE_TEST_FLAG_RE = /(--import|--loader)\s+\S+|--experimental-(?:strip|transform)-types/g;
function nodeTestHarness(flags) {
    return {
        kind: 'node-test',
        runCmd: (file) => ['node', ...flags, '--test', file],
        classify: ({ exitCode, stdout, stderr }) => {
            const out = `${stdout}\n${stderr}`;
            if (/^not ok/im.test(out))
                return 'failed-test';
            if (/ERR_UNKNOWN_FILE_EXTENSION|Cannot find module|SyntaxError/.test(out)) {
                return 'load-error';
            }
            return exitCode === 0 ? 'clean' : 'load-error';
        },
    };
}
/**
 * Detect the consumer's test harness from package.json. Returns undefined
 * when no supported harness exists — the probe lane degrades to a detail
 * note, not a failure.
 */
export async function detectHarness(cwd) {
    let pkg;
    try {
        pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    }
    catch {
        return undefined;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const testScript = pkg.scripts?.test ?? '';
    if (deps['vitest'] !== undefined || /\bvitest\b/.test(testScript))
        return vitestHarness;
    if (deps['jest'] !== undefined || /\bjest\b/.test(testScript))
        return jestHarness;
    if (/\bnode\b.*--test|node:test/.test(testScript)) {
        const flags = testScript.match(NODE_TEST_FLAG_RE)?.flatMap((f) => f.split(/\s+/)) ?? [];
        return nodeTestHarness(flags);
    }
    return undefined;
}
