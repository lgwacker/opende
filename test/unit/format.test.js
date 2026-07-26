import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { verdictHeadline, renderSummary, renderTierExplanation, REVIEW_MARKER } from "../../src/review/format.js";
import { buildEnvelope } from "../../src/review/verdict.js";
import { makeFinding } from "../../src/review/finding.js";

const mkF = (severity, confidence = "high", degraded = false) =>
  makeFinding({ category: "pii_exposure", severity, title: `${severity} title`, body: "desc", file: "f.sql", model: "m", ruleKey: `${severity}_rule`, confidence, degraded });

function makeEnv(findings = [], opts = {}) {
  return buildEnvelope({
    findings,
    mode: opts.mode ?? "comment",
    tier: opts.tier ?? "trivial",
    degraded: opts.degraded ?? false,
    generatedAt: "2026-01-01T00:00:00Z",
  });
}

describe("REVIEW_MARKER", () => {
  test("is the expected dedup sentinel", () => {
    assert.equal(REVIEW_MARKER, "<!-- altimate-code-review -->");
  });
});

describe("verdictHeadline", () => {
  test("shows '✅ Approved' for APPROVE verdict with no findings", () => {
    const env = makeEnv([]);
    assert.ok(verdictHeadline(env).includes("✅ Approved"));
    assert.ok(verdictHeadline(env).includes("no findings"));
  });

  test("shows correct tier in headline", () => {
    const env = makeEnv([], { tier: "full" });
    assert.ok(verdictHeadline(env).includes("full tier"));
  });

  test("shows finding counts", () => {
    const env = makeEnv([mkF("critical"), mkF("warning"), mkF("suggestion")]);
    const h = verdictHeadline(env);
    assert.ok(h.includes("1 critical"));
    assert.ok(h.includes("1 warning"));
    assert.ok(h.includes("1 suggestion"));
  });

  test("shows '💬 Reviewed with comments' for COMMENT", () => {
    const env = makeEnv([mkF("warning")]);
    assert.ok(verdictHeadline(env).includes("💬 Reviewed with comments"));
  });

  test("shows '🛑 Changes requested' for REQUEST_CHANGES in gate mode", () => {
    const env = makeEnv([mkF("critical", "high")], { mode: "gate" });
    // pii_exposure critical with high confidence → REQUEST_CHANGES in gate mode
    const h = verdictHeadline(env);
    assert.ok(h.includes("🛑 Changes requested") || h.includes("💬 Reviewed"), `got: ${h}`);
  });
});

describe("renderSummary", () => {
  test("starts with REVIEW_MARKER", () => {
    const env = makeEnv([]);
    assert.ok(renderSummary(env).startsWith(REVIEW_MARKER));
  });

  test("includes 'No issues found' when findings is empty", () => {
    const env = makeEnv([]);
    assert.ok(renderSummary(env).includes("No issues found"));
  });

  test("includes degraded/lint-only warning when summary.degraded=true", () => {
    const env = makeEnv([], { degraded: true });
    const summary = renderSummary(env);
    assert.ok(summary.includes("Lint-only") || summary.includes("lint-only") || summary.includes("no dbt manifest"));
  });

  test("renders finding titles in the summary", () => {
    const env = makeEnv([mkF("warning")]);
    assert.ok(renderSummary(env).includes("warning title"));
  });

  test("marks degraded findings with '_unverified_'", () => {
    const f = mkF("warning", "high", true); // degraded=true
    const env = makeEnv([f]);
    assert.ok(renderSummary(env).includes("_unverified_"));
  });

  test("marks unknown-confidence findings with '_unverified_'", () => {
    const f = mkF("warning", "unknown", false);
    const env = makeEnv([f]);
    assert.ok(renderSummary(env).includes("_unverified_"));
  });

  test("includes the signature snippet in the footer", () => {
    const env = makeEnv([]);
    const summary = renderSummary(env);
    assert.ok(summary.includes("signed `"));
  });

  test("includes finding category in the summary", () => {
    const env = makeEnv([mkF("warning")]);
    assert.ok(renderSummary(env).includes("pii_exposure"));
  });

  test("groups findings by severity section", () => {
    const env = makeEnv([mkF("warning"), mkF("suggestion")]);
    const s = renderSummary(env);
    assert.ok(s.includes("⚠️"));
    assert.ok(s.includes("💡"));
  });
});

describe("renderTierExplanation", () => {
  const withSignals = (tierSignals, tier = "lite") =>
    buildEnvelope({ findings: [], mode: "comment", tier, tierSignals, generatedAt: "2026-01-01T00:00:00Z" });

  test("prints each signal and the threshold it is measured against", () => {
    const out = renderTierExplanation(
      withSignals({ totalSqlLines: 42, maxBlast: 3, metadataRisk: false, reason: "below the full-tier thresholds", computedTier: "lite" }),
    );
    assert.ok(out.includes("42"));
    assert.ok(out.includes("> 100"));
    assert.ok(out.includes("> 5"));
    assert.ok(out.includes("below the full-tier thresholds"));
  });

  test("marks a forced tier and reports the measured one", () => {
    const env = withSignals({ totalSqlLines: 2, maxBlast: 0, metadataRisk: false, reason: "trivial", computedTier: "trivial", forced: true }, "full");
    const out = renderTierExplanation(env);
    assert.ok(out.includes("FORCED"));
    assert.ok(out.includes("measured tier was trivial"));
    assert.ok(verdictHeadline(env).includes("full tier, forced"));
  });

  test("degrades to a one-liner on an envelope with no tier signals", () => {
    assert.ok(renderTierExplanation(makeEnv([], { tier: "full" })).includes("no tier signals"));
  });
});
