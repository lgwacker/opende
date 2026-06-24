import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProfileEnvVars, flag, has } from "../../src/cli/init.js";

// ── flag / has ──────────────────────────────────────────────────────────────

describe("flag", () => {
  test("returns value after --name", () => {
    assert.equal(flag(["init", "--project-dir", "/my/dbt"], "project-dir", "."), "/my/dbt");
  });

  test("returns default when flag absent", () => {
    assert.equal(flag(["init", "--yes"], "project-dir", "."), ".");
  });

  test("returns default when next arg is another flag", () => {
    assert.equal(flag(["init", "--project-dir", "--yes"], "project-dir", "."), ".");
  });
});

describe("has", () => {
  test("returns true when flag present", () => {
    assert.ok(has(["init", "--yes"], "yes"));
  });

  test("returns false when flag absent", () => {
    assert.ok(!has(["init"], "yes"));
  });
});

// ── detectProfileEnvVars ──────────────────────────────────────────────────────

describe("detectProfileEnvVars", () => {
  let tmpDir;
  test.before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opende-profiles-")); });
  test.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test("returns empty vars when no profiles.yml exists", () => {
    const r = detectProfileEnvVars(path.join(tmpDir, "no-such-dir"));
    assert.deepEqual(r.vars, []);
    assert.equal(r.file, null);
  });

  test("extracts single env_var reference", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "single-"));
    fs.writeFileSync(path.join(dir, "profiles.yml"), `
my_profile:
  outputs:
    dev:
      password: "{{ env_var('SNOWFLAKE_PASSWORD') }}"
`);
    const r = detectProfileEnvVars(dir);
    assert.deepEqual(r.vars, ["SNOWFLAKE_PASSWORD"]);
    assert.ok(r.file.endsWith("profiles.yml"));
  });

  test("extracts multiple distinct env_var references", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "multi-"));
    fs.writeFileSync(path.join(dir, "profiles.yml"), `
my_profile:
  outputs:
    dev:
      account: "{{ env_var('SNOWFLAKE_ACCOUNT') }}"
      user: "{{ env_var('SNOWFLAKE_USER') }}"
      password: "{{ env_var('SNOWFLAKE_PASSWORD') }}"
      database: "{{ env_var('SNOWFLAKE_DATABASE') }}"
`);
    const r = detectProfileEnvVars(dir);
    assert.deepEqual(r.vars, ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PASSWORD", "SNOWFLAKE_DATABASE"]);
  });

  test("deduplicates repeated references", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "dedup-"));
    fs.writeFileSync(path.join(dir, "profiles.yml"), `
dev:
  password: "{{ env_var('SECRET') }}"
prod:
  password: "{{ env_var('SECRET') }}"
`);
    const r = detectProfileEnvVars(dir);
    assert.deepEqual(r.vars, ["SECRET"]);
  });

  test("supports single-quoted env_var names", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "squote-"));
    fs.writeFileSync(path.join(dir, "profiles.yml"), "password: \"{{ env_var('MY_PASS') }}\"");
    const r = detectProfileEnvVars(dir);
    assert.ok(r.vars.includes("MY_PASS"));
  });

  test("supports double-quoted env_var names", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "dquote-"));
    fs.writeFileSync(path.join(dir, "profiles.yml"), 'password: "{{ env_var("MY_PASS") }}"');
    const r = detectProfileEnvVars(dir);
    assert.ok(r.vars.includes("MY_PASS"));
  });

  test("project-level profiles.yml takes precedence over ~/.dbt/profiles.yml", () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "precedence-"));
    fs.writeFileSync(path.join(dir, "profiles.yml"), "a: \"{{ env_var('PROJECT_VAR') }}\"");
    const r = detectProfileEnvVars(dir);
    assert.ok(r.vars.includes("PROJECT_VAR"));
    assert.ok(r.file.startsWith(dir));
  });
});
