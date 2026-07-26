import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { metadataLane, parseSchemaYaml, isModelYaml } from "../../src/review/metadata.js";
import { computeIdealVerdict } from "../../src/review/verdict.js";

const run = (baseYaml, headYaml, file = "models/schema.yml") => {
  const findings = [];
  metadataLane({ findings, file, baseYaml, headYaml });
  return findings;
};
const titles = (fs) => fs.map((f) => f.title);
const byRule = (fs, needle) => fs.find((f) => f.title.includes(needle));

describe("isModelYaml", () => {
  test("accepts schema yml under models/", () => {
    assert.ok(isModelYaml("models/schema.yml"));
    assert.ok(isModelYaml("models/staging/_sources.yaml"));
    assert.ok(isModelYaml("services/dbt/models/marts/core.yml"));
  });
  test("rejects project-level yml and sql", () => {
    assert.ok(!isModelYaml("dbt_project.yml"));
    assert.ok(!isModelYaml("packages.yml"));
    assert.ok(!isModelYaml("models/orders.sql"));
  });
});

describe("parseSchemaYaml", () => {
  test("empty input parses to empty maps, not null", () => {
    const r = parseSchemaYaml("");
    assert.equal(r.models.size, 0);
    assert.equal(r.sources.size, 0);
  });
  test("unparseable YAML returns null (lane degrades)", () => {
    assert.equal(parseSchemaYaml("models:\n  - name: a\n   bad: indent\n\t{["), null);
  });
  test("reads both tests: and data_tests: (dbt 1.8 rename)", () => {
    const doc = parseSchemaYaml(`
models:
  - name: orders
    columns:
      - name: id
        tests: [not_null]
      - name: sk
        data_tests: [unique]
`);
    assert.ok(doc.models.get("orders").columns.get("id").tests.has("not_null"));
    assert.ok(doc.models.get("orders").columns.get("sk").tests.has("unique"));
  });
  test("a table inherits source-level freshness unless it overrides", () => {
    const doc = parseSchemaYaml(`
sources:
  - name: raw
    freshness: {warn_after: {count: 12, period: hour}}
    tables:
      - name: inherits
      - name: overrides
        freshness: null
`);
    assert.ok(doc.sources.get("raw.inherits").freshness);
    assert.equal(doc.sources.get("raw.overrides").freshness, null);
  });
});

describe("removed tests", () => {
  const base = `
models:
  - name: orders
    columns:
      - name: order_id
        tests: [not_null, unique]
`;
  test("a removed not_null is a warning, not a silent pass", () => {
    const head = `
models:
  - name: orders
    columns:
      - name: order_id
        tests: [unique]
`;
    const f = byRule(run(base, head), "Test removed: `not_null`");
    assert.ok(f, `expected a not_null removal finding, got ${titles(run(base, head))}`);
    assert.equal(f.severity, "warning");
    assert.equal(f.category, "test_coverage");
    assert.equal(f.column, "order_id");
    assert.equal(f.model, "orders");
  });

  test("an unchanged file produces nothing", () => {
    assert.deepEqual(run(base, base), []);
  });

  test("an ADDED test produces nothing (only weakening is risk-bearing)", () => {
    const head = `
models:
  - name: orders
    columns:
      - name: order_id
        tests: [not_null, unique, relationships]
`;
    assert.deepEqual(run(base, head), []);
  });

  test("severity error → warn is caught as a downgrade", () => {
    const b = `
models:
  - name: orders
    columns:
      - name: order_id
        tests:
          - not_null
`;
    const h = `
models:
  - name: orders
    columns:
      - name: order_id
        tests:
          - not_null:
              severity: warn
`;
    const f = byRule(run(b, h), "downgraded");
    assert.ok(f);
    assert.equal(f.severity, "warning");
  });

  test("a non-correctness test removal reports at suggestion", () => {
    const b = `
models:
  - name: orders
    columns:
      - name: order_id
        tests: [my_custom_doc_check]
`;
    const h = `
models:
  - name: orders
    columns:
      - name: order_id
`;
    // The column survives; only the test went away.
    const f = byRule(run(b, h), "Test removed: `my_custom_doc_check`");
    assert.ok(f);
    assert.equal(f.severity, "suggestion");
  });
});

