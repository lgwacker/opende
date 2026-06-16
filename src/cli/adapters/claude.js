// Claude Code adapter — scaffolds the portable tooling into a target project.
// Writes/merges idempotently: .mcp.json, .claude/skills/, .claude/agents/,
// the AGENTS.md doctrine block, the PostToolUse gate hook, and a sample
// .altimate/review.yml. Re-running converges (content-hash, sentinel markers,
// de-duped server key + hook).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const TOOLCOUNT = "64";
const DOCTRINE_START = "<!-- opende:doctrine:start -->";
const DOCTRINE_END = "<!-- opende:doctrine:end -->";

// Replace ONLY the uppercase {{TOKEN}}s — never touches dbt's `{{ ref() }}` etc.
function applyTokens(text, tokens) {
  let out = text;
  for (const [k, v] of Object.entries(tokens)) out = out.split(`{{${k}}}`).join(v);
  return out;
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

function writeIfChanged(dest, content, { force }, log, label) {
  const cur = readIf(dest);
  if (cur !== null && sha(cur) === sha(content)) { log(`  = ${label} (unchanged)`); return; }
  if (cur !== null && !force) {
    // identical-intent but differs → overwrite skills/agents we manage; tunable via --force only for safety on conflicts
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  log(`  ${cur === null ? "+" : "~"} ${label}`);
}

export const claudeAdapter = {
  id: "claude",

  scaffold(ctx) {
    const { projectDir, pkgRoot, bins, dbtCmd, signingKey, force, log } = ctx;
    const tokens = {
      RUNNER: dbtCmd,
      TOOLCOUNT,
      GATE_INVOCATION: `node "${bins.gate}"`,
      REVIEW_INVOCATION: `node "${bins.review}"`,
    };
    const assets = path.join(pkgRoot, "assets");

    // 1. .mcp.json — merge server key "opende".
    mergeMcpJson(projectDir, bins.mcp, dbtCmd, signingKey, log);

    // 2. skills → .claude/skills/ (token-substituted).
    copyTree(path.join(assets, "skills"), path.join(projectDir, ".claude", "skills"), tokens, { force }, log, "skill");

    // 3. agents → .claude/agents/<name>.md (frontmatter from manifest + body).
    renderAgents(assets, projectDir, tokens, { force }, log);

    // 4. AGENTS.md doctrine block (sentinel-wrapped, idempotent).
    upsertDoctrine(assets, projectDir, tokens, log);

    // 5. PostToolUse gate hook + enable the MCP server.
    wireGateHook(projectDir, bins.gate, log);

    // 6. sample .altimate/review.yml (only if absent).
    const reviewDst = path.join(projectDir, ".altimate", "review.yml");
    if (!fs.existsSync(reviewDst)) {
      fs.mkdirSync(path.dirname(reviewDst), { recursive: true });
      fs.copyFileSync(path.join(assets, "review.yml"), reviewDst);
      log("  + .altimate/review.yml");
    } else {
      log("  = .altimate/review.yml (kept your rubric)");
    }
  },
};

function copyTree(srcDir, dstDir, tokens, opts, log, label) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(dstDir, entry.name);
    if (entry.isDirectory()) { copyTree(s, d, tokens, opts, log, label); continue; }
    const content = entry.name.endsWith(".md") ? applyTokens(fs.readFileSync(s, "utf8"), tokens) : fs.readFileSync(s);
    const rel = path.relative(path.dirname(dstDir), d);
    writeIfChanged(d, content, opts, log, `${label}: ${rel}`);
  }
}

function renderAgents(assets, projectDir, tokens, opts, log) {
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, "agents", "agents.manifest.json"), "utf8"));
  for (const a of manifest) {
    const body = applyTokens(fs.readFileSync(path.join(assets, "agents", `${a.name}.body.md`), "utf8"), tokens);
    const fm = ["---", `name: ${a.name}`, `description: ${a.description}`];
    if (Array.isArray(a.tools)) fm.push(`tools: ${a.tools.join(", ")}`);
    fm.push("---", "");
    writeIfChanged(path.join(projectDir, ".claude", "agents", `${a.name}.md`), fm.join("\n") + body, opts, log, `agent: ${a.name}`);
  }
}

function upsertDoctrine(assets, projectDir, tokens, log) {
  const section = applyTokens(fs.readFileSync(path.join(assets, "doctrine", "AGENTS.section.md"), "utf8"), tokens).trim();
  const block = `${DOCTRINE_START}\n${section}\n${DOCTRINE_END}`;
  const agentsPath = path.join(projectDir, "AGENTS.md");
  let cur = readIf(agentsPath);
  if (cur === null) {
    fs.writeFileSync(agentsPath, `# AGENTS.md\n\n${block}\n`);
    log("  + AGENTS.md (created with doctrine block)");
    return;
  }
  const re = new RegExp(`${DOCTRINE_START}[\\s\\S]*?${DOCTRINE_END}`);
  if (re.test(cur)) {
    const next = cur.replace(re, block);
    if (sha(next) === sha(cur)) log("  = AGENTS.md doctrine (unchanged)");
    else { fs.writeFileSync(agentsPath, next); log("  ~ AGENTS.md doctrine (updated in place)"); }
  } else {
    fs.writeFileSync(agentsPath, cur.replace(/\s*$/, "") + `\n\n${block}\n`);
    log("  ~ AGENTS.md (appended doctrine block)");
  }
}

function mergeJsonFile(file, mutate) {
  let obj = {};
  const cur = readIf(file);
  if (cur !== null) { try { obj = JSON.parse(cur); } catch { /* keep {} */ } }
  mutate(obj);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function mergeMcpJson(projectDir, mcpBin, dbtCmd, signingKey, log) {
  const file = path.join(projectDir, ".mcp.json");
  const env = { ALTIMATE_DBT_PROJECT_DIR: projectDir, DBT_RUNNER_CMD: dbtCmd };
  if (signingKey) env.ALTIMATE_REVIEW_SIGNING_KEY = signingKey;
  mergeJsonFile(file, (o) => {
    o.mcpServers = o.mcpServers || {};
    o.mcpServers.opende = { command: "node", args: [mcpBin, "--project-dir", projectDir], env };
  });
  log("  ~ .mcp.json (server 'opende')");
}

function wireGateHook(projectDir, gateBin, log) {
  const file = path.join(projectDir, ".claude", "settings.json");
  const cmd = `node "${gateBin}" --hook --project-dir "${projectDir}"`;
  mergeJsonFile(file, (o) => {
    o.enabledMcpjsonServers = Array.from(new Set([...(o.enabledMcpjsonServers || []), "opende"]));
    o.hooks = o.hooks || {};
    o.hooks.PostToolUse = o.hooks.PostToolUse || [];
    // de-dupe by the gate-bin substring so re-runs don't stack hooks.
    const already = JSON.stringify(o.hooks.PostToolUse).includes("opende-gate") ||
      JSON.stringify(o.hooks.PostToolUse).includes("/src/gate.js");
    if (!already) {
      o.hooks.PostToolUse.push({
        matcher: "Write|Edit",
        hooks: [{ type: "command", command: cmd, statusMessage: "Running opende SQL gate" }],
      });
    }
  });
  log("  ~ .claude/settings.json (gate hook + enabled 'opende')");
}
