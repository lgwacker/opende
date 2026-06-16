import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { impactAnalysis } from "../../src/impact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DBT = path.resolve(__dirname, "../fixtures/throwaway-dbt");
const FIXTURE_MANIFEST = path.join(FIXTURE_DBT, "target/manifest.json");

// Build a richer in-memory manifest for DAG tests.
function makeManifest(nodes, childMap) {
  return {
    metadata: { adapter_type: "snowflake" },
    nodes,
    sources: {},
    child_map: childMap,
  };
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(path.join(dir, "target"), { recursive: true });
  fs.writeFileSync(path.join(dir, "target", "manifest.json"), JSON.stringify(manifest));
  return path.join(dir, "target", "manifest.json");
}

const modelNode = (name) => ({ resource_type: "model", name, columns: {}, depends_on: { nodes: [] } });
const testNode = (name, deps) => ({ resource_type: "test", name, depends_on: { nodes: deps } });

describe("impactAnalysis — fixture manifest", () => {
  test("stg_orders with no downstream children → SAFE, downstream_count=0", () => {
    const r = impactAnalysis({ model: "stg_orders", manifestPath: FIXTURE_MANIFEST });
    assert.ok(r.success);
    assert.equal(r.model, "stg_orders");
    assert.equal(r.severity, "SAFE");
    assert.equal(r.downstream_count, 0);
    assert.deepEqual(r.direct_downstream, []);
    assert.deepEqual(r.transitive_downstream, []);
  });

  test("stg_orders affected_tests = 0 (no tests in fixture)", () => {
    const r = impactAnalysis({ model: "stg_orders", manifestPath: FIXTURE_MANIFEST });
    assert.equal(r.affected_tests, 0);
  });

  test("includes column and change_type in result", () => {
    const r = impactAnalysis({ model: "stg_orders", column: "amount", changeType: "remove", manifestPath: FIXTURE_MANIFEST });
    assert.equal(r.column, "amount");
    assert.equal(r.change_type, "remove");
  });
});

describe("impactAnalysis — missing manifest", () => {
  test("returns degraded result when manifest does not exist", () => {
    const r = impactAnalysis({ model: "stg_orders", manifestPath: "/nonexistent/manifest.json" });
    assert.ok(!r.success);
    assert.ok(r.degraded);
    assert.equal(r.severity, "UNKNOWN");
    assert.ok(r.message);
  });
});

describe("impactAnalysis — model not in manifest", () => {
  test("returns not-found result", () => {
    const r = impactAnalysis({ model: "nonexistent_model", manifestPath: FIXTURE_MANIFEST });
    assert.ok(!r.success);
    assert.ok(r.message.includes("not found"));
  });
});

