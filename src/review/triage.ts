/**
 * U7 PR triage lane — one batched `decide` call before chunk review
 * produces a typed-probability triage record (the pace two-round
 * pattern). Jev routes and annotates, never gates: every chunk is still
 * reviewed by a code model and the deterministic verdict stays
 * authoritative. `decide` failure degrades open — the record lands with
 * `unadjudicated` and routing keeps the configured (strong) model.
 *
 * PR title/body in `state` are untrusted text — Jev is the only
 * consumer; they never reach the verdict path.
 */
import { debug } from '../debug.js'
import {
  describeDecisionError,
  isChoiceAnswer,
  isNoulAnswer,
  isScoreAnswer,
  JEV_DEFAULT_MODEL,
  type DecisionClient,
  type DecisionQuestion,
} from '../vision/decisions.js'

// The choice criteria own the vocabulary — TRIAGE_AREAS derives from
// it so an offered option can never drift out of the record type.
const RISK_AREA_CRITERIA = {
  auth: 'authentication, authorization, tokens, sessions, permissions',
  billing: 'payments, invoices, usage metering, cost accounting',
  data: 'persistence, migrations, integrity, serialization, caching',
  ops: 'CI, deploy, infra, configuration, tooling, observability',
  none: 'no meaningful risk area in this diff',
} as const

export const TRIAGE_AREAS = Object.keys(RISK_AREA_CRITERIA) as TriageArea[]
export type TriageArea = keyof typeof RISK_AREA_CRITERIA

export interface TriageRecord {
  mode: 'annotate' | 'route'
  /** noul 0–1 — does this PR warrant careful review. */
  needsDeepReview?: number
  /** score 1–5 blast-radius rubric. */
  risk?: number
  topRiskArea?: TriageArea
  /** Choice-answer confidence when the API provides one. */
  topRiskAreaConfidence?: number
  /** Chars of diff evidence Jev saw — route mode won't downgrade on 0. */
  diffExcerptChars?: number
  /** decide() failed or answers failed validation — degrade-open marker. */
  unadjudicated?: boolean
  /** Decision model that produced (or attempted) the record. */
  model: string
}

/** Diff excerpt bound — triage needs shape, not full fidelity. */
const MAX_DIFF_STATE_CHARS = 12_000
/** Per-file bound — one huge patch must not starve every other file. */
const MAX_FILE_EXCERPT = 4_000
const MAX_TITLE_CHARS = 300
const MAX_BODY_CHARS = 2_000
const MAX_FILE_LIST = 100

export interface TriageState {
  title: string
  body: string
  files: string[]
  totalFiles: number
  diffExcerpt: string
}

export function buildTriageState(opts: {
  title?: string | undefined
  body?: string | undefined
  files: { filename: string; patch?: string }[]
}): TriageState {
  let budget = MAX_DIFF_STATE_CHARS
  const excerpts: string[] = []
  for (const f of opts.files) {
    if (budget <= 0) break
    if (f.patch === undefined) continue
    const take = f.patch.slice(0, Math.min(budget, MAX_FILE_EXCERPT))
    excerpts.push(take)
    budget -= take.length
  }
  return {
    title: (opts.title ?? '').slice(0, MAX_TITLE_CHARS),
    body: (opts.body ?? '').slice(0, MAX_BODY_CHARS),
    files: opts.files.slice(0, MAX_FILE_LIST).map((f) => f.filename),
    totalFiles: opts.files.length,
    diffExcerpt: excerpts.join('\n\n'),
  }
}

/** Question IDs — one spelling for builder and reader. */
const Q = { deep: 'needs_deep_review', risk: 'risk', area: 'top_risk_area' } as const

function buildTriageQuestions(): Record<string, DecisionQuestion> {
  return {
    [Q.deep]: {
      type: 'noul',
      instructions:
        'does this PR warrant careful review beyond a skim? yes for changes touching ' +
        'auth, money, data integrity, concurrency, secrets handling, public APIs, or ' +
        'irreversible ops; no for docs, comments, formatting, or metadata-only changes.',
    },
    [Q.risk]: {
      type: 'score',
      instructions: 'blast radius if this PR merges broken — pick the closest rubric level.',
      criteria: [
        'cosmetic only — docs, comments, formatting, metadata',
        'minor — internal-only paths, limited blast radius',
        'moderate — user-visible defects plausible',
        'high — security-sensitive or data-handling paths touched',
        'severe — auth, billing, or data-loss surface',
      ],
    },
    [Q.area]: {
      type: 'choice',
      instructions: 'the single subsystem most likely to hide a defect in this diff.',
      criteria: RISK_AREA_CRITERIA,
    },
  }
}

