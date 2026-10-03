import { STATUS_GLYPH } from '../report/viewmodel.js';
export const ROLE_SGR = {
    ink: '39',
    'ink-2': '39',
    'ink-3': '2',
    accent: '34',
    passed: '32',
    failed: '31',
    caution: '33',
};
export const STATUS_SGR = {
    passed: '32',
    failed: '31',
    inconclusive: '33',
    blocked: '1',
    unavailable: '2',
    skipped: '2',
};
/**
 * Precedence: `--no-color` and `NO_COLOR` beat `FORCE_COLOR`, which beats
 * TTY detection. GitHub Actions logs are not a TTY, so they get color only
 * through `FORCE_COLOR`. An empty `NO_COLOR` does not count (no-color.org),
 * and `FORCE_COLOR=0`/`false` forces nothing.
 */
export function colorEnabled({ env, isTTY, noColorFlag }) {
    if (noColorFlag === true)
        return false;
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '')
        return false;
    const force = env.FORCE_COLOR;
    if (force !== undefined && force !== '' && force !== '0' && force !== 'false')
        return true;
    return isTTY;
}
export function createStyler(enabled) {
    // '39' is the terminal default: wrapping it would only add noise.
    const sgr = (code, text) => !enabled || code === '39' || text === '' ? text : `\x1b[${code}m${text}\x1b[0m`;
    return {
        enabled,
        role: (role, text) => sgr(ROLE_SGR[role], text),
        status: (status, text) => sgr(STATUS_SGR[status], text),
        glyph: (status) => sgr(STATUS_SGR[status], STATUS_GLYPH[status]),
        bold: (text) => sgr('1', text),
        dim: (text) => sgr('2', text),
    };
}
/** The styler for anything that must stay plain (files, JSON, tests). */
export const PLAIN = createStyler(false);
