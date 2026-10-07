import type { DecisionClient } from '../vision/decisions.js'
import { addedLines } from './difftext.js'
import {
  scanSecrets,
  type SecretsScanResult,
  type SecretScanRecord,
} from './secrets.js'
import { isTestPath } from './testfiles.js'

/**
 * U8 — named deterministic ruleset lane. Pure functions over the PR's
 * materialized scan diff (the same surface the secrets lane consumes:
 * fixture/local-review/incremental/merge-base) emitting findings that
 * union into the review AFTER synthesis — a prompt-injected synthesis can
 * never erase them, and a throwing rule degrades open (failure audit
 * entry, the other rules still run, the review completes).
 *
 * Severity ceiling: no rule may emit `bug` without adjudication — the
 * runner demotes unadjudicated `bug` claims to `risk` and audits the
 * demotion. The secrets rule's confidence-model adjudication (`p`) is
 * the only adjudication hook in the lane today.
 *
 * Masking contract: rules emit pattern classes and positions, never raw
 * line text — a matched line can itself contain a secret.
 */

export interface RuleFinding {
  file: string
  line?: number
  severity: string
  category?: string
  message: string
  /** Adjudicated confidence (secrets rule) — the only `bug` license. */
  p?: number
  /** Stamped by the runner — provenance survives the post-synthesis union. */
  rule?: string
}

export interface RuleRecord {
  rule: string
  file: string
  line?: number
  /** Pattern class or construct matched — never raw line text. */
  detail: string
  /** Why the hit was recorded but did not become a finding. */
  suppressed?: string
  adjudicated?: boolean
  pLive?: number
}

export interface RuleFailure {
  rule: string
  error: string
}

interface RuleOutput {
  findings: RuleFinding[]
  records: Omit<RuleRecord, 'rule'>[]
  /** The secrets rule's native result — feeds report.secretsScan. */
  secretsScan?: SecretsScanResult
}

export interface RuleRunContext {
  /** Confidence-model adjudication for the secrets rule. */
  decisionClient?: DecisionClient
  decisionModel?: string
  secretsThreshold?: number
}

export interface ReviewRule {
  id: string
  description: string
  run(diff: string, ctx: RuleRunContext): Promise<RuleOutput> | RuleOutput
}

export interface RulesRunResult {
  findings: RuleFinding[]
  /** Every rule hit — suppressed or finding-bound — rule-tagged. */
  records: RuleRecord[]
  /** Rules that threw; their findings are absent, the lane completes. */
  failures: RuleFailure[]
  /** Rule ids that ran. */
  ran: string[]
  /** SecretsScanResult when the secrets rule ran — report.secretsScan. */
  secretsScan?: SecretsScanResult
}

/** Per-rule hit cap — a formatter churning TODOs must not flood the report. */
export const RULE_HITS_CAP = 200

/**
 * Per-rule audit-record bound — records stay complete for realistic
 * inputs; a pathological diff (generated churn) collapses past the cap
 * into one count-preserving aggregate record instead of an unbounded
 * report payload.
 */
export const RULE_RECORDS_CAP = 2000

/**
 * Paths where a pattern hit is data or prose, not code — sample
 * manifests, docs, fixtures. Hits there are suppressed WITH a record
 * (the audit keeps them inspectable), never silently dropped.
 */
const DATA_PATH_RE =
  /(^|\/)(docs?|examples?|samples?|fixtures?|testdata|goldens?|__snapshots__)\/|\.(md|mdx|txt|rst|jsonc?|ya?ml|toml|lock|snap|golden|sample|example)$/i

/** Script/eval dirs where sync IO is idiomatic — test paths ride isTestPath. */
const SCRIPT_PATH_RE = /(^|\/)(scripts?|evals?)\//i

const isNonProdPath = (file: string): boolean =>
  isTestPath(file) || SCRIPT_PATH_RE.test(file)

/** Loopback/unspecified addresses — a hardcoded 127.0.0.1 is not a hit. */
const LOCAL_IP_RE = /^(?:127\.|0\.0\.0\.0$)/

/**
 * Why a hit was suppressed — data/prose paths and non-production paths
 * (tests, scripts, evals) are different reasons and stay distinguishable
 * in the audit.
 */
