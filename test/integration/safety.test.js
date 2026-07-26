import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gateSql } from "../../src/safety.js";

const HARD_DENY_MSG = /drop database|drop schema|truncate.*blocked/i;

describe("gateSql — hard-denied statements (unoverridable)", () => {
  test("DROP DATABASE throws regardless of allowWrite", async () => {
    await assert.rejects(() => gateSql("DROP DATABASE mydb", { allowWrite: true }), HARD_DENY_MSG);
  });

  test("DROP SCHEMA throws regardless of allowWrite", async () => {
    await assert.rejects(() => gateSql("DROP SCHEMA myschema", { allowWrite: true }), HARD_DENY_MSG);
  });

  test("TRUNCATE throws regardless of allowWrite", async () => {
    await assert.rejects(() => gateSql("TRUNCATE orders", { allowWrite: true }), HARD_DENY_MSG);
  });

  test("TRUNCATE TABLE throws regardless of allowWrite", async () => {
    await assert.rejects(() => gateSql("TRUNCATE TABLE orders", { allowWrite: true }), HARD_DENY_MSG);
  });

  test("DROP DATABASE is case-insensitive", async () => {
    await assert.rejects(() => gateSql("drop database mydb"), HARD_DENY_MSG);
  });

  test("DROP SCHEMA is case-insensitive", async () => {
    await assert.rejects(() => gateSql("DROP schema myschema"), HARD_DENY_MSG);
  });

  test("TRUNCATE is case-insensitive", async () => {
    await assert.rejects(() => gateSql("truncate orders"), HARD_DENY_MSG);
  });
});

describe("gateSql — SELECT statements (read:true)", () => {
  test("plain SELECT returns read:true", async () => {
    const r = await gateSql("SELECT 1 AS n");
    assert.equal(r.read, true);
  });

  test("SELECT with WHERE returns read:true", async () => {
    const r = await gateSql("SELECT order_id FROM orders WHERE status = 'active'");
    assert.equal(r.read, true);
  });

  test("WITH ... SELECT (CTE) returns read:true", async () => {
    const r = await gateSql("WITH cte AS (SELECT 1) SELECT * FROM cte");
    assert.equal(r.read, true);
  });

  test("returns a types array", async () => {
    const r = await gateSql("SELECT 1");
    assert.ok(Array.isArray(r.types));
  });
});

describe("gateSql — non-read statements (allowWrite gating)", () => {
  test("INSERT without allowWrite throws", async () => {
    await assert.rejects(
      () => gateSql("INSERT INTO orders VALUES (1, 2, 3)"),
      /non-select|non.*read|blocked/i,
    );
  });

  test("UPDATE without allowWrite throws", async () => {
    await assert.rejects(
      () => gateSql("UPDATE orders SET status = 'done' WHERE id = 1"),
      /non-select|non.*read|blocked/i,
    );
  });

  test("DELETE without allowWrite throws", async () => {
    await assert.rejects(
      () => gateSql("DELETE FROM orders WHERE id = 1"),
      /non-select|non.*read|blocked/i,
    );
  });

  test("INSERT with allowWrite:true passes through", async () => {
    const r = await gateSql("INSERT INTO orders VALUES (1, 2, 3)", { allowWrite: true });
    assert.equal(r.read, false);
  });

  test("DELETE with allowWrite:true passes through", async () => {
    const r = await gateSql("DELETE FROM orders WHERE id = 1", { allowWrite: true });
    assert.equal(r.read, false);
  });

  test("DROP DATABASE still throws even with allowWrite:true", async () => {
    await assert.rejects(() => gateSql("DROP DATABASE x", { allowWrite: true }), HARD_DENY_MSG);
  });
});

// ── Bypass regressions ──────────────────────────────────────────────────────
// Each case below was ALLOWED before the fail-closed rework. Two weaknesses
// combined: the hard-deny patterns were anchored at string start (so any leading
// comment defeated them), and a parser exception was swallowed, leaving the
// classifier check unable to fire. `DROP DATABASE IF EXISTS x CASCADE` is a
// parse error in the engine today, so these are not hypothetical.
describe("gateSql — hard-deny bypasses (regressions)", () => {
  const BYPASSES = [
    ["leading block comment", "/* c */ DROP DATABASE IF EXISTS prod CASCADE"],
    ["leading line comment", "-- deploy\nDROP DATABASE IF EXISTS prod CASCADE"],
    ["comment inside the statement", "DROP /* x */ DATABASE prod"],
    ["trailing statement in a batch", "SELECT 1; DROP DATABASE prod"],
    ["dynamic SQL", "EXECUTE IMMEDIATE 'DROP DATABASE prod'"],
    ["parse-error DDL", "DROP DATABASE IF EXISTS prod CASCADE"],
    ["parse-error schema DDL", "DROP SCHEMA IF EXISTS analytics CASCADE"],
  ];
  for (const [name, sql] of BYPASSES) {
    test(`blocked even with allowWrite: ${name}`, async () => {
      await assert.rejects(() => gateSql(sql, { allowWrite: true }), HARD_DENY_MSG);
    });
  }
});

describe("gateSql — no false denials", () => {
  const READS = [
    ["hard-deny keywords inside a string literal", "SELECT 'DROP DATABASE x' AS note"],
    ["hard-deny keywords inside a comment", "SELECT * FROM t -- DROP DATABASE prod"],
    ["an identifier that merely starts with truncate", "SELECT * FROM truncate_log"],
    ["the TRUNCATE() numeric function", "SELECT TRUNCATE(1.55, 1) AS x"],
    ["a plain CTE", "WITH a AS (SELECT 1) SELECT * FROM a"],
    ["multiple reads", "SELECT 1; SELECT 2"],
  ];
  for (const [name, sql] of READS) {
    test(`allowed as a read: ${name}`, async () => {
      const r = await gateSql(sql);
      assert.equal(r.read, true, `expected a read verdict for: ${sql}`);
    });
  }

  test("an ordinary write still needs allowWrite, and passes with it", async () => {
    await assert.rejects(() => gateSql("INSERT INTO t VALUES (1)"), /Non-SELECT statement blocked/);
    const r = await gateSql("INSERT INTO t VALUES (1)", { allowWrite: true });
    assert.equal(r.read, false);
  });
});

describe("gateSql — unparseable SQL fails closed", () => {
  test("a batch whose parse fails is never treated as a read", async () => {
    // Read-detection's no-parse fallback trusts a SINGLE statement only —
    // otherwise `SELECT 1; <write>` would slip past the default-deny.
    await assert.rejects(
      () => gateSql("SELECT 1; DELETE FROM t WHERE x IN (SELECT)"),
      /Non-SELECT statement blocked/,
    );
  });

  test("the returned envelope reports whether the engine could classify", async () => {
    assert.equal((await gateSql("SELECT 1")).parsed, true);
  });
});
