#!/usr/bin/env node
// opende init — scaffold the deterministic tooling into a target
// project for a given harness. Resolves the installed package's bins to absolute
// paths (so a git-installed package works regardless of the MCP launcher's cwd).
//
//   npx opende init --harness claude --project-dir .
//     [--dbt-cmd "./scripts/run_dbt.sh"] [--signing-key <key>] [--force]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "./adapters/index.js";

const flag = (argv, name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const has = (argv, name) => argv.includes(`--${name}`);

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== "init") {
    process.stderr.write("usage: opende init --harness <claude> --project-dir <dir> [--dbt-cmd <cmd>] [--signing-key <k>] [--force]\n");
    return cmd === "--help" || cmd === "-h" ? 0 : 1;
  }

  const harness = flag(argv, "harness", "claude");
  const projectDir = path.resolve(flag(argv, "project-dir", process.cwd()));
  const dbtCmd = flag(argv, "dbt-cmd", "dbt");
  const signingKey = flag(argv, "signing-key", "");
  const force = has(argv, "force");

  if (!fs.existsSync(path.join(projectDir, "dbt_project.yml"))) {
    process.stderr.write(`! Warning: no dbt_project.yml in ${projectDir} — is this the dbt project root? Continuing.\n`);
  }

  // Resolve this package's bins to absolute paths (init.js is at <pkg>/src/cli/init.js).
  const here = path.dirname(fileURLToPath(import.meta.url));        // <pkg>/src/cli
  const srcDir = path.resolve(here, "..");                          // <pkg>/src
  const pkgRoot = path.resolve(here, "..", "..");                   // <pkg>
  const bins = {
    mcp: path.join(srcDir, "mcp.js"),
    gate: path.join(srcDir, "gate.js"),
    review: path.join(srcDir, "pr_review.js"),
  };

  const adapter = getAdapter(harness);
  const log = (m) => process.stdout.write(m + "\n");
  log(`opende → ${harness} | project: ${projectDir} | dbt: ${dbtCmd}`);
  adapter.scaffold({ projectDir, pkgRoot, srcDir, bins, dbtCmd, signingKey, force, log });
  log("Done. Restart the harness (or reload MCP/agents) to pick up the new config.");
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  process.stderr.write(String(e?.stack || e) + "\n");
  process.exit(1);
}
