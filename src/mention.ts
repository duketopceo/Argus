import { isTrustedAssociation, PROBE_LABEL, type PrMeta } from './evidence/ci.js'
import { labelCoversHead } from './evidence/gate.js'

/**
 * `@argus` mention commands on PR comments (roadmap E3.U5). The mention
 * lane runs on `issue_comment` events — strictly more privileged than
 * `pull_request` (repo secrets + write-capable GITHUB_TOKEN are present),
 * so it NEVER checks out the PR head. Review operates on a base-ref
 * checkout with the PR diff fetched via the API — the same diff-only
 * posture `code-review` already uses.
 */

export type MentionName = 'review' | 'record' | 'persist' | 'generate' | 'help'

export interface MentionCommand {
  name: MentionName
  /** `record` flow description, quotes already stripped. */
  arg?: string
}

const NAMES = new Set<MentionName>(['review', 'record', 'persist', 'generate', 'help'])

/**
 * Parse a comment body into a whitelisted mention command. The mention must
 * open the comment — a bare `@argus` in the middle of prose is not a command.
 * `@argus` alone and `@argus help` both yield `help`; anything that isn't a
 * whitelisted verb yields `unknown` so the caller can reply with the menu.
 */
export function parseMention(body: string): MentionCommand | 'unknown' | undefined {
  const first = body.trimStart().split('\n', 1)[0]?.trim() ?? ''
  const m = /^@argus\b\s*(.*)$/i.exec(first)
  if (m === null) return undefined
  const rest = (m[1] ?? '').trim()
  if (rest === '') return { name: 'help' }
  const verb = rest.split(/\s+/, 1)[0]?.toLowerCase() ?? ''
  if (!NAMES.has(verb as MentionName)) return 'unknown'
  const name = verb as MentionName
  if (name !== 'record') return { name }
  // `record "sign in with google"` — quotes optional; cap the flow text.
  // Newlines/backticks are stripped: the arg is commenter-controlled text
  // echoed into a public reply.
  const arg = rest
    .slice(verb.length)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/[\r\n`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return { name, ...(arg !== '' ? { arg } : {}) }
}

export interface MentionGate {
  allowed: boolean
  /** Reply text for denials the commenter should see; undefined → silent. */
  reply?: string
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
export function mayRunMention(
  cmd: MentionCommand,
  association: string | undefined,
  meta: PrMeta | undefined,
): MentionGate {
  if (!isTrustedAssociation(association)) return { allowed: false }
  if (cmd.name === 'help') return { allowed: true }
  if (meta === undefined) {
    return { allowed: false, reply: "I can't see this PR's metadata — try again in a moment." }
  }
  if (!meta.isFork) return { allowed: true }
  if (cmd.name === 'record' || cmd.name === 'persist' || cmd.name === 'generate') {
    return {
      allowed: false,
      reply: `\`@argus ${cmd.name}\` isn't available on fork PRs — record, persist and generate run inside the repo's trust boundary.`,
    }
  }
  if (!meta.labels.includes(PROBE_LABEL) || !labelCoversHead(meta)) {
    return {
      allowed: false,
      reply: `This PR comes from a fork — a maintainer can enable review by applying \`${PROBE_LABEL}\` to the current head.`,
    }
  }
  return { allowed: true }
}

export const MENTION_HELP =
  'Commands: `@argus review` — re-run code review on the latest head · ' +
  '`@argus record "<flow>"` — record a test flow against the app · ' +
  '`@argus persist` — turn a reproduced probe into a regression-test PR · ' +
  '`@argus generate` - author spec coverage from the diff into a reviewable PR · ' +
  '`@argus help` — this menu.'

const GH_API = 'https://api.github.com'

/**
 * Post the mention reply as an issue comment. Best-effort — a failed reply
 * logs and returns false rather than failing the dispatch.
 */
export async function postIssueComment(
  repo: string,
  issue: string,
  body: string,
  token: string,
  ctx: { err: (line: string) => void },
): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
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
    })
    if (!res.ok) {
      ctx.err(`mention: reply post failed — github ${res.status} ${res.statusText}`)
      return false
    }
    return true
  } catch (e) {
    ctx.err(`mention: reply post failed — ${(e as Error).message}`)
    return false
  } finally {
    clearTimeout(timeout)
  }
}
