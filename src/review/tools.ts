/**
 * Repo-context tools for the review agent (U9, issue #153). Three read-only
 * tools — `read_file`, `search_index`, `find_tests_for` — let the reviewer
 * pull callers/importers/tests into context instead of reviewing the diff
 * blind. This is the OCR-parity move with a real jail:
 *
 * - every read gates on index membership AND realpath confinement to the
 *   launch cwd AND an explicit credential-shaped denylist — the index walk
 *   excludes dotfiles by default, but a scan-mode index can opt them back
 *   in, so the denylist is enforced independently;
 * - everything refused returns an `error:` string to the model — denials
 *   never throw, the loop continues;
 * - results pass through maskSecretLiterals (the secrets-lane contract, R9)
 *   before reaching the model or the report's `toolUse` transcript;
 * - tool calls are bounded by the client's round cap + the caller's budget
 *   check — this module only decides what one read returns.
 */
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

import { isTestFile } from '../evidence/link.js'
import type { RepoIndex } from '../index/scan.js'
import { maskSecretLiterals } from './secrets.js'
import type { ToolCallRecord, ToolSpec } from '../vision/openrouter.js'

/** Cap on bytes returned to the model per read — keeps rounds cheap. */
export const TOOL_READ_CAP = 32 * 1024
/** Cap on search/test results per call. */
const MAX_HITS = 10

/**
 * Credential-shaped basenames refused regardless of index membership —
 * scan-mode indexes can legitimately contain them and a model must never
 * get them back.
 */
const DENY_NAME =
  /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|\.npmrc|\.netrc|credentials(\..*)?)$/i

/** Mask a tool call record for the report transcript — args and result both. */
export function maskToolRecord(r: ToolCallRecord): ToolCallRecord {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(maskSecretLiterals(JSON.stringify(r.args))) as Record<string, unknown>
  } catch {
    // Masking mangled the JSON — drop args rather than leak a raw string.
  }
  return { ...r, args, result: maskSecretLiterals(r.result) }
}

export interface RepoToolContext {
  /** Review checkout root — realpath-confinement root. */
  cwd: string
  /** Loaded repo index; absent → no tools (reads can't be gated). */
  index: RepoIndex | undefined
  /** Set on the issue_comment lane — reads see the base ref, not the PR head. */
  staleBase?: boolean
}

function errorLine(message: string): string {
  return `error: ${message}`
}

/**
 * Build the tool whitelist + executor for one review. Returns undefined when
 * there is no index — without membership data no read can be gated, so the
 * tools stay off rather than reading unvetted paths.
 */
export function repoTools(ctx: RepoToolContext): { specs: ToolSpec[]; run: (name: string, args: Record<string, unknown>) => Promise<string> } | undefined {
  if (ctx.index === undefined || !Array.isArray(ctx.index.entries)) return undefined
  const entries = ctx.index.entries
  const paths = new Set(entries.map((e) => e.path))
  const byPath = new Map(entries.map((e) => [e.path, e]))
  const stale = ctx.staleBase === true ? ' (pre-change file state; this checkout is the base ref)' : ''

  const specs: ToolSpec[] = [
    {
      name: 'read_file',
      description:
        `Read a repo file (truncated at ${Math.round(TOOL_READ_CAP / 1024)}KB). ` +
        'Only files in the repository index are readable; generated, vendored, dotfile and lockfile paths are not.' +
        stale,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Repo-relative path, e.g. src/index/scan.ts' } },
        required: ['path'],
      },
    },
    {
      name: 'search_index',
      description:
        'Search the repository index by path or purpose substring; returns matching file paths with one-line purposes.' + stale,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Case-insensitive substring, e.g. "ledger"' } },
        required: ['query'],
      },
    },
    {
      name: 'find_tests_for',
      description:
        'List test files that import the given repo path (direct importers plus same-name test siblings).' + stale,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Repo-relative source path' } },
        required: ['path'],
      },
    },
  ]

  const read = async (raw: unknown): Promise<string> => {
    if (typeof raw !== 'string' || raw.trim() === '') return errorLine('path must be a non-empty string')
    const p = raw.trim()
    if (isAbsolute(p) || p.includes('..') || /[\s"'`<>`]/.test(p)) return errorLine(`path ${JSON.stringify(p)} is not a safe repo-relative path`)
    // Index membership is the allowlist — but deny credential shapes anyway:
    // a scan-mode index can legitimately carry .env-class files.
    if (DENY_NAME.test(p)) return errorLine(`path ${JSON.stringify(p)} is refused (credential-shaped)`)
    if (!paths.has(p)) return errorLine(`path ${JSON.stringify(p)} is not in the repository index`)
    try {
      const [rootReal, fileReal] = await Promise.all([realpath(ctx.cwd), realpath(join(ctx.cwd, p))])
      if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) {
        return errorLine(`path ${JSON.stringify(p)} escapes the checkout`)
      }
      // An in-checkout symlink stays confined but still aliases — the
      // resolved path must equal the requested one or a link could alias
      // an unindexed or credential-shaped file past both gates.
      const resolved = fileReal === rootReal ? '' : fileReal.slice(rootReal.length + 1).split(sep).join('/')
      if (resolved !== p) {
        return errorLine(`path ${JSON.stringify(p)} resolves to a different path (${JSON.stringify(resolved)})`)
      }
      const fh = await open(fileReal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const st = await fh.stat()
        if (!st.isFile()) return errorLine(`path ${JSON.stringify(p)} is not a file`)
        const len = Math.min(st.size, TOOL_READ_CAP)
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, 0)
        const head = buf.toString('utf8')
        return maskSecretLiterals(st.size > TOOL_READ_CAP ? `${head}\n… [truncated at ${TOOL_READ_CAP}B]` : head)
      } finally {
        await fh.close()
      }
    } catch (e) {
      return errorLine(`could not read ${JSON.stringify(p)}: ${(e as Error).message}`)
    }
  }

  const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case 'read_file':
        return read(args.path)
      case 'search_index': {
        const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
        if (q === '') return errorLine('query must be a non-empty string')
        const hits = entries
          .filter((e) => e.path.toLowerCase().includes(q) || (e.purpose ?? '').toLowerCase().includes(q))
          .slice(0, MAX_HITS)
          .map((e) => `${e.path}: ${e.purpose ?? 'indexed file'}`)
        return hits.length === 0 ? `no index entries match ${JSON.stringify(q)}` : maskSecretLiterals(hits.join('\n'))
      }
      case 'find_tests_for': {
        const p = typeof args.path === 'string' ? args.path.trim() : ''
        if (p === '') return errorLine('path must be a non-empty string')
        const tests = new Set<string>()
        const entry = byPath.get(p)
        for (const importer of entry?.importedBy ?? []) if (isTestFile(importer)) tests.add(importer)
        // Same-name siblings: foo.ts -> foo.test.ts / tests/foo.test.ts styles.
        const base = p.replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, '')
        for (const cand of paths) {
          if (!isTestFile(cand)) continue
          const stem = cand.replace(/\.(test|spec)\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, '')
          if (stem === base || stem.endsWith(`/${base.split('/').pop()}`)) tests.add(cand)
        }
        const list = [...tests].sort().slice(0, MAX_HITS)
        return list.length === 0 ? `no test files reference ${JSON.stringify(p)}` : list.join('\n')
      }
      default:
        return errorLine(`unknown tool ${JSON.stringify(name)}`)
    }
  }

  return { specs, run }
}
