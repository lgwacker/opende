import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { schemaVerify } from "../../src/schemaverify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DBT = path.resolve(__dirname, "../fixtures/throwaway-dbt");
const FIXTURE_MANIFEST = path.join(FIXTURE_DBT, "target/manifest.json");
const FIXTURE_CATALOG = path.join(FIXTURE_DBT, "target/catalog.json");

describe("schemaVerify — match (catalog columns = spec columns)", () => {
  test("returns 'match' verdict when catalog matches schema.yml", () => {
    const r = schemaVerify({
      model: "stg_orders",
      projectDir: FIXTURE_DBT,
      manifestPath: FIXTURE_MANIFEST,
      catalogPath: FIXTURE_CATALOG,
      allowShow: false,
    });
    assert.equal(r.model, "stg_orders");
    assert.equal(r.verdict, "match");
    assert.deepEqual(r.columns_extra, []);
    assert.deepEqual(r.columns_missing, []);
    assert.deepEqual(r.columns_reordered, []);
    assert.deepEqual(r.type_mismatches, []);
  });
});

describe("schemaVerify — missing manifest", () => {
  test("returns degraded when manifest does not exist", () => {
    const r = schemaVerify({
      model: "stg_orders",
      projectDir: FIXTURE_DBT,
      manifestPath: "/nonexistent/manifest.json",
      allowShow: false,
    });
    assert.ok(r.degraded);
    assert.ok(r.error?.includes("No manifest"));
  });
});

describe("schemaVerify — model not in manifest", () => {
  test("returns error when model is not in manifest", () => {
    const r = schemaVerify({
      model: "nonexistent_model",
      projectDir: FIXTURE_DBT,
      manifestPath: FIXTURE_MANIFEST,
      catalogPath: FIXTURE_CATALOG,
      allowShow: false,
    });
    assert.ok(r.error?.includes("not found") || r.error?.includes("nonexistent_model"));
  });
});

describe("schemaVerify — mismatch cases", () => {
  let tmpDir;
  let cleanup;

  const baseCatalog = (colOverrides = {}) => ({
    nodes: {
      "model.throwaway.stg_orders": {
        metadata: { type: "VIEW" },
        columns: {
          ORDER_ID:    { index: 1, name: "ORDER_ID",    type: "NUMBER" },
          CUSTOMER_ID: { index: 2, name: "CUSTOMER_ID", type: "NUMBER" },
          AMOUNT:      { index: 3, name: "AMOUNT",      type: "FLOAT" },
          ...colOverrides,
        },
      },
    },
    sources: {},
  });

  test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opende-schemaverify-"));
    cleanup = () => fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, "target"), { recursive: true });
    // Copy fixture manifest into tmpDir
    fs.copyFileSync(FIXTURE_MANIFEST, path.join(tmpDir, "target", "manifest.json"));
  });
  test.after(() => cleanup?.());

  test("detects extra columns (catalog has column not in schema.yml)", () => {
    const catalog = baseCatalog({ EXTRA_COL: { index: 4, name: "EXTRA_COL", type: "VARCHAR" } });
    const catPath = path.join(tmpDir, "target", "catalog_extra.json");
    fs.writeFileSync(catPath, JSON.stringify(catalog));
    const r = schemaVerify({
      model: "stg_orders",
      projectDir: tmpDir,
      manifestPath: path.join(tmpDir, "target", "manifest.json"),
      catalogPath: catPath,
      allowShow: false,
    });
    assert.equal(r.verdict, "mismatch");
    assert.ok(r.columns_extra.map(c => c.toLowerCase()).includes("extra_col"));
  });

  test("detects missing columns (schema.yml declares column not in catalog)", () => {
    // Catalog has only ORDER_ID and CUSTOMER_ID, but schema.yml has ORDER_ID, CUSTOMER_ID, AMOUNT
    const catalog = {
      nodes: {
        "model.throwaway.stg_orders": {
          metadata: { type: "VIEW" },
          columns: {
            ORDER_ID:    { index: 1, name: "ORDER_ID",    type: "NUMBER" },
            CUSTOMER_ID: { index: 2, name: "CUSTOMER_ID", type: "NUMBER" },
          },
        },
      },
      sources: {},
    };
    const catPath = path.join(tmpDir, "target", "catalog_missing.json");
    fs.writeFileSync(catPath, JSON.stringify(catalog));
    const r = schemaVerify({
      model: "stg_orders",
      projectDir: tmpDir,
      manifestPath: path.join(tmpDir, "target", "manifest.json"),
      catalogPath: catPath,
      allowShow: false,
    });
    assert.equal(r.verdict, "mismatch");
    assert.ok(r.columns_missing.map(c => c.toLowerCase()).includes("amount"));
  });

  test("case-insensitive column name comparison", () => {
    // Catalog uses lowercase, schema.yml uses uppercase → should still match
    const catalog = {
      nodes: {
        "model.throwaway.stg_orders": {
          metadata: { type: "VIEW" },
          columns: {
            order_id:    { index: 1, name: "order_id",    type: "NUMBER" },
            customer_id: { index: 2, name: "customer_id", type: "NUMBER" },
            amount:      { index: 3, name: "amount",      type: "FLOAT" },
          },
        },
      },
      sources: {},
    };
    const catPath = path.join(tmpDir, "target", "catalog_lower.json");
    fs.writeFileSync(catPath, JSON.stringify(catalog));
    const r = schemaVerify({
      model: "stg_orders",
      projectDir: tmpDir,
      manifestPath: path.join(tmpDir, "target", "manifest.json"),
      catalogPath: catPath,
      allowShow: false,
    });
    assert.equal(r.verdict, "match", `expected match but got: ${JSON.stringify(r)}`);
  });
});

describe("schemaVerify — no-spec (model has no columns declared in schema.yml)", () => {
  test("returns 'no-spec' verdict when manifest node has empty columns", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opende-nospec-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "target"), { recursive: true });
      const manifest = {
        nodes: {
          "model.proj.empty_model": { resource_type: "model", name: "empty_model", columns: {}, depends_on: { nodes: [] } },
        },
        sources: {},
        child_map: { "model.proj.empty_model": [] },
      };
      const catalog = {
        nodes: {
          "model.proj.empty_model": {
            metadata: { type: "VIEW" },
            columns: { COL1: { index: 1, name: "COL1", type: "NUMBER" } },
          },
        },
        sources: {},
      };
      const manPath = path.join(tmpDir, "target", "manifest.json");
      const catPath = path.join(tmpDir, "target", "catalog.json");
      fs.writeFileSync(manPath, JSON.stringify(manifest));
      fs.writeFileSync(catPath, JSON.stringify(catalog));
      const r = schemaVerify({ model: "empty_model", projectDir: tmpDir, manifestPath: manPath, catalogPath: catPath, allowShow: false });
      assert.equal(r.verdict, "no-spec");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