describe("contract + materialization", () => {
  test("contract.enforced true → false is a blocking critical", () => {
    const b = `
models:
  - name: orders
    config: {contract: {enforced: true}}
`;
    const h = `
models:
  - name: orders
    config: {contract: {enforced: false}}
`;
    const f = byRule(run(b, h), "Contract enforcement disabled");
    assert.equal(f.severity, "critical");
    assert.equal(f.category, "contract_violation");
    // contract_violation is in the default blockOn set → REQUEST_CHANGES.
    assert.equal(computeIdealVerdict([f]), "REQUEST_CHANGES");
  });

  test("enabling a contract is not a finding", () => {
    const b = `models: [{name: orders, config: {contract: {enforced: false}}}]`;
    const h = `models: [{name: orders, config: {contract: {enforced: true}}}]`;
    assert.deepEqual(run(b, h), []);
  });

  test("materialization change is a warning", () => {
    const b = `models: [{name: orders, config: {materialized: incremental}}]`;
    const h = `models: [{name: orders, config: {materialized: table}}]`;
    const f = byRule(run(b, h), "Materialization changed");
    assert.equal(f.severity, "warning");
    assert.equal(f.category, "materialization");
  });

  test("declared data_type change is a contract warning", () => {
    const b = `models: [{name: orders, columns: [{name: amt, data_type: numeric(38,2)}]}]`;
    const h = `models: [{name: orders, columns: [{name: amt, data_type: float}]}]`;
    const f = byRule(run(b, h), "Declared type changed");
    assert.equal(f.severity, "warning");
    assert.equal(f.category, "contract_violation");
  });
});

describe("dropped entities", () => {
  test("a tested column dropped from spec is a warning; an untested one a suggestion", () => {
    const b = `
models:
  - name: orders
    columns:
      - name: tested
        tests: [not_null]
      - name: bare
`;
    const h = `models: [{name: orders}]`;
    const found = run(b, h);
    assert.equal(byRule(found, "orders.tested").severity, "warning");
    assert.equal(byRule(found, "orders.bare").severity, "suggestion");
    // The dropped column subsumes its tests — no separate test-removal finding.
    assert.ok(!found.some((f) => f.title.startsWith("Test removed")));
  });

  test("a removed model spec is reported once, not per column", () => {
    const b = `models: [{name: orders, columns: [{name: a, tests: [not_null]}, {name: b}]}]`;
    const h = `models: [{name: customers}]`;
    const found = run(b, h);
    assert.equal(found.length, 1);
    assert.ok(found[0].title.includes("Model removed from spec: orders"));
  });

  test("a removed source table is reported", () => {
    const b = `sources: [{name: raw, tables: [{name: events}]}]`;
    const h = `sources: [{name: raw, tables: []}]`;
    assert.ok(byRule(run(b, h), "Source removed from spec: raw.events"));
  });

  test("removed source freshness is a freshness warning", () => {
    const b = `
sources:
  - name: raw
    tables:
      - name: events
        freshness: {warn_after: {count: 6, period: hour}}
`;
    const h = `sources: [{name: raw, tables: [{name: events}]}]`;
    const f = byRule(run(b, h), "Freshness check removed");
    assert.equal(f.severity, "warning");
    assert.equal(f.category, "freshness");
  });
});

describe("degradation", () => {
  test("unparseable head yields one degraded, unknown-confidence finding", () => {
    const found = run("models: [{name: orders}]", "models:\n  - name: x\n\t}{[");
    assert.equal(found.length, 1);
    assert.equal(found[0].confidence, "unknown");
    assert.equal(found[0].degraded, true);
    // An unknown-confidence finding must never block.
    assert.notEqual(found[0].severity, "critical");
  });
});

describe("triage promotion — the auto-approve hole", () => {
  test("a YAML-only test deletion can never reach APPROVE", () => {
    const b = `models: [{name: orders, columns: [{name: id, tests: [not_null]}]}]`;
    const h = `models: [{name: orders, columns: [{name: id}]}]`;
    const found = run(b, h);
    assert.ok(found.length > 0, "expected findings from a test deletion");
    assert.notEqual(computeIdealVerdict(found), "APPROVE");
  });
});
