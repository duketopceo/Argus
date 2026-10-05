import { isTrustedAssociation, PROBE_LABEL } from './evidence/ci.js';
import { labelCoversHead } from './evidence/gate.js';
const NAMES = new Set(['review', 'record', 'persist', 'generate', 'help']);
/**
 * Parse a comment body into a whitelisted mention command. The mention must
 * open the comment — a bare `@argus` in the middle of prose is not a command.
 * `@argus` alone and `@argus help` both yield `help`; anything that isn't a
 * whitelisted verb yields `unknown` so the caller can reply with the menu.
 */
export function parseMention(body) {
    const first = body.trimStart().split('\n', 1)[0]?.trim() ?? '';
    const m = /^@argus\b\s*(.*)$/i.exec(first);
    if (m === null)
        return undefined;
    const rest = (m[1] ?? '').trim();
    if (rest === '')
        return { name: 'help' };
    const verb = rest.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    if (!NAMES.has(verb))
        return 'unknown';
    const name = verb;
    if (name !== 'record' && name !== 'review')
        return { name };
    // `record "sign in with google"` / `review full` — quotes optional; cap
    // the flow text. Newlines/backticks are stripped: the arg is
    // commenter-controlled text echoed into a public reply.
    const arg = rest
        .slice(verb.length)
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/[\r\n`]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    return { name, ...(arg !== '' ? { arg } : {}) };
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
export function mayRunMention(cmd, association, meta) {
    if (!isTrustedAssociation(association))
        return { allowed: false };
    if (cmd.name === 'help')
        return { allowed: true };
    if (meta === undefined) {
        return { allowed: false, reply: "I can't see this PR's metadata — try again in a moment." };
    }
    if (!meta.isFork)
        return { allowed: true };
    if (cmd.name === 'record' || cmd.name === 'persist' || cmd.name === 'generate') {
        return {
            allowed: false,
            reply: `\`@argus ${cmd.name}\` isn't available on fork PRs — record, persist and generate run inside the repo's trust boundary.`,
        };
    }
    if (!meta.labels.includes(PROBE_LABEL) || !labelCoversHead(meta)) {
        return {
            allowed: false,
            reply: `This PR comes from a fork — a maintainer can enable review by applying \`${PROBE_LABEL}\` to the current head.`,
        };
    }
    return { allowed: true };
}
export const MENTION_HELP = 'Commands: `@argus review` — re-run code review on the latest head (`review full` re-diffs the whole PR) · ' +
    '`@argus record "<flow>"` — record a test flow against the app · ' +
    '`@argus persist` — turn a reproduced probe into a regression-test PR · ' +
    '`@argus generate` - author spec coverage from the diff into a reviewable PR · ' +
    '`@argus help` — this menu.';
const GH_API = 'https://api.github.com';
/**
 * Post the mention reply as an issue comment. Best-effort — a failed reply
 * logs and returns false rather than failing the dispatch.
 */
export async function postIssueComment(repo, issue, body, token, ctx) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(`${GH_API}/repos/${repo}/issues/${issue}/comments`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ body }),
        });
        if (!res.ok) {
            ctx.err(`mention: reply post failed — github ${res.status} ${res.statusText}`);
            return false;
        }
        return true;
    }
    catch (e) {
        ctx.err(`mention: reply post failed — ${e.message}`);
        return false;
    }
    finally {
        clearTimeout(timeout);
    }
}
