/**
 * Review scope: which changed files reach the review model.
 *
 * Generated, fixture, golden and vendored paths carry content that reads
 * like code (sample manifests, rendered comments, lockfiles). Fed to the
 * model it produced findings about files that do not exist, so these
 * paths are excluded by default. `review.exclude` replaces the list.
 */
export const DEFAULT_REVIEW_EXCLUDE = [
    'dist/**',
    'fixtures/**',
    'tests/goldens/**',
    '**/package-lock.json',
    '**/npm-shrinkwrap.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/bun.lock',
    '**/Cargo.lock',
    '**/poetry.lock',
    '**/Gemfile.lock',
    '**/composer.lock',
    '**/go.sum',
    '**/*.generated.*',
    'assets/brand/export/**',
];
const globCache = new Map();
function globToRegExp(glob) {
    const cached = globCache.get(glob);
    if (cached !== undefined)
        return cached;
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**/` matches zero or more directories; a bare `**` matches anything.
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                }
                else {
                    re += '.*';
                    i += 1;
                }
            }
            else {
                re += '[^/]*';
            }
        }
        else if (c === '?') {
            re += '[^/]';
        }
        else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    const out = new RegExp(`^${re}$`);
    globCache.set(glob, out);
    return out;
}
export function globMatch(glob, path) {
    return globToRegExp(glob).test(path);
}
/**
 * Per-path review rules (U6): resolve `review.instructions[]` against a
 * chunk's file set. A rule lands when its glob matches any file in the
 * chunk; a file matching two globs contributes both rules in entry order.
 */
export function rulesForFiles(instructions, files) {
    const rules = [];
    for (const { glob, rule } of instructions) {
        if (files.some((f) => globMatch(glob, f)))
            rules.push(rule);
    }
    return rules;
}
export function partitionByExclude(files, exclude) {
    const kept = [];
    const excluded = [];
    for (const f of files) {
        if (exclude.some((g) => globMatch(g, f.filename)))
            excluded.push(f);
        else
            kept.push(f);
    }
    return { kept, excluded };
}
