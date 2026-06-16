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
