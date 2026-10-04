import { maskSecrets, STATUS_GLYPH } from '../report/viewmodel.js';
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
export const ERROR_CODES = [
    'OPENROUTER_KEY_MISSING',
    'OPENROUTER_KEY_REJECTED',
    'OPENROUTER_OUT_OF_CREDIT',
    'OPENROUTER_RATE_LIMITED',
    'PROVIDER_UNAVAILABLE',
    'CONFIG_INVALID',
    'MANIFEST_UNREADABLE',
    'A0_UNREACHABLE',
    'USAGE',
    'COMMAND_FAILED',
    'INTERNAL',
];
export const ISSUE_URL = 'https://github.com/duketopceo/Argus/issues/new';
/** One-line summary per code. USAGE uses the error message itself. */
const TITLE = {
    OPENROUTER_KEY_MISSING: 'OpenRouter key missing',
    OPENROUTER_KEY_REJECTED: 'OpenRouter rejected the key',
    OPENROUTER_OUT_OF_CREDIT: 'OpenRouter key is out of credit',
    OPENROUTER_RATE_LIMITED: 'OpenRouter rate limit reached',
    PROVIDER_UNAVAILABLE: 'model provider unavailable',
    CONFIG_INVALID: 'config could not be loaded',
    MANIFEST_UNREADABLE: 'run manifest unreadable',
    A0_UNREACHABLE: 'Agent Zero unreachable',
    USAGE: 'usage error',
    COMMAND_FAILED: 'failed',
    INTERNAL: 'unexpected error (an Argus bug)',
};
const KEY_FIX = 'export OPENROUTER_API_KEY=sk-or-...';
/** Next action per code when the thrower does not supply one. `{cmd}` is the re-run command. */
const DEFAULT_FIX = {
    OPENROUTER_KEY_MISSING: KEY_FIX,
    OPENROUTER_KEY_REJECTED: KEY_FIX,
    OPENROUTER_OUT_OF_CREDIT: 'https://openrouter.ai/settings/credits',
    OPENROUTER_RATE_LIMITED: '{cmd}',
    PROVIDER_UNAVAILABLE: '{cmd}',
    CONFIG_INVALID: 'edit the config file named above; docs/quickstart.md lists every key',
    MANIFEST_UNREADABLE: 'argus-reviewer verify',
    A0_UNREACHABLE: 'argus-reviewer init',
    USAGE: 'argus-reviewer --help',
    COMMAND_FAILED: '{cmd} --debug',
    INTERNAL: ISSUE_URL,
};
export class CliError extends Error {
    code;
    fix;
    retryAfterSeconds;
    /** Diagnostics only: never printed in the human three-line form (R5). */
    httpStatus;
    constructor(code, message, opts = {}) {
        super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = 'CliError';
        this.code = code;
        this.fix = opts.fix;
        this.retryAfterSeconds = opts.retryAfterSeconds;
        this.httpStatus = opts.httpStatus;
    }
}
/** Seconds until the provider's rate limit resets, from the response headers. */
export function retryAfterSeconds(headers, now = Date.now()) {
    if (headers === undefined)
        return undefined;
    const ra = headers.get('retry-after');
    if (ra !== null && ra.trim() !== '') {
        const secs = Number(ra);
        if (Number.isFinite(secs) && secs >= 0)
            return Math.ceil(secs);
        const at = Date.parse(ra);
        if (Number.isFinite(at))
            return Math.max(0, Math.ceil((at - now) / 1000));
    }
    // OpenRouter's own header: epoch milliseconds of the reset.
    const reset = headers.get('x-ratelimit-reset');
    if (reset !== null && reset.trim() !== '') {
        const at = Number(reset);
        if (Number.isFinite(at) && at > 0)
            return Math.max(0, Math.ceil((at - now) / 1000));
    }
    return undefined;
}
/**
 * Map a failed provider response to its class. Statuses that are not a
 * provider or account condition (400, 404, 422) stay unclassified: they
 * are request bugs and surface through the caller's own handling.
 */
