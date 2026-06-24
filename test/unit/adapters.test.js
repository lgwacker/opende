import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getAdapter, ADAPTERS } from "../../src/cli/adapters/index.js";
import { claudeAdapter } from "../../src/cli/adapters/claude.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENDE_ROOT = path.resolve(__dirname, "../..");
const FIXTURE_DBT = path.resolve(__dirname, "../fixtures/throwaway-dbt");

describe("adapter registry", () => {
  test("ADAPTERS exports a 'claude' key", () => {
    assert.ok("claude" in ADAPTERS);
  });

  test("getAdapter('claude') returns the claude adapter with correct id", () => {
    const adapter = getAdapter("claude");
    assert.equal(adapter.id, "claude");
  });

  test("getAdapter('unknown') throws 'Unknown harness'", () => {
    assert.throws(() => getAdapter("unknown"), /unknown harness/i);
  });
});

describe("claudeAdapter.scaffold", () => {
  let tmpDir;
  const logs = [];

  const makeCtx = (dir) => ({
    projectDir: dir,
    pkgRoot: OPENDE_ROOT,
    bins: {
      mcp: path.join(OPENDE_ROOT, "src/mcp.js"),
      gate: path.join(OPENDE_ROOT, "src/gate.js"),
      review: path.join(OPENDE_ROOT, "src/pr_review.js"),
    },
    dbtCmd: "dbt",
    signingKey: null,
    force: false,
    log: (msg) => logs.push(msg),
  });

  test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opende-scaffold-"));
    // scaffold requires a dbt_project.yml to be present (resolveConfig uses it)
    // but claudeAdapter.scaffold doesn't check for it — it just writes files
    claudeAdapter.scaffold(makeCtx(tmpDir));
  });

  test.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates .mcp.json with 'opende' server key", () => {
    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf8"));
    assert.ok(mcpJson.mcpServers?.opende, ".mcp.json should have mcpServers.opende");
    assert.equal(mcpJson.mcpServers.opende.command, "node");
    assert.ok(mcpJson.mcpServers.opende.args.includes(path.join(OPENDE_ROOT, "src/mcp.js")));
  });

  test(".mcp.json includes ALTIMATE_DBT_PROJECT_DIR env pointing to projectDir", () => {
    const mcpJson = JSON.parse(fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf8"));
    assert.equal(mcpJson.mcpServers.opende.env.ALTIMATE_DBT_PROJECT_DIR, tmpDir);
  });

  test("creates .claude/settings.json with 'opende' in enabledMcpjsonServers", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.enabledMcpjsonServers.includes("opende"));
  });

  test("creates PostToolUse gate hook in .claude/settings.json", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf8"));
    const hooks = settings.hooks?.PostToolUse || [];
    const hookStr = JSON.stringify(hooks);
    assert.ok(hookStr.includes("gate.js") || hookStr.includes("opende-gate"), "gate hook not found in PostToolUse");
  });

  test("does not create or modify AGENTS.md", () => {
    assert.ok(!fs.existsSync(path.join(tmpDir, "AGENTS.md")), "scaffold should not create AGENTS.md");
  });

  test("creates .claude/agents/ directory with agent markdown files", () => {
    const agentsDir = path.join(tmpDir, ".claude", "agents");
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith(".md"));
    assert.ok(files.length >= 4, `expected at least 4 agent files, got: ${files.join(", ")}`);
  });

  test("creates .claude/skills/ with skill directories", () => {
    const skillsDir = path.join(tmpDir, ".claude", "skills");
    assert.ok(fs.existsSync(skillsDir));
    const entries = fs.readdirSync(skillsDir);
    assert.ok(entries.length > 0, "expected skill files to be copied");
  });

  test("creates .altimate/review.yml sample file", () => {
    assert.ok(fs.existsSync(path.join(tmpDir, ".altimate", "review.yml")));
  });

  describe("idempotency", () => {
    test("running scaffold twice does not create duplicate gate hooks", () => {
      const ctx = makeCtx(tmpDir);
      claudeAdapter.scaffold(ctx); // third run
      const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf8"));
      const hooks = JSON.stringify(settings.hooks?.PostToolUse || []);
      const gateCount = (hooks.match(/gate\.js/g) || []).length;
      assert.ok(gateCount <= 1, `expected at most 1 gate hook, found ${gateCount}`);
    });

    test("does not overwrite existing .altimate/review.yml on second run", () => {
      const reviewPath = path.join(tmpDir, ".altimate", "review.yml");
      const before = fs.readFileSync(reviewPath, "utf8");
      fs.writeFileSync(reviewPath, "mode: gate\n# custom rubric\n");
      claudeAdapter.scaffold(makeCtx(tmpDir));
      const after = fs.readFileSync(reviewPath, "utf8");
      assert.equal(after, "mode: gate\n# custom rubric\n", "review.yml was overwritten — should be preserved");
      // restore
      fs.writeFileSync(reviewPath, before);
    });
  });

  test("includes the gate bin path in the PostToolUse hook command", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude", "settings.json"), "utf8"));
    const hookCmd = JSON.stringify(settings.hooks?.PostToolUse || []);
    assert.ok(hookCmd.includes("gate.js"), `gate.js not referenced in hook command: ${hookCmd}`);
  });

  test("signing key is included in mcp.json env when provided", () => {
    const signedDir = fs.mkdtempSync(path.join(os.tmpdir(), "opende-signed-"));
    try {
      const ctx = { ...makeCtx(signedDir), signingKey: "my-secret-key" };
      claudeAdapter.scaffold(ctx);
      const mcp = JSON.parse(fs.readFileSync(path.join(signedDir, ".mcp.json"), "utf8"));
      assert.equal(mcp.mcpServers.opende.env.ALTIMATE_REVIEW_SIGNING_KEY, "my-secret-key");
    } finally {
      fs.rmSync(signedDir, { recursive: true, force: true });
    }
  });
});
