// Pure-JS half of the safety gate: the tokenizer and the textual hard-deny.
// The engine-backed behaviour lives in test/integration/safety.test.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeSql } from "../../src/safety.js";

const stmts = (sql) => normalizeSql(sql).statements.map((s) => s.stripped.trim());

describe("normalizeSql — comment stripping", () => {
  test("removes a leading block comment", () => {
    assert.equal(normalizeSql("/* c */ DROP DATABASE prod").stripped.trim(), "DROP DATABASE prod");
  });
  test("removes a line comment but keeps the newline", () => {
    assert.equal(normalizeSql("-- deploy\nSELECT 1").stripped.trim(), "SELECT 1");
  });
  test("removes a comment embedded mid-statement", () => {
    assert.match(normalizeSql("DROP /* x */ DATABASE prod").stripped, /DROP\s+DATABASE prod/);
  });
  test("an unterminated block comment swallows the rest, it does not throw", () => {
    assert.equal(normalizeSql("SELECT 1 /* never closed").stripped.trim(), "SELECT 1");
  });
  test("a comment marker INSIDE a string literal is preserved", () => {
    const r = normalizeSql("SELECT '-- not a comment' AS x");
    assert.match(r.stripped, /-- not a comment/);
  });
});

describe("normalizeSql — statement splitting", () => {
  test("splits on top-level semicolons", () => {
    assert.deepEqual(stmts("SELECT 1; SELECT 2"), ["SELECT 1", "SELECT 2"]);
  });
  test("a trailing semicolon does not produce an empty statement", () => {
    assert.deepEqual(stmts("SELECT 1;"), ["SELECT 1"]);
  });
  test("a semicolon inside a string literal does not split", () => {
    assert.deepEqual(stmts("SELECT 'a;b' AS x"), ["SELECT 'a;b' AS x"]);
  });
  test("a semicolon inside a comment does not split", () => {
    assert.deepEqual(stmts("SELECT 1 -- ; not a split\n"), ["SELECT 1"]);
  });
  test("a semicolon inside a $$ block does not split", () => {
    assert.equal(stmts("CREATE PROCEDURE p() AS $$ BEGIN x; y; END $$").length, 1);
  });
});

describe("normalizeSql — literal blanking", () => {
  test("blanks literal contents while preserving length and quotes", () => {
    const r = normalizeSql("SELECT 'DROP DATABASE x' AS note");
    assert.ok(!/DROP/.test(r.blanked), `expected DROP to be blanked, got: ${r.blanked}`);
    assert.match(r.blanked, /SELECT ' {15}' AS note/); // "DROP DATABASE x" is 15 chars
    assert.equal(r.blanked.length, r.stripped.length);
  });
  test("handles the '' escape without ending the literal early", () => {
    const r = normalizeSql("SELECT 'it''s' AS x");
    assert.ok(!/it/.test(r.blanked));
    assert.match(r.stripped, /'it''s'/);
  });
  test("leaves non-literal text untouched", () => {
    assert.equal(normalizeSql("SELECT a, b FROM t").blanked, "SELECT a, b FROM t");
  });
});
