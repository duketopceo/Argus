/* eslint-disable */ /* GENERATED - do not edit; npm run build:parity */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// action/parity-entry.mjs
var parity_entry_exports = {};
__export(parity_entry_exports, {
  INLINE_SENTINEL: () => INLINE_SENTINEL,
  LANE_IDS: () => LANE_IDS,
  PROOF_LEVELS: () => PROOF_LEVELS,
  SENTINEL: () => SENTINEL,
  SEVERITIES: () => SEVERITIES,
  SEVERITY_GLYPH: () => SEVERITY_GLYPH,
  SEVERITY_LABEL: () => SEVERITY_LABEL,
  STATUS_GLYPH: () => STATUS_GLYPH,
  VERDICT_LABEL: () => VERDICT_LABEL,
  VERDICT_STATUS: () => VERDICT_STATUS,
  bestFindingProof: () => bestFindingProof,
  cell: () => cell,
  code: () => code,
  conclusionFromReport: () => conclusionFromReport,
  extractSuggestion: () => extractSuggestion,
  findingsOf: () => findingsOf,
  formatUsd: () => formatUsd,
  inlineDedupKey: () => inlineDedupKey,
  isArgusInlineBody: () => isArgusInlineBody,
  laneProof: () => laneProof,
  manifestDuration: () => manifestDuration,
  manifestRow: () => manifestRow,
  manifestToRunView: () => manifestToRunView,
  maskSecrets: () => maskSecrets,
  normalizeFindingMessage: () => normalizeFindingMessage,
  parseInlineBody: () => parseInlineBody,
  plural: () => plural,
  proofMeter: () => proofMeter,
  reproducedCount: () => reproducedCount,
  sanitizeCommentText: () => sanitizeCommentText,
  shortHash: () => shortHash,
  verdictGlyph: () => verdictGlyph,
  verdictLead: () => verdictLead
});
module.exports = __toCommonJS(parity_entry_exports);

// src/report/manifest.ts
var LANE_IDS = ["review", "flow", "app", "a0"];

// src/report/viewmodel.ts
var LANE_STATUS_LABEL = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  blocked: "blocked",
  unavailable: "unavailable",
  inconclusive: "inconclusive"
};
var STATUS_GLYPH = {
  passed: "\u25CF",
  failed: "\u2298",
  skipped: "\u2013",
  blocked: "\u2296",
  unavailable: "\u25CC",
  inconclusive: "\u25D0"
};
var PROOF_LEVELS = ["suspected", "corroborated", "exercised", "reproduced"];
var PROOF_NOTCH_FILLED = "\u25B0";
var PROOF_NOTCH_EMPTY = "\u25B1";
function proofMeter(level) {
  const filled = PROOF_LEVELS.indexOf(level ?? "") + 1;
  return PROOF_NOTCH_FILLED.repeat(filled) + PROOF_NOTCH_EMPTY.repeat(PROOF_LEVELS.length - filled);
}
var SEVERITIES = ["bug", "risk", "nit", "q"];
var SEVERITY_GLYPH = {
  bug: "\u25C6",
  risk: "\u25C8",
  nit: "\u25CB",
  q: "\u25A1"
};
var SEVERITY_LABEL = {
  bug: "bug",
  risk: "risk",
  nit: "nit",
  q: "question"
};
var VERDICT_STATUS = {
  approve: "passed",
  needs_changes: "failed",
  pass: "passed"
};
var VERDICT_LABEL = {
  approve: "approve",
  needs_changes: "needs changes",
  pass: "clean"
};
function verdictGlyph(verdict) {
  return STATUS_GLYPH[VERDICT_STATUS[verdict]];
}
function laneDurationMs(lane) {
  if (lane.startedAt === void 0 || lane.finishedAt === void 0) return void 0;
  const ms = Date.parse(lane.finishedAt) - Date.parse(lane.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : void 0;
}
function laneView(lane) {
  return {
    lane: lane.lane,
    selected: lane.selected,
    status: lane.status,
    statusLabel: LANE_STATUS_LABEL[lane.status],
    statusIcon: STATUS_GLYPH[lane.status],
    summary: lane.summary,
    reason: lane.reason,
    reportPath: lane.reportPath,
    model: lane.model ?? lane.usage?.model,
    usage: lane.usage,
    budget: lane.budget,
    cache: lane.cache,
    headBinding: lane.headBinding,
    startedAt: lane.startedAt,
    finishedAt: lane.finishedAt,
    durationMs: laneDurationMs(lane)
  };
}
function manifestToRunView(manifest) {
  const lanes = LANE_IDS.map((id) => laneView(manifest.lanes[id]));
  return {
    runId: manifest.runId,
    schemaVersion: manifest.schemaVersion,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    status: manifest.aggregate.status,
    statusLabel: LANE_STATUS_LABEL[manifest.aggregate.status],
    statusIcon: STATUS_GLYPH[manifest.aggregate.status],
    ok: manifest.aggregate.ok,
    costUsd: manifest.aggregate.costUsd,
    calls: manifest.aggregate.calls,
    tokens: manifest.aggregate.tokens,
    repo: manifest.identity.repo,
    pr: manifest.identity.pr,
    intendedHeadSha: manifest.identity.intendedHeadSha,
    checkoutSha: manifest.identity.checkoutSha,
    headBinding: manifest.lanes.review.headBinding,
    lanes,
    selectedLanes: lanes.filter((lane) => lane.selected)
  };
}
var SECRET_PATTERNS = [
  /sk-or-[A-Za-z0-9_-]{4,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9_]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /npm_[A-Za-z0-9]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /:\/\/[^/\s:@]{1,64}:[^/\s:@]{6,}@/g
];
function maskSecrets(s) {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "\u2022\u2022\u2022");
  return out;
}
function formatUsd(n) {
  return `$${(n ?? 0).toFixed(6)}`;
}