export function classifyHttpStatus(status, headers, now = Date.now(), provider = 'OpenRouter') {
    if (status === 401 || status === 403) {
        return new CliError('OPENROUTER_KEY_REJECTED', `${provider} did not accept OPENROUTER_API_KEY`, {
            httpStatus: status,
        });
    }
    if (status === 402) {
        return new CliError('OPENROUTER_OUT_OF_CREDIT', `${provider} reports no credit left on this key`, {
            httpStatus: status,
        });
    }
    if (status === 429) {
        const secs = retryAfterSeconds(headers, now);
        const when = secs !== undefined ? `resets in ${secs}s` : 'reset time not given; wait a minute';
        return new CliError('OPENROUTER_RATE_LIMITED', `${provider} is rate limiting this key; ${when}`, {
            httpStatus: status,
            ...(secs !== undefined ? { retryAfterSeconds: secs } : {}),
        });
    }
    if (status >= 500 && status <= 599) {
        return new CliError('PROVIDER_UNAVAILABLE', `${provider} or its upstream provider is down; see status.openrouter.ai`, {
            httpStatus: status,
        });
    }
    return undefined;
}
/** Order for collapsing several candidate failures into one: account problems first. */
const PROVIDER_PRIORITY = [
    'OPENROUTER_KEY_REJECTED',
    'OPENROUTER_OUT_OF_CREDIT',
    'OPENROUTER_RATE_LIMITED',
    'PROVIDER_UNAVAILABLE',
];
/** The most actionable classified error, or undefined unless every error is classified. */
export function pickProviderError(errors) {
    if (errors.length === 0 || !errors.every((e) => e instanceof CliError))
        return undefined;
    const classified = errors;
    for (const code of PROVIDER_PRIORITY) {
        const hit = classified.find((e) => e.code === code);
        if (hit !== undefined)
            return hit;
    }
    return classified[0];
}
/** Node's parseArgs rejections: usage errors, not bugs. */
function isParseArgsError(e) {
    const code = e?.code;
    return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS_');
}
/** Normalize anything thrown into a CliError; unknown errors become `fallback`. */
export function toCliError(e, fallback) {
    if (e instanceof CliError)
        return e;
    const code = e?.code;
    if (typeof code === 'string' && ERROR_CODES.includes(code)) {
        // A typed error from another layer (DecisionError) that carries a code.
        const err = e;
        return new CliError(code, err.message, {
            cause: e,
            ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
            ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
        });
    }
    if (isParseArgsError(e))
        return new CliError('USAGE', e.message, { cause: e });
    const message = e instanceof Error ? e.message : String(e);
    return new CliError(fallback, message, { cause: e });
}
/** Word-wrap `text` to `width` columns, each line prefixed with `indent`. */
function wrap(text, width, indent) {
    const room = Math.max(20, width - indent.length);
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/).filter((w) => w !== '')) {
        if (line !== '' && line.length + 1 + word.length > room) {
            lines.push(indent + line);
            line = word;
        }
        else {
            line = line === '' ? word : `${line} ${word}`;
        }
    }
    if (line !== '')
        lines.push(indent + line);
    return lines;
}
function facts(err, opts) {
    const cause = maskSecrets(err.message);
    const rerun = opts.rerun ?? 'argus-reviewer';
    let fix = (err.fix ?? DEFAULT_FIX[err.code]).replaceAll('{cmd}', rerun);
    if (err.code === 'OPENROUTER_RATE_LIMITED' && err.fix === undefined && err.retryAfterSeconds !== undefined) {
        fix = `sleep ${err.retryAfterSeconds} && ${rerun}`;
    }
    if (err.code === 'USAGE') {
        const help = opts.context !== undefined ? `argus-reviewer ${opts.context} --help` : 'argus-reviewer --help';
        return { code: err.code, summary: cause, cause: undefined, fix: err.fix ?? help };
    }
    const title = err.code === 'COMMAND_FAILED' ? `${opts.context ?? 'command'} failed` : TITLE[err.code];
    const summary = opts.context !== undefined && err.code !== 'COMMAND_FAILED' ? `${opts.context}: ${title}` : title;
    return { code: err.code, summary, cause, fix };
}
/** The human form: glyph + summary, cause, fix on its own line. */
export function renderError(err, style, opts = {}) {
    const f = facts(err, opts);
    const lines = [`${style.status('failed', STATUS_GLYPH.failed)} ${style.bold(f.summary)}`];
    if (f.cause !== undefined && f.cause !== '')
        lines.push(...wrap(f.cause, opts.width ?? 80, '  '));
    lines.push(`  ${style.role('accent', f.fix)}`);
    if (opts.debug === true) {
        if (err.httpStatus !== undefined)
            lines.push(style.dim(`  diagnostics: code ${err.code}, http ${err.httpStatus}`));
        const stack = (err.cause instanceof Error ? err.cause : err).stack;
        if (stack !== undefined)
            lines.push(style.dim(maskSecrets(stack)));
    }
    return lines;
}
/** The `--json` form: one line, one object, stable `code`. */
export function errorJson(err, opts = {}) {
    const f = facts(err, opts);
    const error = {
        code: f.code,
        summary: f.summary,
        ...(f.cause !== undefined ? { cause: f.cause } : {}),
        fix: f.fix,
    };
    if (err.retryAfterSeconds !== undefined)
        error.retryAfterSeconds = err.retryAfterSeconds;
    if (err.httpStatus !== undefined)
        error.httpStatus = err.httpStatus;
    if (err.code === 'INTERNAL')
        error.issue = ISSUE_URL;
    if (opts.debug === true) {
        const stack = (err.cause instanceof Error ? err.cause : err).stack;
        if (stack !== undefined)
            error.stack = maskSecrets(stack);
    }
    return JSON.stringify({ error });
}
