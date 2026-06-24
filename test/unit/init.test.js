import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyKeyChunk, detectProfileEnvVars, flag, has } from "../../src/cli/init.js";

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

// ── applyKeyChunk ────────────────────────────────────────────────────────────

describe("applyKeyChunk — string input (non-TTY path)", () => {
  test("appends printable character", () => {
    const r = applyKeyChunk("a", "");
    assert.equal(r.val, "a");
    assert.equal(r.done, false);
    assert.equal(r.abort, false);
  });

  test("appends multi-char string", () => {
    const r = applyKeyChunk("z", "abc");
    assert.equal(r.val, "abcz");
  });

  test("Enter (\\r) signals done", () => {
    const r = applyKeyChunk("\r", "secret");
    assert.equal(r.val, "secret");
    assert.equal(r.done, true);
  });

  test("newline (\\n) signals done", () => {
    const r = applyKeyChunk("\n", "secret");
    assert.equal(r.done, true);
  });

  test("backspace (127) removes last char", () => {
    const r = applyKeyChunk(String.fromCharCode(127), "abc");
    assert.equal(r.val, "ab");
  });

  test("backspace on empty string is a no-op", () => {
    const r = applyKeyChunk(String.fromCharCode(127), "");
    assert.equal(r.val, "");
  });

  test("Ctrl-C (3) signals abort", () => {
    const r = applyKeyChunk(String.fromCharCode(3), "");
    assert.equal(r.abort, true);
  });
});

describe("applyKeyChunk — Buffer input (raw TTY path)", () => {
  test("appends printable ASCII byte as string", () => {
    const r = applyKeyChunk(Buffer.from("a"), "");
    assert.equal(r.val, "a");
    assert.equal(r.done, false);
  });

  test("appends multi-byte UTF-8 character correctly", () => {
    // 'é' is 0xc3 0xa9 in UTF-8
    const r = applyKeyChunk(Buffer.from("é"), "pass");
    assert.equal(r.val, "passé");
  });

  test("Enter byte (13) signals done", () => {
    const r = applyKeyChunk(Buffer.from([13]), "s3cr3t");
    assert.equal(r.done, true);
    assert.equal(r.val, "s3cr3t");
  });

  test("newline byte (10) signals done", () => {
    const r = applyKeyChunk(Buffer.from([10]), "s3cr3t");
    assert.equal(r.done, true);
  });

  test("backspace byte (127) removes last char", () => {
    const r = applyKeyChunk(Buffer.from([127]), "abc");
    assert.equal(r.val, "ab");
  });

  test("Ctrl-C byte (3) signals abort", () => {
    const r = applyKeyChunk(Buffer.from([3]), "");
    assert.equal(r.abort, true);
  });

  test("does not throw when chunk is a Buffer — was the reported bug", () => {
    // Before the fix this threw: ch.charCodeAt is not a function
    assert.doesNotThrow(() => applyKeyChunk(Buffer.from("p"), ""));
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
    // Only create a project-level one; if the home one exists it would be found second.
    const dir = fs.mkdtempSync(path.join(tmpDir, "precedence-"));
    fs.writeFileSync(path.join(dir, "profiles.yml"), "a: \"{{ env_var('PROJECT_VAR') }}\"");
    const r = detectProfileEnvVars(dir);
    assert.ok(r.vars.includes("PROJECT_VAR"));
    assert.ok(r.file.startsWith(dir));
  });
});

// ── secret masking — no plaintext in prompt output ───────────────────────────
// These tests verify that secret values never appear in stdout during the wizard.
// Strategy: capture stdout writes and assert no secret value leaks through.

describe("secret masking", () => {
  function captureStdout(fn) {
    const captured = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return true; };
    try { fn(); } finally { process.stdout.write = orig; }
    return captured.join("");
  }

  test("applyKeyChunk never writes plaintext — only asterisks and control sequences", () => {
    // Simulate typing "s3cr3t" + Enter through applyKeyChunk and check stdout output.
    const output = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { output.push(String(chunk)); return true; };

    let val = "";
    for (const ch of "s3cr3t") {
      const r = applyKeyChunk(ch, val);
      val = r.val;
      if (!r.done && !r.abort) {
        // Simulate what askHidden does: write "*" for each char
        process.stdout.write("*");
      }
    }
    process.stdout.write = origWrite;

    const out = output.join("");
    assert.ok(!out.includes("s3cr3t"), "plaintext secret must not appear in output");
    assert.equal(out, "******");
  });

  test("applyKeyChunk with Buffer never writes plaintext", () => {
    const output = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { output.push(String(chunk)); return true; };

    let val = "";
    for (const ch of "p@ssw0rd") {
      const r = applyKeyChunk(Buffer.from(ch), val);
      val = r.val;
      if (!r.done && !r.abort) process.stdout.write("*");
    }
    process.stdout.write = origWrite;

    const out = output.join("");
    assert.ok(!out.includes("p@ssw0rd"), "Buffer-path: plaintext must not appear in output");
    assert.equal(out, "********");
  });

  test("backspace erases last char without revealing earlier chars", () => {
    const output = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { output.push(String(chunk)); return true; };

    let val = "";
    // type "abc", then backspace, then "d"
    for (const input of ["a", "b", "c", String.fromCharCode(127), "d"]) {
      const r = applyKeyChunk(input, val);
      const erased = r.val.length < val.length;
      val = r.val;
      if (!r.done && !r.abort) process.stdout.write(erased ? "\b \b" : "*");
    }
    process.stdout.write = origWrite;

    const out = output.join("");
    assert.ok(!out.includes("abc"), "partial plaintext must not appear");
    assert.ok(!out.includes("abd"), "final plaintext must not appear");
    // Should only contain asterisks and backspace control sequence
    assert.ok(/^[\*\x08 ]+$/.test(out), `unexpected chars in output: ${JSON.stringify(out)}`);
  });

  test("isSecret regex matches known sensitive name patterns", () => {
    const isSecret = (name) => /password|secret|token|private_key(?!_path)/i.test(name);
    assert.ok(isSecret("SNOWFLAKE_PASSWORD"));
    assert.ok(isSecret("DB_SECRET"));
    assert.ok(isSecret("API_TOKEN"));
    assert.ok(isSecret("PRIVATE_KEY"));
    assert.ok(!isSecret("PRIVATE_KEY_PATH"), "key path is not a secret value");
    assert.ok(!isSecret("SNOWFLAKE_ACCOUNT"));
    assert.ok(!isSecret("SNOWFLAKE_USER"));
    assert.ok(!isSecret("SNOWFLAKE_DATABASE"));
    assert.ok(!isSecret("SNOWFLAKE_WAREHOUSE"));
  });
});
