import { Message } from '../vision/openrouter.js';
import { type Ctx, type CliDeps } from './shared.js';
export declare const SCAN_USAGE = "Usage: argus-reviewer scan [path] [options]\n\n\nAudits a tree with no PR: walks the tree (dotfiles, VCS internals, lockfiles\nand binaries excluded), synthesizes a unified diff, and runs the\ndeterministic rules + secrets lanes over it. Writes scan-report.json.\n\nOptions:\n  [path]             Directory to audit (default: .)\n  --base <ref>       Audit 'git diff <ref>..worktree' instead of the whole tree\n  --model            Add model findings over the same exclusion contract\n  --report-dir <dir> Report output dir (default: config reportDir or ./argus-reviewer-report)\n  -h, --help         Show this help\n\nSpend is $0 unless --model is passed. Credential-shaped dotfiles (.env,\n.netrc, ...) are scanned locally by the secrets lane but never reach model\ncontext; dot-directories stay excluded.";
/**
 * Credential-shaped paths are excluded from MODEL context only — the
 * deterministic secrets lane scans them locally (that is its purpose),
 * but their contents must never leave the machine. Covers env/key/cert
 * containers, key-file suffixes, prefixed credential names, and the
 * canonical bare basenames (`credentials`, `htpasswd`, `shadow`).
 */
export declare const CREDENTIAL_PATH_RE: RegExp;
/** Credential-shaped dotfiles the scan walk opts back in for local scanning. */
export declare const CREDENTIAL_DOTFILE_RE: RegExp;
/** Scan-flavored review prompt — same findings contract as code-review. */
export declare function buildScanMessages(patchText: string, chunkIndex: number, totalChunks: number): Message[];
/**
 * `argus scan` — U7 audit mode. Deterministic rules + secrets over a
 * synthesized tree diff (or `git diff <base>`), optional model pass under
 * the same exclusion contract, standalone scan-report.json.
 */
export declare function cmdScan(args: string[], ctx: Ctx, deps: CliDeps): Promise<number>;
