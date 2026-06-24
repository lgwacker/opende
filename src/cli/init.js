#!/usr/bin/env node
// opende init — scaffold the deterministic tooling into a target project.
// Interactive by default: detects warehouse env vars from profiles.yml and
// prompts for values to inject into .mcp.json. Pass --yes for non-interactive.
//
//   npx opende init                                  # interactive wizard
//   npx opende init --yes --project-dir . \          # non-interactive (CI)
//     --dbt-cmd ./scripts/run_dbt.sh
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getAdapter } from "./adapters/index.js";

export const flag = (argv, name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
export const has = (argv, name) => argv.includes(`--${name}`);

// Pure key-chunk handler for raw-mode hidden input — returns { val, done, abort }.
// chunk may be a Buffer (TTY) or a string (tests/pipe). Exported for testing.
export function applyKeyChunk(chunk, val) {
  const code = Buffer.isBuffer(chunk) ? chunk[0] : chunk.charCodeAt(0);
  if (code === 3)              return { val, done: false, abort: true };
  if (code === 13 || code === 10) return { val, done: true,  abort: false };
  if (code === 127 || code === 8) return { val: val.slice(0, -1), done: false, abort: false };
  const ch = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  return { val: val + ch, done: false, abort: false };
}

// Find env_var('NAME') references in profiles.yml (project dir first, then ~/.dbt/).
export function detectProfileEnvVars(projectDir) {
  const candidates = [
    path.join(projectDir, "profiles.yml"),
    path.join(os.homedir(), ".dbt", "profiles.yml"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, "utf8");
    const vars = [...content.matchAll(/env_var\(['"]([^'"]+)['"]/g)].map(m => m[1]);
    return { file: p, vars: [...new Set(vars)] };
  }
  return { file: null, vars: [] };
}

async function runWizard(defaults) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (label, def) => new Promise(resolve => {
    const suffix = def ? ` (${def}): ` : ": ";
    rl.question(`  ${label}${suffix}`, ans => resolve(ans.trim() || def || ""));
  });

  // Hidden input for secrets — pauses readline, uses raw stdin, then resumes.
  const askHidden = (label) => {
    if (!process.stdin.isTTY) return ask(label, "");
    rl.pause();
    return new Promise(resolve => {
      process.stdout.write(`  ${label}: `);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let val = "";
      const onData = (chunk) => {
        const { val: next, done, abort } = applyKeyChunk(chunk, val);
        if (abort) { process.stdout.write("\n"); process.exit(1); }
        if (done) {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          rl.resume();
          resolve(val);
          return;
        }
        const erased = next.length < val.length;
        val = next;
        if (erased) process.stdout.write("\b \b");
        else        process.stdout.write("*");
      };
      process.stdin.on("data", onData);
    });
  };

  process.stdout.write("\nopende — interactive setup\n\n");

  const projectDir = path.resolve(await ask("dbt project directory", defaults.projectDir));
  const dbtCmd    = await ask("dbt command", defaults.dbtCmd);
  // Signing key is a secret — never show its value in the prompt.
  const signingKey = await (async () => {
    if (defaults.signingKey) {
      const hint = "*".repeat(Math.min(defaults.signingKey.length, 8));
      const entered = await askHidden(`PR review signing key [${hint}, Enter to keep]`);
      return entered || defaults.signingKey;
    }
    return askHidden("PR review signing key (optional, Enter to skip)");
  })();

  // Detect and prompt for warehouse credentials from profiles.yml.
  const { file: profileFile, vars: envVarNames } = detectProfileEnvVars(projectDir);
  const extraEnv = {};

  if (envVarNames.length > 0) {
    const rel = path.relative(process.cwd(), profileFile);
    process.stdout.write(`\n  Found ${envVarNames.length} env var(s) referenced in ${rel}.\n`);
    process.stdout.write("  Provide values to inject into .mcp.json (the MCP server process\n");
    process.stdout.write("  does not inherit your shell env — it needs them explicitly).\n\n");
    for (const name of envVarNames) {
      const current = process.env[name];
      const isSecret = /password|secret|token|private_key(?!_path)/i.test(name);
      let val;
      if (current && isSecret) {
        // Never show actual secret value in prompt — show masked hint, use hidden input.
        const hint = "*".repeat(Math.min(current.length, 8));
        const entered = await askHidden(`${name} [${hint}, Enter to keep]`);
        val = entered || current;
      } else if (current) {
        val = await ask(`${name} [env: ${current}, Enter to use]`, current);
      } else if (isSecret) {
        val = await askHidden(name);
      } else {
        val = await ask(name, "");
      }
      if (val) extraEnv[name] = val;
    }
  } else if (!profileFile) {
    process.stdout.write("\n  No profiles.yml found — warehouse credentials not configured.\n");
    process.stdout.write("  Add them manually to .mcp.json after init if needed.\n");
  }

  rl.close();
  return { projectDir, dbtCmd, signingKey: signingKey || null, extraEnv };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== "init") {
    process.stderr.write("usage: opende init [--yes] [--harness claude] [--project-dir <dir>] [--dbt-cmd <cmd>] [--signing-key <k>] [--force]\n");
    return cmd === "--help" || cmd === "-h" ? 0 : 1;
  }

  const harness = flag(argv, "harness", "claude");
  const force   = has(argv, "force");
  const yes     = has(argv, "yes");

  let projectDir, dbtCmd, signingKey, extraEnv;

  if (yes) {
    projectDir = path.resolve(flag(argv, "project-dir", process.cwd()));
    dbtCmd     = flag(argv, "dbt-cmd", "dbt");
    signingKey = flag(argv, "signing-key", "") || null;
    extraEnv   = {};
  } else {
    ({ projectDir, dbtCmd, signingKey, extraEnv } = await runWizard({
      projectDir: flag(argv, "project-dir", "."),
      dbtCmd:     flag(argv, "dbt-cmd", "dbt"),
      signingKey: flag(argv, "signing-key", ""),
    }));
  }

  if (!fs.existsSync(path.join(projectDir, "dbt_project.yml"))) {
    process.stderr.write(`! Warning: no dbt_project.yml in ${projectDir} — is this the dbt project root? Continuing.\n`);
  }

  const here   = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.resolve(here, "..");
  const pkgRoot = path.resolve(here, "..", "..");
  const bins = {
    mcp:    path.join(srcDir, "mcp.js"),
    gate:   path.join(srcDir, "gate.js"),
    review: path.join(srcDir, "pr_review.js"),
  };

  const adapter = getAdapter(harness);
  const log = (m) => process.stdout.write(m + "\n");
  log(`\nopende → ${harness} | project: ${projectDir} | dbt: ${dbtCmd}`);
  adapter.scaffold({ projectDir, pkgRoot, srcDir, bins, dbtCmd, signingKey, extraEnv, force, log });
  log("Done. Restart Claude Code (or reload MCP/agents) to pick up the new config.");

  if (Object.keys(extraEnv).length > 0) {
    log("\n⚠  .mcp.json contains credentials — ensure it is in .gitignore.");
  }

  return 0;
}

// Only run when invoked directly — not when imported by tests.
// Resolve symlinks so npx/.bin/ symlinks match the real file path.
if (process.argv[1]) {
  try {
    const entry = fs.realpathSync(process.argv[1]);
    const self  = fs.realpathSync(fileURLToPath(import.meta.url));
    if (entry === self) {
      main().then(code => process.exit(code)).catch(e => {
        process.stderr.write(String(e?.stack || e) + "\n");
        process.exit(1);
      });
    }
  } catch { /* process.argv[1] unresolvable — not our entry point */ }
}
