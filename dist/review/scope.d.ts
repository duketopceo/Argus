/**
 * Review scope: which changed files reach the review model.
 *
 * Generated, fixture, golden and vendored paths carry content that reads
 * like code (sample manifests, rendered comments, lockfiles). Fed to the
 * model it produced findings about files that do not exist, so these
 * paths are excluded by default. `review.exclude` replaces the list.
 */
export declare const DEFAULT_REVIEW_EXCLUDE: readonly string[];
export declare function globMatch(glob: string, path: string): boolean;
export declare function partitionByExclude<T extends {
    filename: string;
}>(files: T[], exclude: readonly string[]): {
    kept: T[];
    excluded: T[];
};
