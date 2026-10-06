import { type Ctx, type CliDeps } from './shared.js';
export declare const MENTION_USAGE = "Usage: argus-reviewer mention [--report-dir <dir>]\n\n\nDispatch an @argus command from a GitHub issue_comment event. Reads\nGITHUB_EVENT_PATH for the comment body, commenter association, and issue\nnumber; runs nothing unless the comment is on a pull request and starts\nwith @argus. Never checks out the PR head: review runs API-diff-only\nagainst the base checkout.\n\nCommands: @argus review [full] \u00B7 @argus record \"<flow>\" \u00B7 @argus persist \u00B7 @argus generate \u00B7 @argus fix \u00B7 @argus help";
export interface IssueCommentPayload {
    issue?: {
        number?: number;
        pull_request?: unknown;
    };
    comment?: {
        body?: string;
        author_association?: string;
    };
}
/**
 * `argus-reviewer mention` — the E3.U5 dispatch lane. Everything upstream
 * of the command handler is a gate: untrusted commenters are ignored
 * silently (no reply channel for drive-by spam), fork-head PRs need the
 * per-head probe label for execution commands, and record/persist never
 * run on forks at all.
 */
export declare function cmdMention(args: string[], ctx: Ctx, deps: CliDeps): Promise<number>;
