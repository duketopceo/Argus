import { debug } from '../debug.js'
import {
  DecisionClient,
  describeDecisionError,
  isNoulAnswer,
  MAX_CANDIDATES,
} from '../vision/decisions.js'

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
  category?: string
  /** Finding text — capped; suppressed findings keep their message in audit. */
  message: string
  adjudicated: boolean
  /** Jev P(true positive) for this finding. */
  p?: number
  /** nit/q below the FP bar — kept for audit, removed from findings. */
  suppressed?: boolean
}

/** The audit half of the result — what report.findingAdjudication stores. */
export interface FindingAdjudicationAudit {
  records: FindingAdjudicationRecord[]
  /** Findings past MAX_CANDIDATES — unadjudicated, never suppressed. */
  overflow: number
  /** Whole-call failure — nothing adjudicated, nothing suppressed. */
  unadjudicated?: boolean
}

export interface FindingAdjudicationResult<
  T extends AdjudicableFinding,
> extends FindingAdjudicationAudit {
  /** Surviving findings — adjudicated ones carry `p`. */
  findings: (T & { p?: number })[]
}

/** Suppression is scoped to severities that never drive the verdict. */
const SUPPRESSIBLE = new Set(['nit', 'q'])

const MAX_PATCH_EXCERPT = 4000
/** Aggregate patch-state bound — 50 unique files x 4KB is still ~200KB. */
const MAX_PATCH_STATE_CHARS = 24_000
/** Audit-record message bound — full text already lives in findings. */
const MAX_RECORD_MESSAGE = 300

export async function adjudicateFindings<T extends AdjudicableFinding>(opts: {
  findings: T[]
  /** PR file patches keyed by filename — Jev state context. */
  patchByFile?: Map<string, string>
  threshold: number
  /**
   * User-configured blocking severities — a severity listed here drives
   * the verdict, so it must never be suppressed even if it is nit/q
   * (otherwise Jev suppression could flip the commit-status gate).
   */
  blockSeverities?: string[]
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
            `state.findings[${i}]: is this code-review finding a real problem the ` +
            'PR author should act on? Its file patch is under state.patches. ' +
            'Answer no for speculative style nits, issues already handled by ' +
            'guards visible in the patch, and findings that merely restate ' +
            'what the code does.',
        }
      })
      // Each finding references its patch by filename — sending patches
      // once keyed by file avoids repeating a 4KB excerpt per finding
      // on the same file; an aggregate bound caps the whole state.
      const patches: Record<string, string> = {}
      let patchBudget = MAX_PATCH_STATE_CHARS
      for (const f of capped) {
        if (patchBudget <= 0) break
        if (patches[f.file] !== undefined) continue
        const p = opts.patchByFile?.get(f.file)
        if (p !== undefined) {
          const excerpt = p.slice(0, Math.min(MAX_PATCH_EXCERPT, patchBudget))
          patches[f.file] = excerpt
          patchBudget -= excerpt.length
        }
      }
      const state = {
        findings: capped.map((f) => ({
          file: f.file,
          line: f.line,
          severity: f.severity,
          message: f.message,
        })),
        patches,
      }
      const { answers } = await opts.client.decide({
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        state,
        questions,
      })
      capped.forEach((_f, i) => {
        const a = answers[`f_${i}`]
        pByIdx[i] = a !== undefined && isNoulAnswer(a) ? a.noul : undefined
      })
    } catch (e) {
      adjudicationFailed = true
      debug('adjudicate', `decision call failed — no suppression: ${describeDecisionError(e)}`)
    }
  }

  const blocking = new Set(opts.blockSeverities ?? [])
  // Only Jev may attach p — a model-emitted p on an unadjudicated
  // finding is spoofed confidence, so strip it.
  const stripP = (f: T): T & { p?: number } => {
    const out = { ...f } as T & { p?: number }
    delete out.p
    return out
  }
  const findings: (T & { p?: number })[] = []
  const records: FindingAdjudicationRecord[] = []
  capped.forEach((f, i) => {
    const p = pByIdx[i]
    const adjudicated = p !== undefined && !adjudicationFailed
    const suppress =
      adjudicated &&
      SUPPRESSIBLE.has(f.severity) &&
      !blocking.has(f.severity) &&
      p !== undefined &&
      p < 1 - opts.threshold
    records.push({
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      severity: f.severity,
      ...(f.category !== undefined ? { category: f.category } : {}),
      message: f.message.slice(0, MAX_RECORD_MESSAGE),
      adjudicated,
      ...(p !== undefined ? { p } : {}),
      ...(suppress ? { suppressed: true } : {}),
    })
    if (!suppress) {
      findings.push(p !== undefined ? { ...stripP(f), p } : stripP(f))
    }
  })

  // Overflow findings keep their place — never adjudicated, never
  // suppressed; count-only in the audit record like the secrets lane.
  for (const f of opts.findings.slice(MAX_CANDIDATES)) findings.push(stripP(f))

  return {
    findings,
    records,
    overflow,
    ...(adjudicationFailed ? { unadjudicated: true } : {}),
  }
}
