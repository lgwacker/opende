import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fingerprint, makeFinding, dedupeFindings,
  SEVERITIES, SEVERITY_ORDER, CONFIDENCES, REVIEW_CATEGORIES,
} from "../../src/review/finding.js";

describe("constants", () => {
  test("SEVERITIES contains exactly critical/warning/suggestion", () => {
    assert.deepEqual(SEVERITIES, ["critical", "warning", "suggestion"]);
  });

  test("SEVERITY_ORDER has correct relative ordering", () => {
    assert.ok(SEVERITY_ORDER.critical > SEVERITY_ORDER.warning);
    assert.ok(SEVERITY_ORDER.warning > SEVERITY_ORDER.suggestion);
  });

  test("REVIEW_CATEGORIES contains key categories", () => {
    for (const cat of ["lineage_breakage", "pii_exposure", "contract_violation", "semantic_change", "sql_correctness"]) {
      assert.ok(REVIEW_CATEGORIES.includes(cat), `missing category: ${cat}`);
    }
  });
});

describe("fingerprint", () => {
  const base = { category: "pii_exposure", file: "models/orders.sql", model: "orders", column: "email", ruleKey: "pii" };

  test("is deterministic (same inputs → same output)", () => {
    assert.equal(fingerprint(base), fingerprint({ ...base }));
  });

  test("starts with 'f_' prefix", () => {
    assert.ok(fingerprint(base).startsWith("f_"));
  });

  test("is 18 chars: f_ + 16 hex chars", () => {
    assert.equal(fingerprint(base).length, 18);
  });

  test("changes when category changes", () => {
    assert.notEqual(fingerprint(base), fingerprint({ ...base, category: "sql_correctness" }));
  });

  test("changes when file changes", () => {
    assert.notEqual(fingerprint(base), fingerprint({ ...base, file: "models/other.sql" }));
  });

  test("changes when model changes", () => {
    assert.notEqual(fingerprint(base), fingerprint({ ...base, model: "other_model" }));
  });

  test("changes when ruleKey changes", () => {
    assert.notEqual(fingerprint(base), fingerprint({ ...base, ruleKey: "different_rule" }));
  });

  test("null/undefined optional fields produce consistent hash", () => {
    const a = fingerprint({ category: "pii_exposure", file: "f.sql", model: undefined, column: null, ruleKey: "pii" });
    const b = fingerprint({ category: "pii_exposure", file: "f.sql", model: undefined, column: null, ruleKey: "pii" });
    assert.equal(a, b);
  });
});

describe("makeFinding", () => {
  const base = {
    category: "pii_exposure", severity: "critical", title: "PII exposed",
    body: "email column", file: "models/orders.sql", model: "orders",
    column: "email", ruleKey: "pii_rule",
  };

  test("assigns fingerprint as id when no explicit id given", () => {
    const f = makeFinding(base);
    assert.equal(f.id, fingerprint(base));
  });

  test("uses explicit id when provided", () => {
    const f = makeFinding({ ...base, id: "explicit-id-123" });
    assert.equal(f.id, "explicit-id-123");
  });

  test("defaults confidence to 'high'", () => {
    const f = makeFinding(base);
    assert.equal(f.confidence, "high");
  });

  test("defaults degraded to false", () => {
    const f = makeFinding(base);
    assert.equal(f.degraded, false);
  });

  test("defaults body to empty string when not provided", () => {
    const f = makeFinding({ ...base, body: undefined });
    assert.equal(f.body, "");
  });

  test("clamps unknown-confidence critical → warning", () => {
    const f = makeFinding({ ...base, severity: "critical", confidence: "unknown" });
    assert.equal(f.severity, "warning");
    assert.equal(f.confidence, "unknown");
  });

  test("clamps low-confidence critical → warning", () => {
    const f = makeFinding({ ...base, severity: "critical", confidence: "low" });
    assert.equal(f.severity, "warning");
  });

  test("does NOT clamp high-confidence critical", () => {
    const f = makeFinding({ ...base, severity: "critical", confidence: "high" });
    assert.equal(f.severity, "critical");
  });

  test("does NOT clamp unknown-confidence warning", () => {
    const f = makeFinding({ ...base, severity: "warning", confidence: "unknown" });
    assert.equal(f.severity, "warning");
  });

  test("preserves all provided fields", () => {
    const f = makeFinding({ ...base, startLine: 42, endLine: 45 });
    assert.equal(f.category, "pii_exposure");
    assert.equal(f.title, "PII exposed");
    assert.equal(f.file, "models/orders.sql");
    assert.equal(f.model, "orders");
    assert.equal(f.column, "email");
    assert.equal(f.startLine, 42);
    assert.equal(f.endLine, 45);
  });
});

describe("dedupeFindings", () => {
  const mkF = (severity, ruleKey, extra = {}) =>
    makeFinding({ category: "pii_exposure", severity, title: ruleKey, body: "", file: "f.sql", model: "m", ruleKey, ...extra });

  test("returns empty array for empty input", () => {
    assert.deepEqual(dedupeFindings([]), []);
  });

  test("keeps single finding unchanged", () => {
    const f = mkF("critical", "rule1");
    assert.deepEqual(dedupeFindings([f]), [f]);
  });

  test("deduplicates same-id findings, keeping only one", () => {
    const f1 = mkF("warning", "same_rule");
    const f2 = mkF("warning", "same_rule"); // same fingerprint
    const result = dedupeFindings([f1, f2]);
    assert.equal(result.length, 1);
  });

  test("keeps highest-severity when two findings share the same id", () => {
    // Both have same fingerprint; critical should win
    const fWarn = mkF("warning", "rule1");
    const fCrit = makeFinding({ category: "pii_exposure", severity: "critical", confidence: "high", title: "rule1", body: "", file: "f.sql", model: "m", ruleKey: "rule1", id: fWarn.id });
    const result = dedupeFindings([fWarn, fCrit]);
    assert.equal(result.length, 1);
    assert.equal(result[0].severity, "critical");
  });

  test("keeps distinct-id findings separate", () => {
    const f1 = mkF("warning", "rule1");
    const f2 = mkF("warning", "rule2");
    assert.equal(dedupeFindings([f1, f2]).length, 2);
  });
});
