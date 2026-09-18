import { debug } from '../debug.js'
import { DecisionClient, DecisionError } from '../vision/decisions.js'
import { MAX_CANDIDATES } from './secrets.js'

/**
 * U8 finding adjudication — one batched Jev decide() scores each
 * synthesized finding's true-positive probability before posting. Same
 * posture as the secrets lane: Jev annotates/routes, never gates.
 * `p` lands on the finding record and the sticky confidence column;
 * suppression is scoped to `nit`/`q` severities whose false-positive
 * confidence exceeds `findingThreshold` — `bug`/`risk` are never
 * suppressed, and a Jev outage leaves every finding unadjudicated and
 * unsuppressed (degrade open).
 *
 * `findingThreshold` is the required P(false positive): a nit/q is
 * suppressed when `1 - p > threshold`, i.e. `p < 1 - threshold`.
 * Default 1.0 → nothing can exceed 100% FP → annotate-only.
 */

export interface AdjudicableFinding {
  file: string
  line?: number
  severity: string
  category?: string
  message: string
}

export interface FindingAdjudicationRecord {
  file: string
  line?: number
  severity: string
  adjudicated: boolean
  /** Jev P(true positive) for this finding. */
  p?: number
  /** nit/q below the FP bar — kept for audit, removed from findings. */
  suppressed?: boolean
}

export interface FindingAdjudicationResult<T extends AdjudicableFinding> {
  /** Surviving findings — adjudicated ones carry `p`. */
  findings: (T & { p?: number })[]
  records: FindingAdjudicationRecord[]
  /** Findings past MAX_CANDIDATES — unadjudicated, never suppressed. */
  overflow: number
  /** Whole-call failure — nothing adjudicated, nothing suppressed. */
  unadjudicated?: boolean
}

/** Suppression is scoped to severities that never drive the verdict. */
const SUPPRESSIBLE = new Set(['nit', 'q'])

const MAX_PATCH_EXCERPT = 4000

export async function adjudicateFindings<T extends AdjudicableFinding>(opts: {
  findings: T[]
  /** PR file patches keyed by filename — Jev state context. */
  patchByFile?: Map<string, string>
  threshold: number
  client: DecisionClient
  model?: string
}): Promise<FindingAdjudicationResult<T>> {
  const capped = opts.findings.slice(0, MAX_CANDIDATES)
  const overflow = opts.findings.length - capped.length

  const pByIdx: (number | undefined)[] = new Array<number | undefined>(capped.length)
  let adjudicationFailed = false

  if (capped.length > 0) {
    try {
      const questions: Record<string, { type: 'noul'; instructions: string }> = {}
      capped.forEach((_f, i) => {
        questions[`f_${i}`] = {
          type: 'noul',
          instructions:
            `state[${i}]: is this code-review finding a real problem the PR author ` +
            'should act on? Answer no for speculative style nits, issues already ' +
            'handled by guards visible in the patch, and findings that merely ' +
            'restate what the code does.',
        }
      })
      const state = capped.map((f) => ({
        file: f.file,
        line: f.line,
        severity: f.severity,
        message: f.message,
        patch: opts.patchByFile?.get(f.file)?.slice(0, MAX_PATCH_EXCERPT),
      }))
      const { answers } = await opts.client.decide({
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        state,
        questions,
      })
      capped.forEach((_f, i) => {
        const a = answers[`f_${i}`]
        pByIdx[i] = a !== undefined && 'noul' in a ? a.noul : undefined
      })
    } catch (e) {
      adjudicationFailed = true
      debug(
        'adjudicate',
        `decision call failed — no suppression: ${e instanceof DecisionError ? e.kind : (e as Error).message}`,
      )
    }
  }

  const findings: (T & { p?: number })[] = []
  const records: FindingAdjudicationRecord[] = []
  capped.forEach((f, i) => {
    const p = pByIdx[i]
    const adjudicated = p !== undefined && !adjudicationFailed
    const suppress =
      adjudicated && SUPPRESSIBLE.has(f.severity) && (p as number) < 1 - opts.threshold
    records.push({
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      severity: f.severity,
      adjudicated,
      ...(p !== undefined ? { p } : {}),
      ...(suppress ? { suppressed: true } : {}),
    })
    if (!suppress) {
      findings.push(p !== undefined ? { ...f, p } : f)
    }
  })

  // Overflow findings keep their place — never adjudicated, never
  // suppressed; count-only in the audit record like the secrets lane.
  for (const f of opts.findings.slice(MAX_CANDIDATES)) findings.push(f)

  return {
    findings,
    records,
    overflow,
    ...(adjudicationFailed ? { unadjudicated: true } : {}),
  }
}
