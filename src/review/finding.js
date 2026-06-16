// Finding model for the dbt PR review — faithful port of altimate-code's
// `review/finding.ts`. A Finding is the atomic unit the verdict is mechanically
// derived from (never from model free-text). `confidence: "unknown"` is a
// first-class state: an undecidable result downgrades and must never accumulate
// into a block (see verdict.js).
//
// Pure JS. No network, no LLM.
import { createHash } from "node:crypto";
import { clampSeverity } from "./rubric.js";

export const SEVERITIES = ["critical", "warning", "suggestion"];
// Absolute values match upstream finding.ts (only relative order is used).
export const SEVERITY_ORDER = { critical: 3, warning: 2, suggestion: 1 };
export const CONFIDENCES = ["high", "medium", "low", "unknown"];

// The review categories — faithful to upstream finding.ts ReviewCategory. The
// default blocking set (rubric.js blockOn) is a subset of these.
export const REVIEW_CATEGORIES = [
  "lineage_breakage",
  "semantic_change",
  "contract_violation",
  "pii_exposure",
  "materialization",
  "warehouse_cost",
  "test_coverage",
  "sql_quality",
  "idempotency",
  "freshness",
  "join_risk",
  "fanout",
  "dedup",
  "sql_correctness",
];

// Fingerprint: f_ + sha256(category file model column ruleKey, lowercased, space-joined).slice(0,16)
// — matches upstream finding.ts so the same issue from two lanes dedupes to one.
export function fingerprint({ category, file, model, column, ruleKey }) {
  const canonical = [category, file, model ?? "", column ?? "", ruleKey]
    .map((s) => String(s).trim().toLowerCase())
    .join(" ");
  return "f_" + createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Build a Finding. ruleKey defaults to the title; severity is clamped (unknown/low critical → warning). */
export function makeFinding(input) {
  const id =
    input.id ??
    fingerprint({
      category: input.category,
      file: input.file,
      model: input.model,
      column: input.column,
      ruleKey: input.ruleKey ?? input.title,
    });
  const confidence = input.confidence ?? "high";
  return {
    id,
    severity: clampSeverity(input.category, input.severity, confidence),
    category: input.category,
    title: input.title,
    body: input.body ?? "",
    file: input.file,
    startLine: input.startLine,
    endLine: input.endLine,
    model: input.model,
    column: input.column,
    confidence,
    degraded: input.degraded ?? false,
    evidence: input.evidence, // { tool, result }
  };
}

// Matches upstream tieKey: line-less findings sort last (MAX_SAFE_INTEGER).
const tieKey = (f) => `${f.startLine ?? Number.MAX_SAFE_INTEGER} ${f.title} ${f.body}`;

/** Deduplicate by fingerprint, keeping the highest-severity instance; stable tie-break. */
export function dedupeFindings(findings) {
  const byId = new Map();
  for (const f of findings) {
    const existing = byId.get(f.id);
    if (!existing) {
      byId.set(f.id, f);
      continue;
    }
    const bySev = SEVERITY_ORDER[f.severity] - SEVERITY_ORDER[existing.severity];
    if (bySev > 0 || (bySev === 0 && tieKey(f) < tieKey(existing))) byId.set(f.id, f);
  }
  return [...byId.values()];
}
