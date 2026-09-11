/**
 * Journal schema — one append-only record per run. Evidence store, not logs:
 * every error and non-fatal recovery is a structured entry so failure modes
 * can be analyzed across runs.
 */
export const JOURNAL_SCHEMA_VERSION = 1;
