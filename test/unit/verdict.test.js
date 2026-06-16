import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeIdealVerdict, applyMode,
  signEnvelope, verifyEnvelope, applyOverride,
  buildEnvelope, canonicalBody,
  VERDICTS, REVIEW_MODES, VCS_EVENT,
} from "../../src/review/verdict.js";
import { makeFinding } from "../../src/review/finding.js";
import { DEFAULT_RUBRIC } from "../../src/review/rubric.js";

const mkF = (severity, category = "pii_exposure", confidence = "high") =>
  makeFinding({ severity, category, title: `${severity} finding`, body: "", file: "f.sql", model: "m", ruleKey: `${severity}_${category}_${confidence}`, confidence });

describe("constants", () => {
  test("VERDICTS contains exactly three values", () => {
    assert.deepEqual(VERDICTS, ["APPROVE", "COMMENT", "REQUEST_CHANGES"]);
  });

  test("VCS_EVENT maps APPROVE to COMMENT (never formal approval)", () => {
    assert.equal(VCS_EVENT.APPROVE, "COMMENT");
    assert.equal(VCS_EVENT.COMMENT, "COMMENT");
    assert.equal(VCS_EVENT.REQUEST_CHANGES, "REQUEST_CHANGES");
  });
});

describe("computeIdealVerdict", () => {
  test("APPROVE when no findings", () => {
    assert.equal(computeIdealVerdict([]), "APPROVE");
  });

  test("COMMENT for a single suggestion finding", () => {
    assert.equal(computeIdealVerdict([mkF("suggestion")]), "COMMENT");
  });

  test("COMMENT for warnings below threshold", () => {
    // threshold is 3; two warnings should be COMMENT
    assert.equal(computeIdealVerdict([mkF("warning"), mkF("warning", "semantic_change")]), "COMMENT");
  });

  test("REQUEST_CHANGES for a blocking-category critical finding", () => {
    // pii_exposure is in DEFAULT_RUBRIC.blockOn
    assert.equal(computeIdealVerdict([mkF("critical", "pii_exposure")]), "REQUEST_CHANGES");
  });

  test("REQUEST_CHANGES when confident warnings reach threshold (3)", () => {
    const warnings = [
      mkF("warning", "sql_quality", "high"),
      mkF("warning", "semantic_change", "high"),
      mkF("warning", "join_risk", "high"),
    ];
    assert.equal(computeIdealVerdict(warnings), "REQUEST_CHANGES");
  });

  test("unknown-confidence warnings do NOT count toward warning threshold", () => {
    const warnings = [
      mkF("warning", "sql_quality", "unknown"),
      mkF("warning", "semantic_change", "unknown"),
      mkF("warning", "join_risk", "unknown"),
      mkF("warning", "fanout", "unknown"),
    ];
    assert.equal(computeIdealVerdict(warnings), "COMMENT");
  });

  test("critical in non-blocking category → COMMENT (not REQUEST_CHANGES)", () => {
    // warehouse_cost is NOT in DEFAULT_RUBRIC.blockOn
    assert.equal(computeIdealVerdict([mkF("critical", "warehouse_cost")]), "COMMENT");
  });

  test("non-blocking critical + confident warnings at threshold → REQUEST_CHANGES", () => {
    const findings = [
      mkF("warning", "sql_quality", "high"),
      mkF("warning", "semantic_change", "high"),
      mkF("warning", "join_risk", "high"),
    ];
    assert.equal(computeIdealVerdict(findings), "REQUEST_CHANGES");
  });
});

describe("applyMode", () => {
  test("softens REQUEST_CHANGES to COMMENT in comment mode", () => {
    assert.equal(applyMode("REQUEST_CHANGES", "comment"), "COMMENT");
  });

  test("preserves APPROVE in comment mode", () => {
    assert.equal(applyMode("APPROVE", "comment"), "APPROVE");
  });

  test("preserves COMMENT in comment mode", () => {
    assert.equal(applyMode("COMMENT", "comment"), "COMMENT");
  });

  test("preserves REQUEST_CHANGES in gate mode", () => {
    assert.equal(applyMode("REQUEST_CHANGES", "gate"), "REQUEST_CHANGES");
  });
});

describe("canonicalBody", () => {
  test("excludes the signature field", () => {
    const env = { verdict: "APPROVE", signature: "sha256:abc", findings: [] };
    const body = canonicalBody(env);
    assert.ok(!body.includes("signature"));
    assert.ok(body.includes("verdict"));
  });

  test("is stable regardless of input key order", () => {
    const a = canonicalBody({ b: 2, a: 1, signature: "x" });
    const b = canonicalBody({ a: 1, b: 2, signature: "x" });
    assert.equal(a, b);
  });

  test("includes nested object keys sorted", () => {
    const body = canonicalBody({ z: { b: 2, a: 1 } });
    assert.ok(body.indexOf('"a"') < body.indexOf('"b"'));
  });
});