const suppressedReason = (file: string): string | undefined =>
  DATA_PATH_RE.test(file)
    ? 'data/prose path'
    : isNonProdPath(file)
      ? 'non-production path'
      : undefined

function secretRecord(r: SecretScanRecord): Omit<RuleRecord, 'rule'> {
  return {
    file: r.file,
    line: r.line,
    detail: r.patternClass,
    adjudicated: r.adjudicated,
    ...(r.pLive !== undefined ? { pLive: r.pLive } : {}),
    ...(r.suppressed === true ? { suppressed: 'below adjudication threshold' } : {}),
  }
}

const secretsRule: ReviewRule = {
  id: 'secrets',
  description: 'secret-pattern scan, confidence-adjudicated when a decision client is wired',
  async run(diff, ctx) {
    const res = await scanSecrets({
      diff,
      ...(ctx.secretsThreshold !== undefined ? { threshold: ctx.secretsThreshold } : {}),
      ...(ctx.decisionClient !== undefined ? { client: ctx.decisionClient } : {}),
      ...(ctx.decisionModel !== undefined ? { model: ctx.decisionModel } : {}),
    })
    const records = res.records.map(secretRecord)
    if (res.overflow > 0) {
      records.push({
        file: '-',
        detail: `${res.overflow} candidate(s) over the adjudication cap`,
        suppressed: 'candidate-cap',
      })
    }
    return { findings: res.findings, records, secretsScan: res }
  },
}

