/**
 * Review scope: which changed files reach the review model.
 *
 * Generated, fixture, golden and vendored paths carry content that reads
 * like code (sample manifests, rendered comments, lockfiles). Fed to the
 * model it produced findings about files that do not exist, so these
 * paths are excluded by default. `review.exclude` replaces the list.
 */

export const DEFAULT_REVIEW_EXCLUDE: readonly string[] = [
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
]

const globCache = new Map<string, RegExp>()

function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached !== undefined) return cached
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  const out = new RegExp(`^${re}$`)
  globCache.set(glob, out)
  return out
}

export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path)
}

export function partitionByExclude<T extends { filename: string }>(
  files: T[],
  exclude: readonly string[],
): { kept: T[]; excluded: T[] } {
  const kept: T[] = []
  const excluded: T[] = []
  for (const f of files) {
    if (exclude.some((g) => globMatch(g, f.filename))) excluded.push(f)
    else kept.push(f)
  }
  return { kept, excluded }
}
