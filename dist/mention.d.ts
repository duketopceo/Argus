import { type PrMeta } from './evidence/ci.js';
/**
 * `@argus` mention commands on PR comments (roadmap E3.U5). The mention
 * lane runs on `issue_comment` events — strictly more privileged than
 * `pull_request` (repo secrets + write-capable GITHUB_TOKEN are present),
 * so it NEVER checks out the PR head. Review operates on a base-ref
 * checkout with the PR diff fetched via the API — the same diff-only
 * posture `code-review` already uses.
 */
export type MentionName = 'review' | 'record' | 'persist' | 'help';
export interface MentionCommand {
    name: MentionName;
    /** `record` flow description, quotes already stripped. */
    arg?: string;
}
/**
 * Parse a comment body into a whitelisted mention command. The mention must
 * open the comment — a bare `@argus` in the middle of prose is not a command.
 * `@argus` alone and `@argus help` both yield `help`; anything that isn't a
 * whitelisted verb yields `unknown` so the caller can reply with the menu.
 */
export declare function parseMention(body: string): MentionCommand | 'unknown' | undefined;
export interface MentionGate {
    allowed: boolean;
    /** Reply text for denials the commenter should see; undefined → silent. */
    reply?: string;
}
/**
 * Two-part gate. `association` is the *commenter's* `author_association`
 * (not the PR author's): only MEMBER/OWNER/COLLABORATOR may drive Argus.
 * For fork-head PRs every command additionally needs the `argus-probe`
 * label covering the current head SHA, and `record`/`persist` are disabled
 * outright — they would execute or persist artifacts derived from code the
 * label was meant to bound. `help` needs no label: it replies with a fixed
 * menu and executes nothing.
 */
export declare function mayRunMention(cmd: MentionCommand, association: string | undefined, meta: PrMeta | undefined): MentionGate;
export declare const MENTION_HELP: string;
/**
 * Post the mention reply as an issue comment. Best-effort — a failed reply
 * logs and returns false rather than failing the dispatch.
 */
export declare function postIssueComment(repo: string, issue: string, body: string, token: string, ctx: {
    err: (line: string) => void;
}): Promise<boolean>;