// The `(?![\w.])` right boundary stops `127.0.0.1.evil.com` capturing
// `127.0.0.1` and suppressing as loopback — a dotted-quad-prefixed
// domain is a domain, not an IP literal.
const IP_URL_RE = /https?:\/\/(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/
const IP_ASSIGN_RE =
  /\b(?:host|addr|address|ip|endpoint|server|url|baseurl|base_url)\w*\s*[:=]\s*['"`]?(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/i

const hardcodedEndpointRule: ReviewRule = {
  id: 'hardcoded-endpoint',
  description: 'hardcoded URLs/IP literals added in code',
  run(diff) {
    const findings: RuleFinding[] = []
    const records: Omit<RuleRecord, 'rule'>[] = []
    for (const { file, line, text } of addedLines(diff)) {
      const url = IP_URL_RE.exec(text)
      const m = url ?? IP_ASSIGN_RE.exec(text)
      if (m === null) continue
      const detail = url !== null ? 'url-with-ip-host' : 'ip-literal-assignment'
      const suppressed = suppressedReason(file)
      if (suppressed !== undefined) {
        records.push({ file, line, detail, suppressed })
        continue
      }
      if (LOCAL_IP_RE.test(m[1] ?? '')) {
        records.push({ file, line, detail, suppressed: 'loopback/unspecified host' })
        continue
      }
      findings.push({
        file,
        line,
        severity: 'nit',
        category: 'security',
        message:
          `L${line}: nit: hardcoded endpoint (${detail}) added at \`${file}\` - ` +
          'prefer config or secret injection over a literal address.',
      })
      records.push({ file, line, detail })
    }
    return { findings, records }
  },
}

const TODO_RE = /\b(?:TODO|FIXME|XXX|HACK)\b/

const leftoverTodoRule: ReviewRule = {
  id: 'leftover-todo',
  description: 'leftover TODO/FIXME/XXX/HACK markers in added lines',
  run(diff) {
    const findings: RuleFinding[] = []
    const records: Omit<RuleRecord, 'rule'>[] = []
    for (const { file, line, text } of addedLines(diff)) {
      if (!TODO_RE.test(text)) continue
      // Only data/prose suppresses — TODOs in tests stay flagged
      // (skipped-coverage markers are real signal).
      if (DATA_PATH_RE.test(file)) {
        records.push({ file, line, detail: 'todo-marker', suppressed: 'data/prose path' })
        continue
      }
      findings.push({
        file,
        line,
        severity: 'nit',
        category: 'convention',
        message:
          `L${line}: nit: leftover TODO/FIXME-style marker added at \`${file}\` - ` +
          'resolve it or link a tracking issue.',
      })
      records.push({ file, line, detail: 'todo-marker' })
    }
    return { findings, records }
  },
}

const SYNC_CALL_RE =
  /\b(execSync|execFileSync|spawnSync|readFileSync|writeFileSync|appendFileSync|readdirSync|mkdirSync|rmSync)\s*\(/

const syncInAsyncRule: ReviewRule = {
  id: 'sync-in-async',
  description: 'synchronous fs/process calls added in code paths',
  run(diff) {
    const findings: RuleFinding[] = []
    const records: Omit<RuleRecord, 'rule'>[] = []
    for (const { file, line, text } of addedLines(diff)) {
      const m = SYNC_CALL_RE.exec(text)
      if (m === null) continue
      const call = m[1] ?? m[0]
      const suppressed = suppressedReason(file)
      if (suppressed !== undefined) {
        records.push({ file, line, detail: call, suppressed })
        continue
      }
      findings.push({
        file,
        line,
        severity: 'nit',
        category: 'performance',
        message:
          `L${line}: nit: synchronous call \`${call}\` added at \`${file}\` - ` +
          'it blocks the event loop; prefer the async variant.',
      })
      records.push({ file, line, detail: call })
    }
    return { findings, records }
  },
}

// --- U5 coverage rules -----------------------------------------------------

const MANIFEST_RE = /(^|\/)package\.json$/
// package.json fails DATA_PATH_RE on its .json extension — dep-diff's
// suppression is dir-level only (fixture/example manifests are data).
const MANIFEST_DATA_RE = /(^|\/)(docs?|examples?|samples?|fixtures?|testdata)\//i
const DEP_BLOCK_RE = /^(\s*)"(?:dev|peer|optional)?[Dd]ependencies"\s*:\s*\{/
const DEP_ENTRY_RE = /^\s*"([^"]+)"\s*:\s*"([^"]+)"/
const CLOSE_RE = /^(\s*)\}/
// Hunk context is ±3 lines — a dep added mid-block never shows the
// "dependencies": { opener. Outside a tracked block, entries count only
// when the value is a version spec (rejects script commands like
// "build": "esbuild ..." and metadata like "name": "app").
const VER_SPEC_RE =
  /^(?:\^|~|>=?|<=?|=)?v?\d+\.\d+\.\d+|^(?:workspace|npm|file|link|git\+|https?):/
const NON_DEP_KEYS = new Set(['version', 'packageManager', 'name'])

interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  file: string
  newLine: number
  text: string
}

// Per-file hunk walker with context and removed lines — dep-diff needs
// block membership (is this "name": "ver" inside "dependencies"?), which
// flat addedLines() cannot answer.
function* hunkLines(diff: string): Generator<DiffLine> {
  let file = ''
  let inHunk = false
  let newLine = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      inHunk = false
      file = ''
      continue
    }
    if (!inHunk) {
      const m = /^\+\+\+ b\/(.+)$/.exec(raw)
      if (m !== null) file = m[1] as string
      if (raw.startsWith('@@')) {
        inHunk = true
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
        newLine = h !== null ? parseInt(h[1] as string, 10) : 0
      }
      continue
    }
    if (raw.startsWith('+')) {
      yield { kind: 'add', file, newLine, text: raw.slice(1) }
      newLine++
      continue
    }
    if (raw.startsWith('-')) {
      yield { kind: 'del', file, newLine, text: raw.slice(1) }
      continue
    }
    if (raw.startsWith(' ')) {
      yield { kind: 'ctx', file, newLine, text: raw.slice(1) }
      newLine++
    }
  }
}

/**
 * dep-diff (U5): new dependencies and major version jumps in package.json.
 * Supply-chain surface is reviewable signal — a new production dep or a
 * major bump is a real event, not an opinion. Minor/patch bumps are
 * audit-records only.
 */
