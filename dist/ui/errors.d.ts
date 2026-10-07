import type { Styler } from './style.js';
/**
 * CLI error grammar (R14, R15). Every error renders as three lines: the
 * failed glyph with a one-line summary, the cause, and the next action on a
 * line of its own so it can be copied. `--json` prints the same facts as one
 * JSON object with a stable `code`.
 *
 * The codes are a closed set and part of the public CLI contract
 * (docs/quickstart.md). Numeric exit codes are separate and unchanged: the
 * call site that reports an error still decides the exit code.
 */
export declare const ERROR_CODES: readonly ["OPENROUTER_KEY_MISSING", "OPENROUTER_KEY_REJECTED", "OPENROUTER_OUT_OF_CREDIT", "OPENROUTER_RATE_LIMITED", "PROVIDER_UNAVAILABLE", "CONFIG_INVALID", "MANIFEST_UNREADABLE", "A0_UNREACHABLE", "USAGE", "COMMAND_FAILED", "INTERNAL"];
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface CliErrorOptions {
    fix?: string;
    retryAfterSeconds?: number;
    httpStatus?: number;
    cause?: unknown;
}
export declare class CliError extends Error {
    readonly code: ErrorCode;
    readonly fix: string | undefined;
    readonly retryAfterSeconds: number | undefined;
    /** Diagnostics only: never printed in the human three-line form (R5). */
    readonly httpStatus: number | undefined;
    constructor(code: ErrorCode, message: string, opts?: CliErrorOptions);
}
/**
 * Map a failed provider response to its class. Statuses that are not a
 * provider or account condition (400, 404, 422) stay unclassified: they
 * are request bugs and surface through the caller's own handling.
 */
export declare function classifyHttpStatus(status: number, headers?: Headers, now?: number, provider?: string): CliError | undefined;
/** The most actionable classified error, or undefined unless every error is classified. */
export declare function pickProviderError(errors: readonly unknown[]): CliError | undefined;
/** Normalize anything thrown into a CliError; unknown errors become `fallback`. */
export declare function toCliError(e: unknown, fallback: ErrorCode): CliError;
export interface RenderOptions {
    /** Command name for the summary line ("run", "code-review"). */
    context?: string | undefined;
    /** The command to re-run, substituted for `{cmd}` in a fix. */
    rerun?: string | undefined;
    /** Include the stack (INTERNAL) and diagnostics. */
    debug?: boolean | undefined;
    /** Terminal width: the cause line wraps to it (default 80). */
    width?: number | undefined;
}
/** The human form: glyph + summary, cause, fix on its own line. */
export declare function renderError(err: CliError, style: Styler, opts?: RenderOptions): string[];
/** The `--json` form: one line, one object, stable `code`. */
export declare function errorJson(err: CliError, opts?: RenderOptions): string;
