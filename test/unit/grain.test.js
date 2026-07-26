// Pure grain-vs-declared-tests logic. The real `extractGrain` call lives in
// test/integration/review-grain.test.js — this suite must stay engine-free.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGrain,
  grainColumn,
  grainColumns,
  grainNotNullFindings,
  notNullFromManifest,
  notNullFromYamlDir,
  GRAIN_ROLLUP_AT,
} from "../../src/review/grain.js";

describe("parseGrain", () => {
  test("parses the JSON string core returns", () => {
    const g = parseGrain('{"group_by":["a","b"],"dedup_partition":["c"]}');
    assert.deepEqual(g, { groupBy: ["a", "b"], dedupPartition: ["c"] });
  });

  test("accepts an already-parsed object", () => {
    assert.deepEqual(parseGrain({ group_by: ["a"], dedup_partition: [] }), { groupBy: ["a"], dedupPartition: [] });
  });

  test("returns empty grain for unparseable or unexpected payloads", () => {
    for (const bad of ["not json", null, undefined, 42, "{}"]) {
      assert.deepEqual(parseGrain(bad), { groupBy: [], dedupPartition: [] });
    }
  });
});

describe("grainColumn", () => {
  test("lowercases a bare identifier", () => {
    assert.equal(grainColumn("Customer_ID"), "customer_id");
  });

  test("takes the last segment of a qualified reference", () => {
    assert.equal(grainColumn("orders.customer_id"), "customer_id");
  });

  test("strips quoting", () => {
    assert.equal(grainColumn('"order_id"'), "order_id");
    assert.equal(grainColumn("`order_id`"), "order_id");
  });

  test("rejects a positional GROUP BY ordinal", () => {
    assert.equal(grainColumn("1"), null);
  });

  test("rejects an expression that no not_null test could target", () => {
    assert.equal(grainColumn("date_trunc('day', created_at)"), null);
    assert.equal(grainColumn("a + b"), null);
    assert.equal(grainColumn(""), null);
  });
});

describe("grainColumns", () => {
  test("unions GROUP BY and dedup PARTITION BY without duplicates", () => {
    const cols = grainColumns({ groupBy: ["a", "t.b"], dedupPartition: ["B", "c"] });
    assert.deepEqual([...cols.keys()], ["a", "b", "c"]);
  });

  test("keeps the original spelling for the finding message", () => {
    const cols = grainColumns({ groupBy: ["orders.Customer_ID"], dedupPartition: [] });
    assert.equal(cols.get("customer_id"), "orders.Customer_ID");
  });
});

describe("grainNotNullFindings", () => {
  const grainOf = (...cols) => ({ groupBy: cols, dedupPartition: [] });

  test("reports exactly one warning naming an unguarded grain column", () => {
    const out = grainNotNullFindings({ grain: grainOf("customer_id"), notNull: new Set(), source: "manifest" });
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, "warning");
    assert.equal(out[0].category, "test_coverage");
    assert.equal(out[0].column, "customer_id");
    assert.ok(out[0].title.includes("customer_id"));
  });

  test("reports nothing when the grain column has a not_null test", () => {
    const out = grainNotNullFindings({ grain: grainOf("customer_id"), notNull: new Set(["customer_id"]), source: "manifest" });
    assert.deepEqual(out, []);
  });

  test("matches the declared test case-insensitively", () => {
    const out = grainNotNullFindings({ grain: grainOf("Customer_ID"), notNull: new Set(["customer_id"]), source: "manifest" });
    assert.deepEqual(out, []);
  });

  test("reports nothing when there is no grain", () => {
    assert.deepEqual(grainNotNullFindings({ grain: grainOf(), notNull: new Set(), source: "manifest" }), []);
  });

  test("ignores grain entries that are not declarable columns", () => {
    const out = grainNotNullFindings({ grain: grainOf("1", "date_trunc('day', ts)"), notNull: new Set(), source: "manifest" });
    assert.deepEqual(out, []);
  });

  test("stays silent when no declared-test source is available", () => {
    assert.deepEqual(grainNotNullFindings({ grain: grainOf("a"), notNull: null, source: "manifest" }), []);
  });

  test("rolls a wide grain into one finding so it cannot trip the warning-pattern block", () => {
    const wide = Array.from({ length: GRAIN_ROLLUP_AT + 2 }, (_, i) => `col_${i}`);
    const out = grainNotNullFindings({ grain: grainOf(...wide), notNull: new Set(), source: "manifest" });
    assert.equal(out.length, 1);
    for (const c of wide) assert.ok(out[0].title.includes(c), `missing ${c}`);
  });

  test("gives each finding a distinct, column-scoped ruleKey", () => {
    const out = grainNotNullFindings({ grain: grainOf("a", "b"), notNull: new Set(), source: "manifest" });
    assert.deepEqual(out.map((f) => f.ruleKey), ["grain_not_null:a", "grain_not_null:b"]);
  });

  test("names its declared-test source in the body", () => {
    const out = grainNotNullFindings({ grain: grainOf("a"), notNull: new Set(), source: "schema.yml" });
    assert.ok(out[0].body.includes("schema.yml"));
  });
});

