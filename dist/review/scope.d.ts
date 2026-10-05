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
/**
 * Per-path review rules (U6): resolve `review.instructions[]` against a
 * chunk's file set. A rule lands when its glob matches any file in the
 * chunk; a file matching two globs contributes both rules in entry order.
 */
export declare function rulesForFiles(instructions: readonly {
    glob: string;
    rule: string;
}[], files: readonly string[]): string[];
export declare function partitionByExclude<T extends {
    filename: string;
}>(files: T[], exclude: readonly string[]): {
    kept: T[];
    excluded: T[];
};
