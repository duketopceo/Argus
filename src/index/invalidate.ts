import { RepoIndex } from './scan.js'

/**
 * Diff-aware invalidation: a changed file that lies inside the app's source
 * surface (under sourceGlobs) marks the flow caches stale — the UI the tests
 * exercise may have shifted. Changes outside the surface (docs, CI config,
 * the e2e suite itself) invalidate nothing.
 *
 * v1 is deliberately flow-agnostic: tests are vision-driven and don't import
 * app source, so route→flow mapping isn't observable. The index powers the
 * dependency-cone check when source files are reached indirectly.
 */
export interface InvalidationResult {
  stale: boolean
  reason: string | undefined
  changedInSurface: string[]
}

function globToRegex(glob: string): RegExp {
  const re = glob
    .split('**')
    .map((seg) => seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*')
  return new RegExp(`^${re}$`)
}

/**
 * Expand `changed` to include files that *depend on* changed files — walk the
 * index's importedBy edges transitively. E.g. a change to a shared component
 * pulls in every page that imports it.
 */
export function dependentCone(index: RepoIndex, changed: string[]): Set<string> {
  const edges = new Map(index.entries.map((e) => [e.path, e.importedBy]))
  const out = new Set<string>()
  const queue = [...changed]
  while (queue.length > 0) {
    const cur = queue.pop()
    if (cur === undefined || out.has(cur)) continue
    out.add(cur)
    for (const dep of edges.get(cur) ?? []) queue.push(dep)
  }
  return out
}

/**
 * Decide whether the flow caches are stale. `sourceGlobs` names the app
 * surface the tests exercise (e.g. `ui/src/**`). When unset, any change in
 * the dependency cone of test/setup files also invalidates.
 */
export function invalidateForDiff(
  changed: string[],
  index: RepoIndex | undefined,
  sourceGlobs: string[] | undefined,
  testPaths: string[],
): InvalidationResult {
  if (changed.length === 0) return { stale: false, reason: undefined, changedInSurface: [] }

  const cone = index !== undefined ? dependentCone(index, changed) : new Set(changed)
  const inSurface = (p: string): boolean =>
    sourceGlobs !== undefined && sourceGlobs.some((g) => globToRegex(g).test(p))

  let hit: string[]
  if (sourceGlobs !== undefined && sourceGlobs.length > 0) {
    // A change lands on the app surface if the changed file itself matches,
    // or something in its dependent cone (files that import it) matches.
    hit = [...cone].filter((p) => inSurface(p) || changed.includes(p) && inSurface(p))
  } else {
    hit = [...cone].filter((p) => testPaths.includes(p))
  }

  if (hit.length === 0) {
    return { stale: false, reason: undefined, changedInSurface: [] }
  }
  return {
    stale: true,
    reason: `diff touched app surface: ${hit.slice(0, 5).join(', ')}${hit.length > 5 ? ` +${hit.length - 5} more` : ''}`,
    changedInSurface: hit,
  }
}
