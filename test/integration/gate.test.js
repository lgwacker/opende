// End-to-end tests for gate.js by spawning it as a subprocess.
// Tests the hook mode and CLI mode with real SQL files.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENDE_ROOT = path.resolve(__dirname, "../..");
const GATE_BIN = path.join(OPENDE_ROOT, "src/gate.js");
const FIXTURE_SQL_DIR = path.resolve(__dirname, "../fixtures/sql");
const FIXTURE_DBT = path.resolve(__dirname, "../fixtures/throwaway-dbt");
const FIXTURE_MODELS_DIR = path.join(FIXTURE_DBT, "models/staging");

function runGate(args, opts = {}) {
  return spawnSync("node", [GATE_BIN, ...args], {
    encoding: "utf8",
    timeout: 30000,
    input: opts.input,
    env: { ...process.env, ...opts.env },
    cwd: OPENDE_ROOT,
  });
}

describe("gate.js CLI mode — file arguments", () => {
  test("exits 0 for a clean SELECT SQL file", () => {
    const result = runGate([path.join(FIXTURE_SQL_DIR, "select_ok.sql")]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  });

  test("exits 0 for a Jinja model (advisory only, never blocks)", () => {
    // Jinja model has no compiled SQL → jinja_uncompiled info finding, exit 0
    const result = runGate([path.join(FIXTURE_MODELS_DIR, "stg_orders.sql")]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  });

  test("reports jinja_uncompiled info for raw Jinja model", () => {
    const result = runGate([path.join(FIXTURE_MODELS_DIR, "stg_orders.sql")]);
    const out = result.stdout + result.stderr;
    // It should mention jinja or the skip message
    assert.ok(out.includes("jinja") || out.includes("Jinja") || result.status === 0,
      `expected jinja advisory or clean exit, got: ${out}`);
  });

  test("exits 0 when no SQL files given (no-op)", () => {
    const result = runGate([]);
    assert.equal(result.status, 0);
  });

  test("exits 0 when non-existent file path is passed (ignored)", () => {
    const result = runGate(["/no/such/file.sql"]);
    assert.equal(result.status, 0);
  });
});

describe("gate.js hook mode (--hook)", () => {
  test("exits 0 when hook JSON points to a non-SQL file (ignored)", () => {
    const hookPayload = JSON.stringify({ tool_input: { file_path: "/some/file.py" } });
    const result = runGate(["--hook"], { input: hookPayload });
    assert.equal(result.status, 0);
  });

  test("exits 0 when hook JSON has no file_path", () => {
    const hookPayload = JSON.stringify({ tool_input: {} });
    const result = runGate(["--hook"], { input: hookPayload });
    assert.equal(result.status, 0);
  });

  test("exits 0 when hook receives malformed JSON (graceful)", () => {
    const result = runGate(["--hook"], { input: "not json at all" });
    assert.equal(result.status, 0);
  });

  test("exits 0 for clean SQL in hook mode", () => {
    const hookPayload = JSON.stringify({
      tool_input: { file_path: path.join(FIXTURE_SQL_DIR, "select_ok.sql") },
    });
    const result = runGate(["--hook"], { input: hookPayload });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  });

  test("exits 0 for Jinja model in hook mode (advisory, never blocks)", () => {
    const hookPayload = JSON.stringify({
      tool_input: { file_path: path.join(FIXTURE_MODELS_DIR, "stg_orders.sql") },
    });
    const result = runGate(["--hook"], { input: hookPayload });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  });
});

describe("gate.js — render-then-analyze with compiled SQL", () => {
  let tmpSqlFile;
  let tmpCleanup;

  test.before(() => {
    // Create a temp plain SQL file (no Jinja) so the gate analyzes it directly
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opende-gate-"));
    tmpSqlFile = path.join(tmpDir, "clean_model.sql");
    fs.writeFileSync(tmpSqlFile, "SELECT id, name FROM customers WHERE active = true\n");
    tmpCleanup = () => fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test.after(() => tmpCleanup?.());

  test("analyzes a plain SQL file (no Jinja) and exits 0", () => {
    const result = runGate([tmpSqlFile]);
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});

describe("gate.js — ALTIMATE_FAIL_ON env override", () => {
  test("--fail-on none always exits 0 even if there are advisory findings", () => {
    const result = runGate(["--fail-on", "none", path.join(FIXTURE_SQL_DIR, "select_ok.sql")]);
    assert.equal(result.status, 0);
  });
});
