import { RepoIndex } from './scan.js';
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
    stale: boolean;
    reason: string | undefined;
    changedInSurface: string[];
}
/**
 * Expand `changed` to include files that *depend on* changed files — walk the
 * index's importedBy edges transitively. E.g. a change to a shared component
 * pulls in every page that imports it.
 */
export declare function dependentCone(index: RepoIndex, changed: string[]): Set<string>;
/**
 * Decide whether the flow caches are stale. `sourceGlobs` names the app
 * surface the tests exercise (e.g. `ui/src/**`). When unset, any change in
 * the dependency cone of test/setup files also invalidates.
 */
export declare function invalidateForDiff(changed: string[], index: RepoIndex | undefined, sourceGlobs: string[] | undefined, testPaths: string[]): InvalidationResult;
