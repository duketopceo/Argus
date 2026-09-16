import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * Load-failure signatures are checked BEFORE test-failure summaries — a
 * suite that can't import (vitest counts it as "Test Files 1 failed", TAP
 * emits "not ok") must never classify as failed-test, and the exit code
 * binds the result: probe output is attacker-printable, so a forged
 * "N failed" line on a clean exit still classifies clean.
 */
const LOAD_ERROR_RE = /Cannot find module|ERR_UNKNOWN_FILE_EXTENSION|ERR_MODULE_NOT_FOUND|Failed to load|SyntaxError/;
const vitestHarness = {
    kind: 'vitest',
    runCmd: (file) => ['node', 'node_modules/vitest/vitest.mjs', 'run', file],
    classify: ({ exitCode, stdout, stderr }) => {
        const out = `${stdout}\n${stderr}`;
        if (exitCode === 0)
            return 'clean';
        if (LOAD_ERROR_RE.test(out))
            return 'load-error';
        if (/no test files? found/i.test(out))
            return 'not-collected';
        if (/test files?\s+\d+ failed|tests\s+\d+ failed/i.test(out))
            return 'failed-test';
        return 'load-error';
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
        if (exitCode === 0)
            return 'clean';
        if (LOAD_ERROR_RE.test(out))
            return 'load-error';
        if (/no tests found/i.test(out))
            return 'not-collected';
        if (/tests:\s+\d+ failed/i.test(out))
            return 'failed-test';
        return 'load-error';
    },
};
/**
 * `node --test` in a TS repo only works because `scripts.test` carries the
 * loader flags (`--import tsx`, `--experimental-strip-types`, `--loader`) —
 * capture them verbatim or the authored .ts probe dies with
 * ERR_UNKNOWN_FILE_EXTENSION. Both `--import tsx` and `--import=tsx` forms.
 */
const NODE_TEST_FLAG_RE = /(?:--import|--loader)(?:[\s=])\S+|--experimental-(?:strip|transform)-types/g;
function nodeTestHarness(flags) {
    return {
        kind: 'node-test',
        // --test-reporter=tap pins the format `classify` parses — Node ≥22
        // defaults to the spec reporter (`✖`, not TAP `not ok`) when stdout
        // is a TTY, and real failures would fall through to load-error.
        runCmd: (file) => ['node', ...flags, '--test', '--test-reporter=tap', file],
        classify: ({ exitCode, stdout, stderr }) => {
            const out = `${stdout}\n${stderr}`;
            if (exitCode === 0)
                return 'clean';
            if (LOAD_ERROR_RE.test(out))
                return 'load-error';
            if (/^not ok/im.test(out))
                return 'failed-test';
            return 'load-error';
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
        const flags = testScript.match(NODE_TEST_FLAG_RE)?.flatMap((f) => f.split(/[\s=]+/)) ?? [];
        return nodeTestHarness(flags);
    }
    return undefined;
}