const depDiffRule: ReviewRule = {
  id: 'dep-diff',
  description: 'new dependencies and major version jumps in package.json diffs',
  run(diff) {
    const findings: RuleFinding[] = []
    const records: Omit<RuleRecord, 'rule'>[] = []
    let depsIndent: number | null = null
    const added = new Map<string, { ver: string; line: number }>()
    const removed = new Map<string, string>()
    let file = ''
    const flush = () => {
      if (file === '' || (added.size === 0 && removed.size === 0)) {
        added.clear()
        removed.clear()
        return
      }
      const suppressed = MANIFEST_DATA_RE.test(file)
        ? 'data/prose path'
        : isNonProdPath(file)
          ? 'non-production path'
          : undefined
      for (const [name, { ver, line }] of added) {
        const oldVer = removed.get(name)
        const detail =
          oldVer === undefined ? `dependency-added ${name}@${ver}` : `version-jump ${name} ${oldVer}->${ver}`
        if (suppressed !== undefined) {
          records.push({ file, line, detail, suppressed })
          continue
        }
        const major =
          oldVer !== undefined &&
          (oldVer.match(/\d+/)?.[0] ?? '') !== (ver.match(/\d+/)?.[0] ?? '')
        if (oldVer === undefined) {
          findings.push({
            file,
            line,
            severity: 'nit',
            category: 'dependencies',
            message:
              `L${line}: nit: new dependency \`${name}@${ver}\` added at \`${file}\` - ` +
              'confirm source, license, and whether a lighter in-repo option exists.',
          })
          records.push({ file, line, detail })
        } else if (major) {
          findings.push({
            file,
            line,
            severity: 'nit',
            category: 'dependencies',
            message:
              `L${line}: nit: major version jump \`${name} ${oldVer} -> ${ver}\` at \`${file}\` - ` +
              'check the migration notes before merge.',
          })
          records.push({ file, line, detail })
        } else {
          records.push({ file, line, detail, suppressed: 'minor/patch bump' })
        }
      }
      added.clear()
      removed.clear()
    }
    for (const l of hunkLines(diff)) {
      if (l.file !== file) {
        flush()
        file = l.file
        depsIndent = null
      }
      if (!MANIFEST_RE.test(l.file)) continue
      if (depsIndent !== null) {
        const close = CLOSE_RE.exec(l.text)
        if (close !== null && (close[1] as string).length <= depsIndent) {
          depsIndent = null
          continue
        }
      } else {
        const open = DEP_BLOCK_RE.exec(l.text)
        if (open !== null) depsIndent = (open[1] as string).length
      }
      if (l.kind === 'ctx') continue
      const entry = DEP_ENTRY_RE.exec(l.text)
      if (entry === null) continue
      const name = entry[1] as string
      const ver = entry[2] as string
      if (depsIndent === null) {
        if (NON_DEP_KEYS.has(name) || !VER_SPEC_RE.test(ver)) continue
      }
      if (l.kind === 'add') added.set(name, { ver, line: l.newLine })
      else removed.set(name, ver)
    }
    flush()
    return { findings, records }
  },
}

const CODE_FILE_RE =
  /\.(?:c|cc|cpp|cs|cts|go|h|hpp|java|jsx|kt|mjs|mts|php|py|rb|rs|scala|swift|ts|tsx)$/
const GENERATED_FILE_RE = /(^|\/)dist\/|\.min\.|\.map$/i

/**
 * missing-test (U5): a diff that changes source files but touches no test
 * file gets one file-level nit on its highest-churn source file. Precision
 * stays high because the event is factual (zero test paths in the diff);
 * the finding asks for evidence, not a mandate. One finding max — this is
 * a signal, not a per-file nag.
 */
const missingTestRule: ReviewRule = {
  id: 'missing-test',
  description: 'source-only diffs that touch no test file get one file-level nit',
  run(diff) {
    let testTouched = false
    let topFile = ''
    let topAdds = 0
    const addsPerFile = new Map<string, number>()
    for (const { file } of addedLines(diff)) {
      if (isTestPath(file)) {
        testTouched = true
        continue
      }
      if (!CODE_FILE_RE.test(file)) continue
      if (DATA_PATH_RE.test(file) || GENERATED_FILE_RE.test(file) || SCRIPT_PATH_RE.test(file)) {
        continue
      }
      addsPerFile.set(file, (addsPerFile.get(file) ?? 0) + 1)
    }
    const srcFiles = addsPerFile.size
    for (const [f, n] of addsPerFile) {
      if (n > topAdds) {
        topAdds = n
        topFile = f
      }
    }
    if (srcFiles === 0 || testTouched || topFile === '') {
      return { findings: [], records: [] }
    }
    const detail = `source-only diff: ${srcFiles} source file(s), no test file`
    return {
      findings: [
        {
          file: topFile,
          severity: 'nit',
          category: 'testing',
          message:
            `nit: this diff modifies ${srcFiles} source file(s) and no test file - ` +
            'if the change is behavior-bearing, point at the coverage that exercises it.',
        },
      ],
      records: [{ file: topFile, detail }],
    }
  },
}