export async function triagePr(opts: {
  client: DecisionClient
  model?: string
  state: TriageState
  mode: 'annotate' | 'route'
}): Promise<TriageRecord> {
  try {
    const { answers, model } = await opts.client.decide({
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      state: opts.state,
      questions: buildTriageQuestions(),
    })
    const deep = answers[Q.deep]
    const risk = answers[Q.risk]
    const area = answers[Q.area]
    const rec: TriageRecord = {
      mode: opts.mode,
      model,
      diffExcerptChars: opts.state.diffExcerpt.length,
    }
    if (deep !== undefined && isNoulAnswer(deep)) rec.needsDeepReview = deep.noul
    if (risk !== undefined && isScoreAnswer(risk)) rec.risk = risk.score
    if (
      area !== undefined &&
      isChoiceAnswer(area) &&
      TRIAGE_AREAS.includes(area.choice as TriageArea)
    ) {
      rec.topRiskArea = area.choice as TriageArea
      if (area.confidence !== undefined) rec.topRiskAreaConfidence = area.confidence
    }
    // A call that answered none of the typed questions adjudicated nothing.
    if (
      rec.needsDeepReview === undefined &&
      rec.risk === undefined &&
      rec.topRiskArea === undefined
    ) {
      rec.unadjudicated = true
    }
    return rec
  } catch (e) {
    debug('triage', `adjudication failed — degrading to annotate: ${describeDecisionError(e)}`)
    return { mode: opts.mode, model: opts.model ?? JEV_DEFAULT_MODEL, unadjudicated: true }
  }
}

/**
 * 'route' mode model selection — cheap tier only on a clear low-risk
 * signal (risk ≤ 2 AND deep-review < 0.5) backed by actual diff
 * evidence. Any ambiguity (missing fields, unadjudicated, unset
 * lowRiskModel, or a title/body-only triage — fully attacker-steerable
 * text) keeps the configured model: coverage stays constant and the
 * expensive path is the default.
 */
export function routeModel(opts: {
  record: TriageRecord | undefined
  configured: string
  lowRiskModel: string | undefined
}): { model: string; reason: string } {
  const rec = opts.record
  if (
    rec === undefined ||
    rec.mode !== 'route' ||
    rec.unadjudicated === true ||
    opts.lowRiskModel === undefined ||
    rec.risk === undefined ||
    rec.needsDeepReview === undefined ||
    (rec.diffExcerptChars ?? 0) === 0
  ) {
    return { model: opts.configured, reason: 'no routing signal' }
  }
  if (rec.risk <= 2 && rec.needsDeepReview < 0.5) {
    return {
      model: opts.lowRiskModel,
      reason: `low risk — risk=${rec.risk}, needsDeepReview=${rec.needsDeepReview.toFixed(2)}`,
    }
  }
  return {
    model: opts.configured,
    reason: `risk=${rec.risk}, needsDeepReview=${rec.needsDeepReview.toFixed(2)}`,
  }
}

/** U9 ordering signal consumed by the probe lane. */
export interface TriageAreaSignal {
  area: TriageArea
  confidence: number
}

/**
 * U9 — the probe lane's advisory ordering signal. Present only when
 * triage adjudicated a real area with its confidence attached; 'none'
 * is the null-area sentinel, not an ordering signal, and the
 * confidence floor itself is queue policy (MIN_AREA_CONFIDENCE).
 */
export function triageAreaSignal(rec: TriageRecord | undefined): TriageAreaSignal | undefined {
  if (
    rec === undefined ||
    rec.unadjudicated === true ||
    rec.topRiskArea === undefined ||
    rec.topRiskArea === 'none' ||
    rec.topRiskAreaConfidence === undefined
  ) {
    return undefined
  }
  return { area: rec.topRiskArea, confidence: rec.topRiskAreaConfidence }
}