// src/review/inline.ts
var INLINE_SENTINEL = "<!-- argus-reviewer:inline -->";
var LEGACY_PREFIX = "**argus-reviewer";
var LEGACY_LINE = /^\*\*argus-reviewer ([^:*]+):\*\* ?(.*)$/;
var SEVERITY_LINE = /^(?:\S+ )?\*\*([^*]+)\*\* · /;
var CATEGORY_SUFFIX = /\s*`(?:correctness|security|performance|usability|convention|other)`$/;
var MESSAGE_PREFIX = new RegExp("^(?:L\\d+(?:-\\d+)?:|\\p{Extended_Pictographic}\\u{FE0F}?|(?:bug|risk|nit|q|question):)\\s*", "iu");
function normalizeFindingMessage(message) {
  let out = message.trim();
  for (let i = 0; i < 4; i++) {
    const next = out.replace(MESSAGE_PREFIX, "");
    if (next === out) break;
    out = next;
  }
  return out;
}
function keyMessage(message) {
  return normalizeFindingMessage(message.replace(CATEGORY_SUFFIX, "")).replace(/\s+/g, " ").trim();
}
var LABEL_TO_SEVERITY = new Map(SEVERITIES.map((s) => [SEVERITY_LABEL[s], s]));
function parseInlineBody(body) {
  const lines = body.split(/\r?\n/);
  if (body.startsWith(LEGACY_PREFIX)) {
    const m = LEGACY_LINE.exec(lines[0] ?? "");
    if (m === null) return void 0;
    return { severity: (m[1] ?? "").trim(), message: keyMessage(m[2] ?? "") };
  }
  if (lines[0] === INLINE_SENTINEL) {
    const m = SEVERITY_LINE.exec(lines[1] ?? "");
    if (m === null) return void 0;
    const word = (m[1] ?? "").trim();
    return { severity: LABEL_TO_SEVERITY.get(word) ?? word, message: keyMessage(lines[2] ?? "") };
  }
  return void 0;
}
function isArgusInlineBody(body) {
  return body.startsWith(LEGACY_PREFIX) || body.startsWith(INLINE_SENTINEL);
}
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h << 5) + h + s.charCodeAt(i) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}
function extractSuggestion(body) {
  const m = /\r?\n(`{4,})suggestion\r?\n([\s\S]*?)\r?\n\1/.exec(body);
  return m?.[2] ?? "";
}
function inlineDedupKey(path, line, body) {
  const parsed = parseInlineBody(body);
  const hash = shortHash(extractSuggestion(body));
  if (parsed === void 0) return `${path}:${line}:${body.split("\n")[0]}:${hash}`;
  return `${path}:${line}:${parsed.severity}:${parsed.message}:${hash}`;
}

// src/report/comment.ts
var SENTINEL = "<!-- argus-reviewer -->";
function cell(s, max = 200) {
  return maskSecrets(
    String(s ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ")
  ).slice(0, max);
}
function code(s) {
  const t = cell(s);
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}
var MAX_COMMENT_MESSAGE = 500;
function sanitizeCommentText(s) {
  return s.replace(/\s+/g, " ").replace(/([`~])\1{2,}/g, (run) => `${run[0]}\u200B${run.slice(1)}`).replace(/@(?=[A-Za-z0-9])/g, "@\u200B").replace(/\]\(/g, "]\u200B(").replace(/<\//g, "<\u200B/").trim().slice(0, MAX_COMMENT_MESSAGE);
}
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
function findingsOf(cr) {
  return cr !== void 0 && Array.isArray(cr.findings) ? cr.findings : [];
}
function bestFindingProof(cr) {
  let best = 0;
  for (const f of findingsOf(cr)) {
    best = Math.max(best, PROOF_LEVELS.indexOf(f.evidence?.status ?? ""));
  }
  return PROOF_LEVELS[best] ?? "suspected";
}
function laneProof(lane, status, cr) {
  if (status === "skipped") return null;
  if (status === "blocked" || status === "unavailable") return "none";
  if (status === "inconclusive" || lane === "a0") return "suspected";
  if (lane === "review") return bestFindingProof(cr);
  return "exercised";
}
function manifestRow(lane, cr) {
  if (!lane.selected) {
    return { lane: lane.lane, status: "skipped", result: "not selected", proof: null, spend: "" };
  }
  return {
    lane: lane.lane,
    status: lane.status,
    result: lane.reason ?? lane.summary ?? "",
    proof: laneProof(lane.lane, lane.status, cr),
    spend: lane.usage.metered ? formatUsd(lane.usage.costUsd) : "unmetered"
  };
}
function reproducedCount(cr) {
  return typeof cr.provenBlockers === "number" ? cr.provenBlockers : findingsOf(cr).filter((f) => f.evidence?.status === "reproduced").length;
}
var settled = (s) => s === "passed" || s === "skipped";
var MARKDOWN_LEAD = { strong: (s) => `**${s}**`, code, text: cell };
function verdictLead(rows, cr, f = MARKDOWN_LEAD) {
  const findings = findingsOf(cr);
  const reviewed = cr !== void 0 && cr.skipped !== true;
  if (reviewed) {
    const reproduced = reproducedCount(cr);
    if (reproduced > 0) {
      const files = new Set(findings.filter((x) => x.evidence?.status === "reproduced").map((x) => x.file));
      const where = files.size === 1 ? ` in ${f.code([...files][0])}` : "";
      return `${f.strong(`${plural(reproduced, "finding")} reproduced`)}${where}`;
    }
  }
  const failing = rows.filter((r) => r.lane !== "review" && !settled(r.status));
  if (failing.length > 0) return f.strong(failing.map((r) => `${f.text(r.lane)} ${r.status}`).join(", "));
  if (reviewed && findings.length > 0) return f.strong(`${plural(findings.length, "finding")}, none reproduced`);
  const review = rows.find((r) => r.lane === "review");
  if (review !== void 0 && !settled(review.status)) return f.strong(`review ${review.status}`);
  if (reviewed) return f.strong("No findings");
  return f.strong(rows.some((r) => r.status !== "skipped") ? "All selected lanes passed" : "No lane ran");
}
function manifestDuration(m) {
  const ms = Date.parse(m.finishedAt) - Date.parse(m.startedAt);
  return Number.isFinite(ms) ? ms : void 0;
}
function conclusionFromReport(report, missingKey = false) {
  if (missingKey) return "neutral";
  if (!report) return "failure";
  return report.ok ? "success" : "failure";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  INLINE_SENTINEL,
  LANE_IDS,
  PROOF_LEVELS,
  SENTINEL,
  SEVERITIES,
  SEVERITY_GLYPH,
  SEVERITY_LABEL,
  STATUS_GLYPH,
  VERDICT_LABEL,
  VERDICT_STATUS,
  bestFindingProof,
  cell,
  code,
  conclusionFromReport,
  extractSuggestion,
  findingsOf,
  formatUsd,
  inlineDedupKey,
  isArgusInlineBody,
  laneProof,
  manifestDuration,
  manifestRow,
  manifestToRunView,
  maskSecrets,
  normalizeFindingMessage,
  parseInlineBody,
  plural,
  proofMeter,
  reproducedCount,
  sanitizeCommentText,
  shortHash,
  verdictGlyph,
  verdictLead
});