describe("notNullFromManifest", () => {
  const manifest = {
    nodes: {
      "model.p.orders": { resource_type: "model", name: "orders" },
      "test.p.not_null_orders_order_id": {
        resource_type: "test",
        test_metadata: { name: "not_null", kwargs: { column_name: "order_id" } },
        column_name: "order_id",
        attached_node: "model.p.orders",
        depends_on: { nodes: ["model.p.orders"] },
      },
      "test.p.unique_orders_order_id": {
        resource_type: "test",
        test_metadata: { name: "unique", kwargs: { column_name: "order_id" } },
        column_name: "order_id",
        attached_node: "model.p.orders",
        depends_on: { nodes: ["model.p.orders"] },
      },
      "test.p.not_null_other_x": {
        resource_type: "test",
        test_metadata: { name: "not_null", kwargs: { column_name: "x" } },
        column_name: "x",
        attached_node: "model.p.other",
        depends_on: { nodes: ["model.p.other"] },
      },
    },
  };

  test("collects only not_null columns for the requested model", () => {
    assert.deepEqual([...notNullFromManifest(manifest, "orders")], ["order_id"]);
  });

  test("resolves a manifest that carries depends_on but no attached_node", () => {
    const legacy = {
      nodes: {
        "model.p.orders": { resource_type: "model", name: "orders" },
        "test.p.n": {
          resource_type: "test",
          test_metadata: { name: "not_null", kwargs: { column_name: "customer_id" } },
          depends_on: { nodes: ["model.p.orders"] },
        },
      },
    };
    assert.deepEqual([...notNullFromManifest(legacy, "orders")], ["customer_id"]);
  });

  test("returns an empty set for a model in the manifest with no tests", () => {
    const m = { nodes: { "model.p.bare": { resource_type: "model", name: "bare" } } };
    assert.deepEqual([...notNullFromManifest(m, "bare")], []);
  });

  test("returns null when the model is absent, so the caller can fall back", () => {
    assert.equal(notNullFromManifest(manifest, "nope"), null);
    assert.equal(notNullFromManifest(null, "orders"), null);
  });
});

describe("notNullFromYamlDir", () => {
  const yaml = `
version: 2
models:
  - name: orders
    columns:
      - name: order_id
        tests: [not_null, unique]
      - name: customer_id
        tests: [unique]
`;
  const fakeFs = (files) => ({
    readDir: () => Object.keys(files),
    readFile: (p) => {
      const name = p.split("/").pop();
      if (!(name in files)) throw new Error("ENOENT");
      return files[name];
    },
  });

  test("reads not_null columns from a schema.yml beside the model", () => {
    const { readDir, readFile } = fakeFs({ "schema.yml": yaml });
    assert.deepEqual([...notNullFromYamlDir("/models", "orders", readDir, readFile)], ["order_id"]);
  });

  test("recognizes the dbt 1.8 data_tests key", () => {
    const { readDir, readFile } = fakeFs({
      "schema.yml": "models:\n  - name: orders\n    columns:\n      - name: order_id\n        data_tests: [not_null]\n",
    });
    assert.deepEqual([...notNullFromYamlDir("/models", "orders", readDir, readFile)], ["order_id"]);
  });

  test("skips YAML files that do not describe the model", () => {
    const { readDir, readFile } = fakeFs({ "other.yml": "models:\n  - name: someone_else\n", "schema.yml": yaml });
    assert.deepEqual([...notNullFromYamlDir("/models", "orders", readDir, readFile)], ["order_id"]);
  });

  test("returns null when no YAML in the directory mentions the model", () => {
    const { readDir, readFile } = fakeFs({ "other.yml": "models:\n  - name: someone_else\n" });
    assert.equal(notNullFromYamlDir("/models", "orders", readDir, readFile), null);
  });

  test("returns null when the directory cannot be read", () => {
    assert.equal(notNullFromYamlDir("/nope", "orders", () => { throw new Error("ENOENT"); }), null);
  });
});
