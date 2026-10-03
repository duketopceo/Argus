import type { LaneStatus } from '../report/manifest.js';
/**
 * TTY-aware terminal styler (plan KTD5, DESIGN.md 7.7). No dependency: SGR
 * codes come from the ANSI-16 map that scripts/build-tokens.mjs writes to
 * assets/brand/ansi.json. That file is not shipped in the npm package, so
 * the codes are copied here and a unit test pins them to it.
 */
export type Role = 'ink' | 'ink-2' | 'ink-3' | 'accent' | 'passed' | 'failed' | 'caution';
export declare const ROLE_SGR: Record<Role, string>;
export declare const STATUS_SGR: Record<LaneStatus, string>;
export interface ColorInputs {
    env: Record<string, string | undefined>;
    isTTY: boolean;
    noColorFlag?: boolean;
}
/**
 * Precedence: `--no-color` and `NO_COLOR` beat `FORCE_COLOR`, which beats
 * TTY detection. GitHub Actions logs are not a TTY, so they get color only
 * through `FORCE_COLOR`. An empty `NO_COLOR` does not count (no-color.org),
 * and `FORCE_COLOR=0`/`false` forces nothing.
 */
export declare function colorEnabled({ env, isTTY, noColorFlag }: ColorInputs): boolean;
export interface Styler {
    readonly enabled: boolean;
    role: (role: Role, text: string) => string;
    status: (status: LaneStatus, text: string) => string;
    /** The status glyph, colored by status. */
    glyph: (status: LaneStatus) => string;
    bold: (text: string) => string;
    dim: (text: string) => string;
}
export declare function createStyler(enabled: boolean): Styler;
/** The styler for anything that must stay plain (files, JSON, tests). */
export declare const PLAIN: Styler;
