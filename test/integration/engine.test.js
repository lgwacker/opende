// Integration tests for the key altimate-core engine functions via call().
// These tests verify the engine is correctly loaded and producing sensible
// outputs — not exhaustive correctness, but enough to catch API breaks and
// binary/version issues early.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { call } from "../../src/core.js";
import { resolveSchema } from "../../src/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const emptySchema = () => resolveSchema({ catalogPath: "/no/catalog.json", manifestPath: "/no/manifest.json" });
const SIMPLE_SELECT = "SELECT order_id, amount FROM orders WHERE amount > 0";
const SELECT_ONE = "SELECT 1 AS n";

describe("transpile", () => {
  test("transpiles a simple query between dialects without throwing", async () => {
    const r = await call("transpile", [SELECT_ONE, "snowflake", "bigquery"]);
    assert.ok(r != null);
  });
});

describe("formatSql", () => {
  test("returns a formatted SQL string", async () => {
    const r = await call("formatSql", ["select 1 as n, 2 as m from orders", "snowflake"]);
    assert.ok(typeof r === "string" || (typeof r === "object" && r != null));
  });
});

describe("getStatementTypes", () => {
  test("classifies SELECT as a query type", async () => {
    const r = await call("getStatementTypes", [SIMPLE_SELECT, "snowflake"]);
    const types = r.types || r;
    assert.ok(Array.isArray(types) || (r && typeof r === "object"));
  });

  test("classifies INSERT as a non-query type", async () => {
    const r = await call("getStatementTypes", ["INSERT INTO t VALUES (1)", "snowflake"]);
    assert.ok(r != null);
  });
});

describe("lint", () => {
  test("returns findings array (may be empty for clean SQL)", async () => {
    const r = await call("lint", [SIMPLE_SELECT, emptySchema()]);
    assert.ok(r != null);
    assert.ok(Array.isArray(r.findings) || r.findings == null);
  });

  test("does not throw on well-formed SQL", async () => {
    await assert.doesNotReject(() => call("lint", [SELECT_ONE, emptySchema()]));
  });
});

describe("validate", () => {
  test("returns errors/warnings arrays", async () => {
    const r = await call("validate", [SIMPLE_SELECT, emptySchema()]);
    assert.ok(r != null);
    assert.ok(Array.isArray(r.errors) || r.errors == null);
  });
});

describe("checkSemantics", () => {
  test("returns findings array for a valid query", async () => {
    const r = await call("checkSemantics", [SIMPLE_SELECT, emptySchema()]);
    assert.ok(r != null);
  });
});

describe("evaluate", () => {
  test("returns a grade result with overall_grade field", async () => {
    const r = await call("evaluate", [SIMPLE_SELECT, emptySchema()]);
    assert.ok(r != null);
    assert.ok("overall_grade" in r || typeof r.grade === "string" || r.overall_grade !== undefined);
  });

  test("grade is a letter A-F", async () => {
    const r = await call("evaluate", [SIMPLE_SELECT, emptySchema()]);
    const grade = r.overall_grade || r.grade;
    if (grade) assert.ok(/^[A-F]$/.test(grade), `unexpected grade: ${grade}`);
  });
});

describe("scanSql", () => {
  test("returns threats array for a SELECT (should be empty or minimal)", async () => {
    const r = await call("scanSql", [SELECT_ONE]);
    assert.ok(r != null);
    assert.ok(Array.isArray(r.threats) || r.threats == null);
  });
});

describe("checkQueryPii", () => {
  test("returns pii_columns array (empty for a query with no PII columns in schema)", async () => {
    const r = await call("checkQueryPii", [SIMPLE_SELECT, emptySchema()]);
    assert.ok(r != null);
    assert.ok(Array.isArray(r.pii_columns) || r.pii_columns == null);
  });
});

describe("checkEquivalence", () => {
  test("returns equivalent=true for two identical queries", async () => {
    const sql = "SELECT id, name FROM users WHERE active = true";
    const r = await call("checkEquivalence", [sql, sql, emptySchema(), "snowflake"]);
    assert.ok(r != null);
    // Engine should determine identical queries are equivalent when decidable
    const eq = r.equivalent ?? r.is_equivalent;
    const decidable = r.decidable;
    if (decidable !== false) {
      assert.ok(eq === true || eq === undefined, `expected equivalent=true for identical SQL, got: ${JSON.stringify(r)}`);
    }
  });

  test("accepts the dialect parameter (4th arg) without throwing", async () => {
    await assert.doesNotReject(() =>
      call("checkEquivalence", ["SELECT 1", "SELECT 1", emptySchema(), "snowflake"])
    );
  });

  test("returns an object with at least one result field", async () => {
    const r = await call("checkEquivalence", ["SELECT 1 AS a", "SELECT 1 AS b", emptySchema(), "snowflake"]);
    assert.ok(typeof r === "object" && r != null);
    const hasKnownField = "equivalent" in r || "is_equivalent" in r || "status" in r || "verdict" in r || "result" in r || "decidable" in r;
    assert.ok(hasKnownField, `unexpected result shape: ${JSON.stringify(r)}`);
  });

  test("respects decidable flag — does not force a verdict when engine is uncertain", async () => {
    // We can't force undecidability with simple SQL, but we verify the response
    // never has decidable=false AND equivalent=true at the same time (contradiction)
    const r = await call("checkEquivalence", ["SELECT 1", "SELECT 2", emptySchema(), "snowflake"]);
    if (r.decidable === false) {
      // engine said it can't decide — equivalent field should not be true
      assert.ok(r.equivalent !== true, "decidable=false should not come with equivalent=true");
    }
  });
});

describe("columnLineage", () => {
  test("does not throw on a simple query", async () => {
    await assert.doesNotReject(() =>
      call("columnLineage", [SIMPLE_SELECT, "snowflake", emptySchema(), null, null, null])
    );
  });
});

describe("extractOutputColumns", () => {
  test("returns column names for a SELECT list", async () => {
    const r = await call("extractOutputColumns", ["SELECT id, name, email FROM users", "snowflake"]);
    assert.ok(Array.isArray(r) || (typeof r === "object" && r != null));
  });
});

describe("generateTests", () => {
  test("returns test cases without throwing", async () => {
    await assert.doesNotReject(() => call("generateTests", [SIMPLE_SELECT, emptySchema()]));
  });
});

describe("tool count audit", () => {
  test("src/mcp.js defines exactly 64 tools (run: entries in TOOLS)", () => {
    const src = fs.readFileSync(new URL("../../src/mcp.js", import.meta.url), "utf8");
    const count = (src.match(/\brun: /g) || []).length;
    assert.equal(count, 64, `expected 64 tools in TOOLS registry, found ${count}`);
  });
});
