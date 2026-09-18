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
import { DecisionError, type DecisionClient, type DecisionQuestion } from '../vision/decisions.js'

export const TRIAGE_AREAS = ['auth', 'billing', 'data', 'ops', 'none'] as const
export type TriageArea = (typeof TRIAGE_AREAS)[number]

export interface TriageRecord {
  mode: 'annotate' | 'route'
  /** noul 0–1 — does this PR warrant careful review. */
  needsDeepReview?: number
  /** score 1–5 blast-radius rubric. */
  risk?: number
  topRiskArea?: TriageArea
  /** Choice-answer confidence when the API provides one. */
  topRiskAreaConfidence?: number
  /** decide() failed or answers failed validation — degrade-open marker. */
  unadjudicated?: boolean
  /** Decision model that produced the record (empty when none ran). */
  model: string
}

/** Diff excerpt bound — triage needs shape, not full fidelity. */
const MAX_DIFF_STATE_CHARS = 12_000
const MAX_TITLE_CHARS = 300
const MAX_BODY_CHARS = 2_000

export interface TriageState {
  title: string
  body: string
  files: string[]
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
    if (f.patch === undefined || budget <= 0) continue
    const take = f.patch.slice(0, budget)
    excerpts.push(take)
    budget -= take.length
  }
  return {
    title: (opts.title ?? '').slice(0, MAX_TITLE_CHARS),
    body: (opts.body ?? '').slice(0, MAX_BODY_CHARS),
    files: opts.files.map((f) => f.filename),
    diffExcerpt: excerpts.join('\n\n'),
  }
}

export function buildTriageQuestions(): Record<string, DecisionQuestion> {
  return {
    needs_deep_review: {
      type: 'noul',
      instructions:
        'does this PR warrant careful review beyond a skim? yes for changes touching ' +
        'auth, money, data integrity, concurrency, secrets handling, public APIs, or ' +
        'irreversible ops; no for docs, comments, formatting, or metadata-only changes.',
    },
    risk: {
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
    top_risk_area: {
      type: 'choice',
      instructions: 'the single subsystem most likely to hide a defect in this diff.',
      criteria: {
        auth: 'authentication, authorization, tokens, sessions, permissions',
        billing: 'payments, invoices, usage metering, cost accounting',
        data: 'persistence, migrations, integrity, serialization, caching',
        ops: 'CI, deploy, infra, configuration, tooling, observability',
        none: 'no meaningful risk area in this diff',
      },
    },
  }
}

export async function triagePr(opts: {
  client: DecisionClient
  model?: string
  state: TriageState
  mode: 'annotate' | 'route'
}): Promise<TriageRecord> {
  const questions = buildTriageQuestions()
  try {
    const { answers, model } = await opts.client.decide({
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      state: opts.state,
      questions,
    })
    const deep = answers['needs_deep_review']
    const risk = answers['risk']
    const area = answers['top_risk_area']
    const rec: TriageRecord = { mode: opts.mode, model }
    if (deep !== undefined && 'noul' in deep) rec.needsDeepReview = deep.noul
    if (risk !== undefined && 'score' in risk) rec.risk = risk.score
    if (area !== undefined && 'choice' in area) {
      const c = area.choice as TriageArea
      if (TRIAGE_AREAS.includes(c)) {
        rec.topRiskArea = c
        if (area.confidence !== undefined) rec.topRiskAreaConfidence = area.confidence
      }
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
    debug(
      'triage',
      `adjudication failed — degrading to annotate: ${e instanceof DecisionError ? e.kind : (e as Error).message}`,
    )
    return { mode: opts.mode, model: opts.model ?? '', unadjudicated: true }
  }
}

/**
 * 'route' mode model selection — cheap tier only on a clear low-risk
 * signal (risk ≤ 2 AND deep-review < 0.5). Any ambiguity (missing
 * fields, unadjudicated, unset lowRiskModel) keeps the configured model:
 * coverage stays constant and the expensive path is the default.
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
    rec.needsDeepReview === undefined
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
