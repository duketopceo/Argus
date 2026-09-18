import { defaultExec, type ExecFn } from '../detect.js'
import { debug } from '../debug.js'
import { DecisionClient, DecisionError } from '../vision/decisions.js'

/**
 * Deterministic secrets scan over the PR's local merge-base diff,
 * optionally adjudicated by the Decisions API (Jev). The lane is
 * additive-only: findings are unioned into the review AFTER model
 * synthesis so a prompt-injected synthesis can never erase them, and a
 * Jev outage degrades to regex-only findings rather than silence.
 *
 * Masking contract: raw literals transit to Jev inside `state` (KTD9 —
 * adjudication needs the shape, and the full diff already crosses to
 * OpenRouter in the review call) and appear NOWHERE else — not in
 * findings, comments, the report, or logs.
 */

export interface SecretCandidate {
  file: string
  /** Line number in the post-change file. */
  line: number
  patternClass: string
  /** Diff line text with every occurrence of the literal replaced by `***`. */
  contextExcerpt: string
  /** Raw literal — Jev `state` only, never emitted. */
  literal: string
  /** Full raw added-line text — Jev `state` only, never emitted. */
  rawText: string
}

export interface SecretScanRecord {
  file: string
  line: number
  patternClass: string
  /** True when Jev answered for this candidate. */
  adjudicated: boolean
  pLive?: number
  /** Jev scored below threshold — recorded for audit, not a finding. */
  suppressed?: boolean
}

export interface SecretsScanResult {
  /** Findings to union into the review — messages are fully masked. */
  findings: { file: string; line?: number; severity: string; category?: string; message: string }[]
  /** Audit records for report.secretsScan — literals never included. */
  records: SecretScanRecord[]
  /** Candidates past MAX_CANDIDATES — reported count-only, never sent to Jev. */
  overflow: number
  /** Why the lane produced nothing (e.g. base unfetchable). */
  skipped?: string
}

export const MAX_CANDIDATES = 50
export const DEFAULT_SECRETS_THRESHOLD = 0.3

const PATTERNS: { cls: string; re: RegExp; group?: number }[] = [
  { cls: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY(?: BLOCK)?-----/ },
  { cls: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { cls: 'stripe-live', re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{16,}\b/ },
  { cls: 'stripe-webhook-secret', re: /\bwhsec_[0-9a-zA-Z]{16,}\b/ },
  { cls: 'github-pat', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/ },
  { cls: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    cls: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/,
  },
  {
    cls: 'generic-assignment',
    re: /(?:api[_-]?key|token|secret|passwd|password)\s*[:=]\s*['"]?([A-Za-z0-9/+_.=-]{12,})/i,
    group: 1,
  },
]

/**
 * Parse `git diff` text into secret candidates from added (`+`) lines.
 * Removed/context lines are not scanned — a rotated-out-but-live secret
 * in a `-` line is a deliberate open question (plan OQ), and context
 * lines would re-flag pre-existing secrets the PR did not introduce.
 */
export function scanDiffForSecrets(diffText: string): SecretCandidate[] {
  const out: SecretCandidate[] = []
  let file = ''
  let newLine = 0
  // `+++ `/`--- ` are file headers only in the pre-hunk zone — inside a
  // hunk they are added/removed content lines (`+` + `++ x`, `-` + `-- x`)
  // and must not reset `file` or `inHunk`.
  let inHunk = false
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git')) {
      inHunk = false
      continue
    }
    if (raw.startsWith('@@')) {
      inHunk = true
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      newLine = m !== null ? parseInt(m[1] as string, 10) : 0
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('+++ ')) {
        const m = /^\+\+\+ b\/(.+)$/.exec(raw)
        file = m?.[1] ?? ''
      }
      continue
    }
    // Context lines consume a new-file line number; `-` lines don't.
    if (raw.startsWith(' ')) {
      newLine++
      continue
    }
    if (!raw.startsWith('+') || file === '') continue
    const text = raw.slice(1)
    for (const { cls, re, group } of PATTERNS) {
      const m = re.exec(text)
      if (m === null) continue
      const literal = group !== undefined ? (m[group] ?? m[0]) : m[0]
      out.push({
        file,
        line: newLine,
        patternClass: cls,
        contextExcerpt: text.replaceAll(literal, '***'),
        literal,
        rawText: text,
      })
      break // first matching class wins — one candidate per line
    }
    newLine++
  }
  return out
}

function maskFindingMessage(c: SecretCandidate, adjudicated: boolean): string {
  const verdict = adjudicated
    ? 'live-looking credential'
    : 'secret-shaped literal (unadjudicated — decision model unavailable)'
  return (
    `L${c.line}: ${adjudicated ? '🔴' : '🟡'} ${adjudicated ? 'bug' : 'risk'}: ` +
    `${verdict} (${c.patternClass}) added in this PR at \`${c.file}\`. ` +
    `Rotate it and purge it from history.`
  )
}

