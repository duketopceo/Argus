import { debug } from '../debug.js'
import {
  DecisionClient,
  describeDecisionError,
  isNoulAnswer,
  MAX_CANDIDATES,
} from '../vision/decisions.js'

/**
 * U4(b) reflection pass — one batched confidence-model decide() re-reads each
 * surviving model finding against its file's patch and drops findings whose
 * claim the diff does not support. This is the grounding check, distinct from
 * adjudication's worth-acting-on judgment: a finding citing code the patch
 * does not show, or faulting the diff for something it names but does not own,
 * is ungrounded regardless of severity.
 *
 * Unlike adjudication, reflection may drop a `bug`/`risk` — that is its
 * purpose — so it runs BEFORE adjudication and the rules union, keeping
 * ungrounded claims out of the gate and out of the probe lane. Dropped
 * findings stay in the audit record (records[].dropped) — nothing vanishes.
 * Rules-lane findings never enter; the deterministic lane cannot be reflected
 * away. A failed call is unchecked, not a wipe: degrade open, keep everything.
 */

export interface ReflectableFinding {
  file: string
  line?: number
  severity: string
  category?: string
  message: string
}

interface FindingReflectionRecord {
  file: string
  line?: number
  severity: string
  /** Finding text — capped; dropped findings keep their message in audit. */
  message: string
  checked: boolean
  /** Confidence-model P(the patch supports the finding's claim). */
  grounded?: number
  /** grounded below the floor — kept for audit, removed from findings. */
  dropped?: boolean
}

/** The audit half of the result — what report.reflection stores. */
export interface FindingReflectionAudit {
  records: FindingReflectionRecord[]
  /** Checked findings the reflector dropped as ungrounded. */
  dropped: number
  /** Findings past MAX_CANDIDATES — unchecked, never dropped. */
  overflow: number
  /** Whole-call failure — nothing checked, nothing dropped. */
  unchecked?: boolean
}

export interface FindingReflectionResult<T extends ReflectableFinding>
  extends FindingReflectionAudit {
  /** Surviving findings. */
  findings: T[]
}

/** P(grounded) below which a finding is dropped — conservative floor. */
const GROUNDED_FLOOR = 0.3

const MAX_PATCH_EXCERPT = 4000
/** Aggregate patch-state bound — 50 unique files x 4KB is still ~200KB. */
const MAX_PATCH_STATE_CHARS = 24_000
/** Audit-record message bound — full text already lives in findings. */
const MAX_RECORD_MESSAGE = 300

export async function reflectFindings<T extends ReflectableFinding>(opts: {
  findings: T[]
  /** PR file patches keyed by filename — grounding context. */
  patchByFile?: Map<string, string>
  floor?: number
  client: DecisionClient
  model?: string
}): Promise<FindingReflectionResult<T>> {
  const capped = opts.findings.slice(0, MAX_CANDIDATES)
  const overflow = opts.findings.length - capped.length
  const floor = opts.floor ?? GROUNDED_FLOOR

  const groundedByIdx: (number | undefined)[] = new Array<number | undefined>(capped.length)
  let reflectionFailed = false

  if (capped.length > 0) {
    try {
      const questions: Record<string, { type: 'noul'; instructions: string }> = {}
      capped.forEach((_f, i) => {
        questions[`f_${i}`] = {
          type: 'noul',
          instructions:
            `state.findings[${i}]: is the claim in this code-review finding ` +
            'actually supported by the patch under state.patches? Answer no ' +
            'when the finding cites code or hunks absent from the patch, ' +
            'misreads what the diff changes, or faults the diff for not ' +
            'changing something it names but legitimately does not own.',
        }
      })
      // Patches keyed by file, sent once — same bounded-state shape as
      // adjudication; an aggregate bound caps the whole call.
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
        groundedByIdx[i] = a !== undefined && isNoulAnswer(a) ? a.noul : undefined
      })
    } catch (e) {
      reflectionFailed = true
      debug('reflect', `decision call failed – nothing dropped: ${describeDecisionError(e)}`)
    }
  }

  const findings: T[] = []
  const records: FindingReflectionRecord[] = []
  let dropped = 0
  capped.forEach((f, i) => {
    const grounded = groundedByIdx[i]
    const checked = grounded !== undefined && !reflectionFailed
    const drop = checked && grounded !== undefined && grounded < floor
    records.push({
      file: f.file,
      ...(f.line !== undefined ? { line: f.line } : {}),
      severity: f.severity,
      message: f.message.slice(0, MAX_RECORD_MESSAGE),
      checked,
      ...(grounded !== undefined ? { grounded } : {}),
      ...(drop ? { dropped: true } : {}),
    })
    if (drop) dropped += 1
    else findings.push(f)
  })

  // Overflow findings keep their place — never checked, never dropped.
  for (const f of opts.findings.slice(MAX_CANDIDATES)) findings.push(f)

  return {
    findings,
    records,
    dropped,
    overflow,
    ...(reflectionFailed ? { unchecked: true } : {}),
  }
}
