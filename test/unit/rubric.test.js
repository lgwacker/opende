import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  blockingCategories, clampSeverity, exclusionReason,
  loadReviewConfig, resolveRubric, DEFAULT_RUBRIC,
} from "../../src/review/rubric.js";
import { makeFinding } from "../../src/review/finding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("blockingCategories", () => {
  test("returns a Set containing the default blocking categories", () => {
    const bc = blockingCategories();
    for (const cat of ["pii_exposure", "lineage_breakage", "contract_violation", "semantic_change", "sql_correctness", "join_risk", "fanout"]) {
      assert.ok(bc.has(cat), `expected '${cat}' to be blocking`);
    }
  });

  test("returns a Set (not an array)", () => {
    assert.ok(blockingCategories() instanceof Set);
  });

  test("respects custom blockOn list", () => {
    const rubric = { ...DEFAULT_RUBRIC, blockOn: ["warehouse_cost"] };
    const bc = blockingCategories(rubric);
    assert.ok(bc.has("warehouse_cost"));
    assert.ok(!bc.has("pii_exposure"));
  });
});

describe("clampSeverity", () => {
  test("unknown confidence + critical → warning", () => {
    assert.equal(clampSeverity("pii_exposure", "critical", "unknown"), "warning");
  });

  test("low confidence + critical → warning", () => {
    assert.equal(clampSeverity("pii_exposure", "critical", "low"), "warning");
  });

  test("high confidence + critical → critical (not clamped)", () => {
    assert.equal(clampSeverity("pii_exposure", "critical", "high"), "critical");
  });

  test("medium confidence + critical → critical (not clamped)", () => {
    assert.equal(clampSeverity("pii_exposure", "critical", "medium"), "critical");
  });

  test("unknown confidence + warning → warning (not clamped further)", () => {
    assert.equal(clampSeverity("pii_exposure", "warning", "unknown"), "warning");
  });

  test("does not modify suggestion severity", () => {
    assert.equal(clampSeverity("sql_quality", "suggestion", "unknown"), "suggestion");
  });
});

describe("exclusionReason", () => {
  const mkF = (overrides) => makeFinding({
    category: "sql_quality", severity: "warning", title: "test", body: "", file: "models/orders.sql",
    model: "orders", ruleKey: "test_rule", ...overrides,
  });

  test("returns null for a normal production model (keep it)", () => {
    const f = mkF({ file: "models/orders.sql", model: "orders" });
    assert.equal(exclusionReason(f), null);
  });

  test("drops dev/ path models when skipNonProdModels=true", () => {
    const f = mkF({ file: "models/dev/my_model.sql" });
    assert.ok(exclusionReason(f) !== null);
  });

  test("drops sandbox/ path models", () => {
    const f = mkF({ file: "models/sandbox/test_model.sql" });
    assert.ok(exclusionReason(f) !== null);
  });

  test("drops scratch/ path models", () => {
    const f = mkF({ file: "models/scratch/junk.sql" });
    assert.ok(exclusionReason(f) !== null);
  });

  test("keeps dev-like names that are NOT in dev/ folder", () => {
    // file is in a prod folder, just happens to have 'dev' elsewhere
    const f = mkF({ file: "models/staging/stg_orders.sql" });
    assert.equal(exclusionReason(f), null);
  });

  test("drops SELECT * warehouse_cost in staging (allowSelectStarInStaging=true)", () => {
    const f = mkF({
      category: "warehouse_cost",
      title: "SELECT * usage",
      body: "query uses select *",
      file: "models/staging/stg_orders.sql",
    });
    assert.ok(exclusionReason(f) !== null);
  });

  test("keeps SELECT * warehouse_cost in non-staging models", () => {
    const f = mkF({
      category: "warehouse_cost",
      title: "SELECT * usage",
      body: "query uses select *",
      file: "models/marts/orders.sql",
    });
    assert.equal(exclusionReason(f), null);
  });

  test("excludes files matching glob pattern", () => {
    const rubric = { ...DEFAULT_RUBRIC, exclusions: { ...DEFAULT_RUBRIC.exclusions, excludeGlobs: ["*.generated.sql"] } };
    const f = mkF({ file: "models/orders.generated.sql" });
    assert.ok(exclusionReason(f, rubric) !== null);
  });

  test("does not exclude files that don't match glob pattern", () => {
    const rubric = { ...DEFAULT_RUBRIC, exclusions: { ...DEFAULT_RUBRIC.exclusions, excludeGlobs: ["*.generated.sql"] } };
    const f = mkF({ file: "models/orders.sql" });
    assert.equal(exclusionReason(f, rubric), null);
  });
});

describe("loadReviewConfig", () => {
  test("returns defaults when .altimate/review.yml does not exist", () => {
    const cfg = loadReviewConfig("/tmp/nonexistent_dir_opende_test_12345");
    assert.equal(cfg.mode, "comment");
    assert.equal(cfg.manifestPath, "target/manifest.json");
    assert.equal(cfg.dialect, null);
  });

  test("never throws for invalid paths", () => {
    assert.doesNotThrow(() => loadReviewConfig("/no/such/path"));
    assert.doesNotThrow(() => loadReviewConfig(""));
  });

  test("loads and merges a valid review.yml file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opende-rubric-test-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".altimate"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".altimate", "review.yml"), "mode: gate\ndialect: bigquery\n");
      const cfg = loadReviewConfig(tmpDir);
      assert.equal(cfg.mode, "gate");
      assert.equal(cfg.dialect, "bigquery");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("does not throw on malformed YAML (falls through to defaults)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opende-rubric-test-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".altimate"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ".altimate", "review.yml"), ":\ninvalid: {\n");
      assert.doesNotThrow(() => loadReviewConfig(tmpDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveRubric", () => {
  test("returns DEFAULT_RUBRIC when no overrides", () => {
    const r = resolveRubric({});
    assert.deepEqual(r.blockOn, DEFAULT_RUBRIC.blockOn);
    assert.equal(r.warningPatternThreshold, DEFAULT_RUBRIC.warningPatternThreshold);
  });

  test("overrides blockOn when provided", () => {
    const r = resolveRubric({ rubric: { blockOn: ["warehouse_cost"] } });
    assert.deepEqual(r.blockOn, ["warehouse_cost"]);
  });

  test("overrides warningPatternThreshold when provided", () => {
    const r = resolveRubric({ rubric: { warningPatternThreshold: 5 } });
    assert.equal(r.warningPatternThreshold, 5);
  });

  test("merges thresholds without replacing unspecified keys", () => {
    const r = resolveRubric({ rubric: { thresholds: { gradeRegressionLetters: 2 } } });
    assert.equal(r.thresholds.gradeRegressionLetters, 2);
    assert.equal(r.thresholds.warehouseCostMinRows, DEFAULT_RUBRIC.thresholds.warehouseCostMinRows);
  });

  test("concatenates excludeGlobs from rubric.exclusions and config.exclude", () => {
    const r = resolveRubric({
      exclude: ["*.test.sql"],
      rubric: { exclusions: { excludeGlobs: ["*.generated.sql"] } },
    });
    assert.ok(r.exclusions.excludeGlobs.includes("*.test.sql"));
    assert.ok(r.exclusions.excludeGlobs.includes("*.generated.sql"));
  });

  test("does not mutate DEFAULT_RUBRIC", () => {
    const before = JSON.stringify(DEFAULT_RUBRIC);
    resolveRubric({ rubric: { blockOn: ["sql_quality"], warningPatternThreshold: 99 } });
    assert.equal(JSON.stringify(DEFAULT_RUBRIC), before);
  });
});
