// The verdict contract — the signed, replayable artifact (faithful port of
// altimate-code's `review/verdict.ts`). Every verdict is mechanically derived
// from findings + rubric (never from model free-text) and signed (HMAC-SHA256)
// so it is tamper-evident and reproducible against the customer's manifest.
import { createHmac, createHash } from "node:crypto";
import { DEFAULT_RUBRIC, blockingCategories } from "./rubric.js";

export const VERDICTS = ["APPROVE", "COMMENT", "REQUEST_CHANGES"];
export const REVIEW_MODES = ["comment", "gate"];

/**
 * Maps a Verdict to a VCS review event. An `APPROVE` verdict posts a **COMMENT**,
 * NOT a formal approval: the bot must never satisfy branch protection on its own.
 * The "approved — no findings" outcome is conveyed in the comment body instead.
 */
export const VCS_EVENT = { APPROVE: "COMMENT", COMMENT: "COMMENT", REQUEST_CHANGES: "REQUEST_CHANGES" };

/**
 * Compute the verdict purely from findings + rubric. Bias-toward-approval rubric:
 *  - any blocking-category `critical`            → REQUEST_CHANGES
 *  - >= warningPatternThreshold confident warns  → REQUEST_CHANGES (risk pattern)
 *  - any finding at all                          → COMMENT
 *  - nothing                                     → APPROVE
 *
 * Undecidable ("unknown") warnings — e.g. equivalence that couldn't be proven —
 * must NOT accumulate into a block; that would let unprovable refactors fail the
 * gate. Advisory `ai-review` findings are likewise excluded (we have no second
 * model here, but the guard stays for parity).
 */
export function computeIdealVerdict(findings, rubric = DEFAULT_RUBRIC) {
  if (findings.length === 0) return "APPROVE";
  const blockers = blockingCategories(rubric);
  const hasBlockingCritical = findings.some((f) => f.severity === "critical" && blockers.has(f.category));
  if (hasBlockingCritical) return "REQUEST_CHANGES";
  const warningCount = findings.filter(
    (f) => f.severity === "warning" && f.confidence !== "unknown" && f.evidence?.tool !== "ai-review",
  ).length;
  if (warningCount >= rubric.warningPatternThreshold) return "REQUEST_CHANGES";
  return "COMMENT";
}

/** Apply mode-gating: in `comment` mode, REQUEST_CHANGES is softened to COMMENT. */
export function applyMode(verdict, mode) {
  if (mode === "comment" && verdict === "REQUEST_CHANGES") return "COMMENT";
  return verdict;
}

function summarize(findings, degraded) {
  const tally = { critical: 0, warning: 0, suggestion: 0 };
  for (const f of findings) tally[f.severity] = (tally[f.severity] ?? 0) + 1;
  return { ...tally, degraded };
}

// Deterministic serialization: keys sorted at EVERY depth, array order preserved,
// undefined dropped. An array-replacer JSON.stringify would drop nested findings[]
// fields (their keys aren't top-level), so the signature wouldn't cover finding
// content — this walks the value instead. Faithful to upstream verdict.ts.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

/** Canonical, signature-independent serialization for hashing/signing. */
export function canonicalBody(env) {
  const { signature: _sig, ...rest } = env;
  return stableStringify(rest);
}

/**
 * Sign the envelope. Key from ALTIMATE_REVIEW_SIGNING_KEY → "hmac:"+HMAC-SHA256;
 * absent → "sha256:"+plain digest (tamper-evident for replay, not authenticated).
 * Faithful to upstream verdict.ts (no hardcoded fallback key).
 */
export function signEnvelope(env, key) {
  const signingKey = key ?? process.env.ALTIMATE_REVIEW_SIGNING_KEY;
  const body = canonicalBody(env);
  const signature = signingKey
    ? "hmac:" + createHmac("sha256", signingKey).update(body).digest("hex")
    : "sha256:" + createHash("sha256").update(body).digest("hex");
  return { ...env, signature };
}

/** Verify a signed envelope — true when the signature matches a recompute. */
export function verifyEnvelope(env, key) {
  if (!env.signature) return false;
  return signEnvelope({ ...env, signature: undefined }, key).signature === env.signature;
}

/** Record a break-glass override (verdict→COMMENT) and re-sign. */
export function applyOverride(env, by, reason, key) {
  return signEnvelope({ ...env, verdict: "COMMENT", override: { by, reason, priorVerdict: env.verdict }, signature: undefined }, key);
}

/**
 * Assemble + sign the verdict envelope. `generatedAt` is injected by the caller
 * (pure code has no clock). `engine.core` should carry the altimate-core version.
 */
export function buildEnvelope(input) {
  const rubric = input.rubric ?? DEFAULT_RUBRIC;
  const ideal = computeIdealVerdict(input.findings, rubric);
  const verdict = applyMode(ideal, input.mode);
  const degraded = input.degraded ?? input.findings.some((f) => f.degraded);
  const env = {
    version: "1",
    verdict,
    idealVerdict: ideal,
    mode: input.mode,
    tier: input.tier,
    findings: input.findings,
    summary: summarize(input.findings, degraded),
    engine: {
      reviewer: "dbt-pr-review/1",
      core: input.engine?.core,
      model: input.engine?.model,
    },
    manifestHash: input.manifestHash,
    generatedAt: input.generatedAt,
  };
  return signEnvelope(env);
}