describe("impactAnalysis — DAG traversal and severity tiers", () => {
  let tmpDir;
  let cleanup;

  test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opende-impact-"));
    cleanup = () => fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  test.after(() => cleanup?.());

  test("SAFE when 0 downstream models", () => {
    const man = makeManifest(
      { "model.proj.root": modelNode("root") },
      { "model.proj.root": [] },
    );
    const mp = writeManifest(tmpDir + "/safe", man);
    const r = impactAnalysis({ model: "root", manifestPath: mp });
    assert.equal(r.severity, "SAFE");
    assert.equal(r.downstream_count, 0);
  });

  test("LOW severity for 1-3 downstream models", () => {
    const nodes = {
      "model.proj.root": modelNode("root"),
      "model.proj.child1": modelNode("child1"),
      "model.proj.child2": modelNode("child2"),
    };
    const child = {
      "model.proj.root": ["model.proj.child1", "model.proj.child2"],
      "model.proj.child1": [],
      "model.proj.child2": [],
    };
    const mp = writeManifest(tmpDir + "/low", makeManifest(nodes, child));
    const r = impactAnalysis({ model: "root", manifestPath: mp });
    assert.equal(r.severity, "LOW");
    assert.equal(r.downstream_count, 2);
    assert.deepEqual(r.direct_downstream.sort(), ["child1", "child2"]);
  });

  test("MEDIUM severity for 4-10 downstream models", () => {
    const nodes = { "model.proj.root": modelNode("root") };
    const childIds = [];
    for (let i = 1; i <= 5; i++) {
      const id = `model.proj.c${i}`;
      nodes[id] = modelNode(`c${i}`);
      childIds.push(id);
    }
    const child = { "model.proj.root": childIds };
    for (const id of childIds) child[id] = [];
    const mp = writeManifest(tmpDir + "/medium", makeManifest(nodes, child));
    const r = impactAnalysis({ model: "root", manifestPath: mp });
    assert.equal(r.severity, "MEDIUM");
  });

  test("HIGH severity for >10 downstream models", () => {
    const nodes = { "model.proj.root": modelNode("root") };
    const childIds = [];
    for (let i = 1; i <= 12; i++) {
      const id = `model.proj.c${i}`;
      nodes[id] = modelNode(`c${i}`);
      childIds.push(id);
    }
    const child = { "model.proj.root": childIds };
    for (const id of childIds) child[id] = [];
    const mp = writeManifest(tmpDir + "/high", makeManifest(nodes, child));
    const r = impactAnalysis({ model: "root", manifestPath: mp });
    assert.equal(r.severity, "HIGH");
  });

  test("snapshots and tests are NOT counted as downstream models", () => {
    const nodes = {
      "model.proj.root": modelNode("root"),
      "snapshot.proj.snap1": { resource_type: "snapshot", name: "snap1", depends_on: { nodes: [] } },
      "test.proj.test1": testNode("test1", ["model.proj.root"]),
    };
    const child = {
      "model.proj.root": ["snapshot.proj.snap1", "test.proj.test1"],
      "snapshot.proj.snap1": [],
      "test.proj.test1": [],
    };
    const mp = writeManifest(tmpDir + "/snapshots", makeManifest(nodes, child));
    const r = impactAnalysis({ model: "root", manifestPath: mp });
    assert.equal(r.downstream_count, 0, "snapshots/tests should not count as downstream");
    assert.equal(r.severity, "SAFE");
  });

  test("affected_tests includes tests that depend on downstream models", () => {
    const nodes = {
      "model.proj.root": modelNode("root"),
      "model.proj.child": modelNode("child"),
      "test.proj.t1": testNode("t1", ["model.proj.child"]),
    };
    const child = {
      "model.proj.root": ["model.proj.child"],
      "model.proj.child": [],
      "test.proj.t1": [],
    };
    const mp = writeManifest(tmpDir + "/tests", makeManifest(nodes, child));
    const r = impactAnalysis({ model: "root", manifestPath: mp });
    assert.ok(r.affected_tests >= 1);
  });

  test("direct vs transitive downstream are correctly separated", () => {
    const nodes = {
      "model.proj.root": modelNode("root"),
      "model.proj.direct": modelNode("direct"),
      "model.proj.transitive": modelNode("transitive"),
    };
    const child = {
      "model.proj.root": ["model.proj.direct"],
      "model.proj.direct": ["model.proj.transitive"],
      "model.proj.transitive": [],
    };
    const mp = writeManifest(tmpDir + "/chain", makeManifest(nodes, child));
    const r = impactAnalysis({ model: "root", manifestPath: mp });
    assert.deepEqual(r.direct_downstream, ["direct"]);
    assert.deepEqual(r.transitive_downstream, ["transitive"]);
    assert.equal(r.downstream_count, 2);
  });
});

describe("impactAnalysis — schemaverify integration", () => {
  test("finds model by name ending (id.endsWith('.model_name'))", () => {
    const r = impactAnalysis({ model: "stg_orders", manifestPath: FIXTURE_MANIFEST });
    assert.equal(r.model, "stg_orders");
    assert.ok(r.success);
  });
});