/** `git cat-file -e` + shallow-fetch fallback — mirrors probe/queue.ts. */
async function ensureBaseObject(
  exec: ExecFn,
  cwd: string,
  baseSha: string,
  token: string | undefined,
): Promise<boolean> {
  const have = await exec('git', ['-C', cwd, 'cat-file', '-e', `${baseSha}^{commit}`], 15_000)
  if (have.code === 0) return true
  if (token === undefined) return false
  // Auth rides env config like actions/checkout's extraheader — keeps the
  // token out of process argv where co-tenant jobs could scrape /proc.
  const fetched = await exec('git', ['-C', cwd, 'fetch', '--depth', '1', 'origin', baseSha], 60_000, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  })
  return fetched.code === 0
}

/**
 * Materialize the merge-base diff locally — the PR-files API `patch`
 * field omits large/binary files, so the API diff is not a complete
 * scan surface.
 */
export async function materializeMergeBaseDiff(opts: {
  cwd: string
  baseSha: string
  token?: string
  exec?: ExecFn
}): Promise<{ diff: string } | { skipped: string }> {
  const exec = opts.exec ?? defaultExec
  const have = await ensureBaseObject(exec, opts.cwd, opts.baseSha, opts.token)
  if (!have) {
    return { skipped: `base ${opts.baseSha.slice(0, 12)} not available locally and unfetchable` }
  }
  // core.quotePath=false — the default C-escapes non-ASCII/odd-byte paths
  // ("b/\"f\\303\\251e.ts\""), mangling `file` in findings.
  const diff = await exec(
    'git',
    ['-c', 'core.quotePath=false', '-C', opts.cwd, 'diff', `${opts.baseSha}..HEAD`],
    60_000,
  )
  if (diff.code !== 0) {
    return { skipped: `git diff failed: ${diff.stderr.trim().slice(0, 200)}` }
  }
  return { diff: diff.stdout }
}

/**
 * Full lane: scan candidates (capped), Jev-adjudicate when a client and
 * threshold are available, and emit masked findings + audit records.
 * `client === undefined` (decisionModel unset) or any DecisionError →
 * every candidate unadjudicated — regex-only mode, never silence.
 */
export async function scanSecrets(opts: {
  diff: string
  threshold?: number
  client?: DecisionClient
  model?: string
}): Promise<SecretsScanResult> {
  const threshold = opts.threshold ?? DEFAULT_SECRETS_THRESHOLD
  const all = scanDiffForSecrets(opts.diff)
  const candidates = all.slice(0, MAX_CANDIDATES)
  const overflow = all.length - candidates.length

  const pLiveByIdx: (number | undefined)[] = new Array<number | undefined>(candidates.length)
  let adjudicationFailed = false

  if (opts.client !== undefined && candidates.length > 0) {
    try {
      const questions: Record<string, { type: 'noul'; instructions: string }> = {}
      candidates.forEach((c, i) => {
        questions[`cand_${i}`] = {
          type: 'noul',
          instructions:
            `state[${i}]: is 'literal' a real, usable credential committed to source? ` +
            'Answer no for documentation examples, placeholders, test fixtures, ' +
            'and revoked or sample values.',
        }
      })
      const state = candidates.map((c) => ({
        file: c.file,
        line: c.line,
        lineText: c.rawText,
        literal: c.literal,
      }))
      const { answers } = await opts.client.decide({
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        state,
        questions,
      })
      candidates.forEach((_c, i) => {
        const a = answers[`cand_${i}`]
        pLiveByIdx[i] = a !== undefined && 'noul' in a ? a.noul : undefined
      })
    } catch (e) {
      adjudicationFailed = true
      debug(
        'secrets',
        `adjudication failed — degrading to regex-only: ${e instanceof DecisionError ? e.kind : (e as Error).message}`,
      )
    }
  }

  const findings: SecretsScanResult['findings'] = []
  const records: SecretScanRecord[] = []
  candidates.forEach((c, i) => {
    const pLive = pLiveByIdx[i]
    const adjudicated = pLive !== undefined && !adjudicationFailed
    if (adjudicated && (pLive as number) < threshold) {
      records.push({
        file: c.file,
        line: c.line,
        patternClass: c.patternClass,
        adjudicated: true,
        pLive,
        suppressed: true,
      })
      return
    }
    findings.push({
      file: c.file,
      line: c.line,
      severity: adjudicated ? 'bug' : 'risk',
      category: 'security',
      message: maskFindingMessage(c, adjudicated),
    })
    records.push({
      file: c.file,
      line: c.line,
      patternClass: c.patternClass,
      adjudicated,
      ...(pLive !== undefined ? { pLive } : {}),
    })
  })

  // Candidates past the cap were never adjudicated — a real secret could
  // sit in the overflow. Surface that gap as a finding, not just a count.
  if (overflow > 0) {
    findings.push({
      file: '-',
      line: 0,
      severity: 'risk',
      category: 'security',
      message:
        `L0: 🟡 risk: ${overflow} secret-shaped literal(s) exceeded the ` +
        `${MAX_CANDIDATES}-candidate adjudication cap and were not evaluated — ` +
        'review the diff for secrets manually.',
    })
  }

  return { findings, records, overflow }
}
