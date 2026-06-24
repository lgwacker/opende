// E2E tests for opende init — spawns the real CLI and asserts on file system state.
// Uses --yes (non-interactive) so no TTY is required. The interactive wizard's
// key-handling logic is covered separately in test/unit/init.test.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OPENDE_ROOT = path.resolve(__dirname, "../..");
const INIT_BIN = path.join(OPENDE_ROOT, "src/cli/init.js");

function runInit(args, opts = {}) {
  return spawnSync("node", [INIT_BIN, "init", "--yes", ...args], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, ...opts.env },
    cwd: OPENDE_ROOT,
  });
}

function scaffold(dir, extraArgs = []) {
  const result = runInit(["--project-dir", dir, ...extraArgs]);
  assert.equal(result.status, 0, `init failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opende-e2e-"));
}

// ── exit codes ───────────────────────────────────────────────────────────────

describe("exit codes", () => {
  test("exits 0 on success", () => {
    const dir = makeTmp();
    try {
      const r = runInit(["--project-dir", dir]);
      assert.equal(r.status, 0, r.stderr);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("exits non-zero when no subcommand given", () => {
    const r = spawnSync("node", [INIT_BIN], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes("usage:"), `stderr: ${r.stderr}`);
  });

  test("exits non-zero for unknown subcommand", () => {
    const r = spawnSync("node", [INIT_BIN, "deploy"], { encoding: "utf8", timeout: 10000 });
    assert.notEqual(r.status, 0);
  });
});

// ── .mcp.json ────────────────────────────────────────────────────────────────

describe(".mcp.json", () => {
  let dir;
  test.before(() => { dir = makeTmp(); scaffold(dir); });
  test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test("is created", () => {
    assert.ok(fs.existsSync(path.join(dir, ".mcp.json")));
  });

  test("has mcpServers.opende key", () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers?.opende, "mcpServers.opende missing");
  });

  test("command is node", () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.opende.command, "node");
  });

  test("args include mcp.js", () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers.opende.args.some(a => a.endsWith("mcp.js")));
  });

  test("ALTIMATE_DBT_PROJECT_DIR points to project dir", () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.opende.env.ALTIMATE_DBT_PROJECT_DIR, dir);
  });

  test("DBT_RUNNER_CMD defaults to 'dbt'", () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.opende.env.DBT_RUNNER_CMD, "dbt");
  });

  test("DBT_RUNNER_CMD reflects --dbt-cmd flag", () => {
    const d = makeTmp();
    try {
      scaffold(d, ["--dbt-cmd", "./scripts/run_dbt.sh"]);
      const mcp = JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8"));
      assert.equal(mcp.mcpServers.opende.env.DBT_RUNNER_CMD, "./scripts/run_dbt.sh");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test("ALTIMATE_REVIEW_SIGNING_KEY absent when --signing-key not passed", () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
    assert.ok(!("ALTIMATE_REVIEW_SIGNING_KEY" in mcp.mcpServers.opende.env));
  });

  test("ALTIMATE_REVIEW_SIGNING_KEY set when --signing-key passed", () => {
    const d = makeTmp();
    try {
      scaffold(d, ["--signing-key", "my-secret-key"]);
      const mcp = JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8"));
      assert.equal(mcp.mcpServers.opende.env.ALTIMATE_REVIEW_SIGNING_KEY, "my-secret-key");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test("existing user credentials survive re-run", () => {
    const d = makeTmp();
    try {
      // First run — write credential manually into .mcp.json
      scaffold(d);
      const file = path.join(d, ".mcp.json");
      const mcp = JSON.parse(fs.readFileSync(file, "utf8"));
      mcp.mcpServers.opende.env.SNOWFLAKE_PASSWORD = "s3cr3t";
      fs.writeFileSync(file, JSON.stringify(mcp, null, 2));
      // Second run
      scaffold(d);
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(after.mcpServers.opende.env.SNOWFLAKE_PASSWORD, "s3cr3t");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test("managed vars are updated on re-run even if credentials are preserved", () => {
    const d = makeTmp();
    try {
      scaffold(d, ["--dbt-cmd", "dbt"]);
      scaffold(d, ["--dbt-cmd", "./scripts/run_dbt.sh"]);
      const mcp = JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8"));
      assert.equal(mcp.mcpServers.opende.env.DBT_RUNNER_CMD, "./scripts/run_dbt.sh");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

// ── .claude/skills/ ───────────────────────────────────────────────────────────

describe(".claude/skills/", () => {
  let dir;
  test.before(() => { dir = makeTmp(); scaffold(dir); });
  test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test("directory is created", () => {
    assert.ok(fs.existsSync(path.join(dir, ".claude", "skills")));
  });

  test("contains at least one skill subdirectory", () => {
    const entries = fs.readdirSync(path.join(dir, ".claude", "skills"), { withFileTypes: true });
    assert.ok(entries.some(e => e.isDirectory()), "expected skill subdirectories");
  });

  test("dbt-develop skill is present", () => {
    assert.ok(fs.existsSync(path.join(dir, ".claude", "skills", "dbt-develop", "SKILL.md")));
  });

  test("skill SKILL.md files have {{RUNNER}} substituted with 'dbt'", () => {
    const skill = fs.readFileSync(
      path.join(dir, ".claude", "skills", "dbt-develop", "SKILL.md"), "utf8"
    );
    assert.ok(!skill.includes("{{RUNNER}}"), "{{RUNNER}} token not substituted");
    assert.ok(skill.includes("dbt "), "expected 'dbt' in substituted skill");
  });

  test("skill SKILL.md reflects custom --dbt-cmd", () => {
    const d = makeTmp();
    try {
      scaffold(d, ["--dbt-cmd", "./scripts/run_dbt.sh"]);
      const skill = fs.readFileSync(
        path.join(d, ".claude", "skills", "dbt-develop", "SKILL.md"), "utf8"
      );
      assert.ok(skill.includes("./scripts/run_dbt.sh"), "custom dbt-cmd not substituted");
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

// ── .claude/agents/ ───────────────────────────────────────────────────────────

describe(".claude/agents/", () => {
  let dir;
  test.before(() => { dir = makeTmp(); scaffold(dir); });
  test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test("directory is created", () => {
    assert.ok(fs.existsSync(path.join(dir, ".claude", "agents")));
  });

  test("all four agent files are written", () => {
    const files = fs.readdirSync(path.join(dir, ".claude", "agents")).filter(f => f.endsWith(".md"));
    const names = files.map(f => f.replace(".md", ""));
    for (const expected of ["opende-builder", "opende-analyst", "opende-plan", "opende-reviewer"]) {
      assert.ok(names.includes(expected), `missing agent: ${expected}`);
    }
  });

  test("agent files contain YAML frontmatter with name field", () => {
    const content = fs.readFileSync(
      path.join(dir, ".claude", "agents", "opende-builder.md"), "utf8"
    );
    assert.ok(content.startsWith("---\n"), "missing frontmatter");
    assert.ok(content.includes("name: opende-builder"));
  });

  test("agent files contain description field", () => {
    const content = fs.readFileSync(
      path.join(dir, ".claude", "agents", "opende-builder.md"), "utf8"
    );
    assert.ok(content.includes("description:"));
  });

  test("no {{RUNNER}} token left unsubstituted in agent files", () => {
    const agentsDir = path.join(dir, ".claude", "agents");
    for (const file of fs.readdirSync(agentsDir).filter(f => f.endsWith(".md"))) {
      const content = fs.readFileSync(path.join(agentsDir, file), "utf8");
      assert.ok(!content.includes("{{RUNNER}}"), `{{RUNNER}} unsubstituted in ${file}`);
    }
  });

  test("AGENTS.md is not created", () => {
    assert.ok(!fs.existsSync(path.join(dir, "AGENTS.md")));
  });
});

// ── .claude/settings.json ────────────────────────────────────────────────────

describe(".claude/settings.json", () => {
  let dir;
  test.before(() => { dir = makeTmp(); scaffold(dir); });
  test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test("is created", () => {
    assert.ok(fs.existsSync(path.join(dir, ".claude", "settings.json")));
  });

  test("enabledMcpjsonServers includes 'opende'", () => {
    const s = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    assert.ok(s.enabledMcpjsonServers?.includes("opende"));
  });

  test("PostToolUse hook references gate.js", () => {
    const s = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    const hooks = JSON.stringify(s.hooks?.PostToolUse || []);
    assert.ok(hooks.includes("gate.js"), `gate.js not in PostToolUse: ${hooks}`);
  });

  test("PostToolUse hook has Write|Edit matcher", () => {
    const s = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    const hooks = JSON.stringify(s.hooks?.PostToolUse || []);
    assert.ok(hooks.includes("Write") && hooks.includes("Edit"));
  });

  test("re-run does not duplicate the gate hook", () => {
    scaffold(dir);
    const s = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    const count = (JSON.stringify(s.hooks?.PostToolUse || []).match(/gate\.js/g) || []).length;
    assert.ok(count <= 1, `gate hook duplicated: found ${count}`);
  });

  test("re-run does not duplicate 'opende' in enabledMcpjsonServers", () => {
    scaffold(dir);
    const s = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    const count = s.enabledMcpjsonServers.filter(x => x === "opende").length;
    assert.equal(count, 1, `'opende' appears ${count} times`);
  });
});

// ── .altimate/review.yml ──────────────────────────────────────────────────────

describe(".altimate/review.yml", () => {
  let dir;
  test.before(() => { dir = makeTmp(); scaffold(dir); });
  test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test("is created on first run", () => {
    assert.ok(fs.existsSync(path.join(dir, ".altimate", "review.yml")));
  });

  test("is not overwritten on re-run", () => {
    const file = path.join(dir, ".altimate", "review.yml");
    fs.writeFileSync(file, "mode: gate\n# custom rubric\n");
    scaffold(dir);
    assert.equal(fs.readFileSync(file, "utf8"), "mode: gate\n# custom rubric\n");
  });
});

// ── stdout output ─────────────────────────────────────────────────────────────

describe("stdout", () => {
  test("prints summary line with project path and dbt cmd", () => {
    const dir = makeTmp();
    try {
      const r = scaffold(dir);
      assert.ok(r.stdout.includes("opende →"), `stdout: ${r.stdout}`);
      assert.ok(r.stdout.includes(dir), `project dir missing from stdout: ${r.stdout}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("prints 'Done.' on success", () => {
    const dir = makeTmp();
    try {
      const r = scaffold(dir);
      assert.ok(r.stdout.includes("Done."), `stdout: ${r.stdout}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("warns when dbt_project.yml is absent", () => {
    const dir = makeTmp();
    try {
      const r = runInit(["--project-dir", dir]);
      assert.ok(r.stderr.includes("Warning") || r.stdout.includes("Warning"),
        "expected warning about missing dbt_project.yml");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("no credential warning when no extraEnv in --yes mode", () => {
    const dir = makeTmp();
    try {
      const r = scaffold(dir);
      assert.ok(!r.stdout.includes("⚠"), `unexpected warning: ${r.stdout}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