describe("signEnvelope / verifyEnvelope", () => {
  const env = { verdict: "APPROVE", findings: [], summary: { critical: 0, warning: 0, suggestion: 0 } };

  test("unsigned (no key) produces 'sha256:' prefix", () => {
    const signed = signEnvelope(env);
    assert.ok(signed.signature.startsWith("sha256:"), `got: ${signed.signature}`);
  });

  test("keyed signing produces 'hmac:' prefix", () => {
    const signed = signEnvelope(env, "my-secret-key");
    assert.ok(signed.signature.startsWith("hmac:"), `got: ${signed.signature}`);
  });

  test("signature is deterministic (same envelope + key → same signature)", () => {
    const s1 = signEnvelope(env, "key").signature;
    const s2 = signEnvelope(env, "key").signature;
    assert.equal(s1, s2);
  });

  test("different keys produce different signatures", () => {
    const s1 = signEnvelope(env, "key-a").signature;
    const s2 = signEnvelope(env, "key-b").signature;
    assert.notEqual(s1, s2);
  });

  test("verifyEnvelope round-trips (signed without key)", () => {
    const signed = signEnvelope(env);
    assert.ok(verifyEnvelope(signed));
  });

  test("verifyEnvelope round-trips (signed with key)", () => {
    const signed = signEnvelope(env, "secret");
    assert.ok(verifyEnvelope(signed, "secret"));
  });

  test("verifyEnvelope fails with wrong key", () => {
    const signed = signEnvelope(env, "correct-key");
    assert.ok(!verifyEnvelope(signed, "wrong-key"));
  });

  test("verifyEnvelope fails when envelope is tampered", () => {
    const signed = signEnvelope(env, "key");
    const tampered = { ...signed, verdict: "REQUEST_CHANGES" };
    assert.ok(!verifyEnvelope(tampered, "key"));
  });

  test("verifyEnvelope returns false when signature is absent", () => {
    assert.ok(!verifyEnvelope({ verdict: "APPROVE" }));
  });
});

describe("applyOverride", () => {
  test("sets verdict to COMMENT and records override metadata, re-signs", () => {
    const env = signEnvelope({ verdict: "REQUEST_CHANGES", findings: [] }, "key");
    const overridden = applyOverride(env, "alice", "emergency deploy", "key");
    assert.equal(overridden.verdict, "COMMENT");
    assert.equal(overridden.override.by, "alice");
    assert.equal(overridden.override.priorVerdict, "REQUEST_CHANGES");
    assert.ok(verifyEnvelope(overridden, "key"));
  });
});

describe("buildEnvelope", () => {
  test("produces a signed envelope with all required fields", () => {
    const env = buildEnvelope({ findings: [], mode: "comment", tier: "trivial", generatedAt: "2026-01-01T00:00:00Z" });
    assert.equal(env.version, "1");
    assert.equal(env.verdict, "APPROVE");
    assert.ok(env.signature);
    assert.ok(verifyEnvelope(env));
  });

  test("APPROVE verdict when no findings", () => {
    const env = buildEnvelope({ findings: [], mode: "gate", tier: "trivial" });
    assert.equal(env.verdict, "APPROVE");
    assert.equal(env.idealVerdict, "APPROVE");
  });

  test("REQUEST_CHANGES → COMMENT when mode is 'comment'", () => {
    const findings = [mkF("critical", "pii_exposure", "high")];
    const env = buildEnvelope({ findings, mode: "comment", tier: "lite" });
    assert.equal(env.idealVerdict, "REQUEST_CHANGES");
    assert.equal(env.verdict, "COMMENT");
  });

  test("REQUEST_CHANGES preserved in gate mode", () => {
    const findings = [mkF("critical", "pii_exposure", "high")];
    const env = buildEnvelope({ findings, mode: "gate", tier: "lite" });
    assert.equal(env.verdict, "REQUEST_CHANGES");
  });

  test("summary tallies findings by severity", () => {
    const findings = [
      mkF("critical", "pii_exposure"), mkF("warning", "sql_quality"), mkF("suggestion", "sql_quality"),
    ];
    const env = buildEnvelope({ findings, mode: "gate", tier: "lite" });
    assert.equal(env.summary.critical, 1);
    assert.equal(env.summary.warning, 1);
    assert.equal(env.summary.suggestion, 1);
  });

  test("degraded flag is propagated from input", () => {
    const env = buildEnvelope({ findings: [], mode: "comment", tier: "trivial", degraded: true });
    assert.ok(env.summary.degraded);
  });
});