/** The rule registry — curated, not a plugin surface. */
export const REVIEW_RULES: readonly ReviewRule[] = [
  secretsRule,
  hardcodedEndpointRule,
  leftoverTodoRule,
  syncInAsyncRule,
  depDiffRule,
  missingTestRule,
]

/** All registered rule ids — the default `review.rules` enabled set. */
export const REVIEW_RULE_IDS: string[] = REVIEW_RULES.map((r) => r.id)

/**
 * Run the enabled rules over the materialized scan diff. Additive union
 * input for the review — output feeds report.rulesScan plus, for the
 * secrets rule, report.secretsScan (unchanged shape).
 */
export async function runRules(
  diff: string,
  opts: {
    /** Enabled ids; undefined = all. [] disables the lane. */
    enabled?: string[]
    /** Test seam — swap the registry. */
    rules?: ReviewRule[]
  } & RuleRunContext = {},
): Promise<RulesRunResult> {
  const registry = opts.rules ?? REVIEW_RULES
  const enabled = opts.enabled ?? registry.map((r) => r.id)
  // Rules see only the context contract, never the runner's opts bag.
  const { enabled: _enabled, rules: _rules, ...ctx } = opts
  const findings: RuleFinding[] = []
  const records: RuleRecord[] = []
  const failures: RuleFailure[] = []
  let secretsScan: SecretsScanResult | undefined
  const ran: string[] = []
  for (const rule of registry) {
    if (!enabled.includes(rule.id)) continue
    ran.push(rule.id)
    let out: RuleOutput
    try {
      out = await rule.run(diff, ctx)
      // A malformed resolve escapes the contract — count it as a rule
      // failure inside the same boundary so the lane still completes.
      if (
        out === null ||
        typeof out !== 'object' ||
        !Array.isArray(out.findings) ||
        !Array.isArray(out.records)
      ) {
        throw new Error('malformed RuleOutput (needs { findings, records })')
      }
    } catch (e) {
      // Failures are the audit channel for a throwing rule — no
      // double-record under `records`.
      failures.push({ rule: rule.id, error: e instanceof Error ? e.message : String(e) })
      continue
    }
    if (out.secretsScan !== undefined) secretsScan = out.secretsScan
    // Findings cap at RULE_HITS_CAP; records keep every hit up to
    // RULE_RECORDS_CAP, then collapse into a count-preserving aggregate.
    const overflow = Math.max(0, out.records.length - RULE_RECORDS_CAP)
    for (const r of out.records.slice(0, RULE_RECORDS_CAP)) {
      records.push({ ...r, rule: rule.id })
    }
    if (overflow > 0) {
      records.push({
        rule: rule.id,
        file: '-',
        detail: `${overflow} hit(s) over the ${RULE_RECORDS_CAP}-record cap`,
        suppressed: 'record-cap',
      })
    }
    // Severity ceiling + hit cap in one pass — records stay complete
    // (every hit is an audit entry) while findings bound the union.
    let emitted = 0
    let over = 0
    for (const f of out.findings) {
      let g = f
      if (f.severity === 'bug' && f.p === undefined) {
        // A deterministic hit cannot claim `bug` without adjudicated
        // confidence riding on it. The `bug:` token inside the message
        // text must demote with the field — downstream readers derive
        // severity from that prefix.
        records.push({
          rule: rule.id,
          file: f.file,
          ...(f.line !== undefined ? { line: f.line } : {}),
          detail: 'unadjudicated bug claim',
          suppressed: 'severity-ceiling',
        })
        g = { ...f, severity: 'risk', message: f.message.replace(/\bbug:/, 'risk:') }
      }
      if (emitted < RULE_HITS_CAP) {
        findings.push({ ...g, rule: rule.id })
        emitted++
      } else {
        over++
      }
    }
    if (over > 0) {
      findings.push({
        file: '-',
        severity: 'nit',
        message:
          `${rule.id}: ${over} further hit(s) over the ${RULE_HITS_CAP}-finding ` +
          'cap; see rulesScan records for the full audit.',
      })
      records.push({
        rule: rule.id,
        file: '-',
        detail: `${over} finding(s) over cap`,
        suppressed: 'hit-cap',
      })
    }
  }
  return {
    findings,
    records,
    failures,
    ran,
    ...(secretsScan !== undefined ? { secretsScan } : {}),
  }
}
