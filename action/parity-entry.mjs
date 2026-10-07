// Entry point for `npm run build:parity` — esbuild bundles these shared
// report/inline helpers from src/ into action/parity.cjs. The action's
// sticky-comment.cjs destructures this file at require() time, so the
// GitHub-posted review text can never drift from the CLI's renderers.
// Edit the sources, run `npm run build:parity`, commit both artifacts.

export {
  formatUsd,
  manifestToRunView,
  maskSecrets,
  PROOF_LEVELS,
  proofMeter,
  SEVERITIES,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  STATUS_GLYPH,
  VERDICT_LABEL,
  VERDICT_STATUS,
  verdictGlyph,
} from '../src/report/viewmodel.js'

export { LANE_IDS } from '../src/report/manifest.js'

export {
  bestFindingProof,
  cell,
  code,
  conclusionFromReport,
  findingsOf,
  laneProof,
  manifestDuration,
  manifestRow,
  plural,
  reproducedCount,
  sanitizeCommentText,
  SENTINEL,
  verdictLead,
} from '../src/report/comment.js'

export {
  extractSuggestion,
  INLINE_SENTINEL,
  inlineDedupKey,
  isArgusInlineBody,
  normalizeFindingMessage,
  parseInlineBody,
  shortHash,
} from '../src/review/inline.js'
