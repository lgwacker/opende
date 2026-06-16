import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadCore, call, FORBIDDEN, Schema } from "../../src/core.js";

describe("FORBIDDEN guard", () => {
  test("FORBIDDEN contains exactly the 5 blocked AI/telemetry functions", () => {
    const expected = new Set(["initSdk", "flushSdk", "resetSdk", "reviewAiParse", "reviewAiSystemPrompt"]);
    assert.deepEqual(FORBIDDEN, expected);
  });

  for (const name of ["initSdk", "flushSdk", "resetSdk", "reviewAiParse", "reviewAiSystemPrompt"]) {
    test(`call("${name}", []) throws with 'Refusing to call'`, async () => {
      await assert.rejects(() => call(name, []), /refusing to call/i);
    });
  }
});

describe("loadCore", () => {
  test("loads the @altimateai/altimate-core module without throwing", () => {
    const core = loadCore();
    assert.ok(core != null);
    assert.equal(typeof core, "object");
  });

  test("is cached — returns the same reference on repeated calls", () => {
    assert.strictEqual(loadCore(), loadCore());
  });

  test("exposes checkEquivalence as a function", () => {
    assert.equal(typeof loadCore().checkEquivalence, "function");
  });

  test("exposes lint as a function", () => {
    assert.equal(typeof loadCore().lint, "function");
  });
});

describe("call", () => {
  test("throws on unknown function name", async () => {
    await assert.rejects(() => call("no_such_fn_xyz", []), /has no function/i);
  });

  test("calls getStatementTypes successfully on a simple SELECT", async () => {
    const r = await call("getStatementTypes", ["SELECT 1", "snowflake"]);
    assert.ok(r.types || Array.isArray(r));
  });

  test("calls formatSql without throwing", async () => {
    const r = await call("formatSql", ["select 1 as n", "snowflake"]);
    assert.ok(typeof r === "string" || typeof r === "object");
  });

  test("returns a result for lint with a degraded schema", async () => {
    // lint requires a Schema object — resolveSchema degrades gracefully to a synthetic schema
    const { resolveSchema } = await import("../../src/schema.js");
    const schema = resolveSchema({ catalogPath: "/no/catalog.json", manifestPath: "/no/manifest.json" });
    const r = await call("lint", ["SELECT 1", schema]);
    assert.ok(r != null);
  });
});

describe("Schema", () => {
  test("Schema() returns the Schema class (function/constructor)", () => {
    const S = Schema();
    assert.equal(typeof S, "function");
  });
});
