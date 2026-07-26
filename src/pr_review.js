#!/usr/bin/env node
// Deterministic dbt PR review CLI (sibling to gate.js). Drives the same
// reviewPullRequest engine as the `dbt_pr_review` MCP tool, so the two can never
// diverge. NO `altimate` binary, NO LLM — Claude Code is the only model.
//
//   node pr_review.js                         # review working tree vs origin/main (comment mode)
//   node pr_review.js --base origin/main --head HEAD
//   node pr_review.js --mode gate             # exit 1 on REQUEST_CHANGES (for a manual gate)
//   node pr_review.js --json                  # print the raw signed verdict envelope
//   node pr_review.js --explain-tier          # also print why this tier was assigned
//   node pr_review.js --force-tier full       # report `full` regardless of the signals
//                                             (label only — every lane always runs)
//   node pr_review.js --project-dir <dir>     # else auto-detected / $ALTIMATE_DBT_PROJECT_DIR
//
// Reads .altimate/review.yml for the per-repo rubric + mode. Exit codes:
//   0  APPROVE / COMMENT   (or any verdict in comment mode)
//   1  REQUEST_CHANGES     (only in --mode gate)
import { reviewPullRequest, TIERS } from "./review/run.js";
import { renderSummary, renderTierExplanation } from "./review/format.js";
import { resolveConfig, parseFlags } from "./config.js";

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = resolveConfig({ flags: parseFlags(argv) });
  const base = arg(argv, "base");
  const head = arg(argv, "head");
  const mode = arg(argv, "mode"); // comment | gate (overrides .altimate/review.yml)
  const asJson = argv.includes("--json");
  const explainTier = argv.includes("--explain-tier");
  const forceTier = arg(argv, "force-tier");

  // Validated here (not just in the engine) so a typo fails before any git or
  // engine work, the way --fail-on does in gate.js.
  if (forceTier !== undefined && !TIERS.includes(forceTier)) {
    process.stderr.write(`opende review: invalid --force-tier '${forceTier}' (expected ${TIERS.join("|")})\n`);
    return 1;
  }

  const env = await reviewPullRequest({
    cwd: cfg.projectDir,
    base,
    head,
    manifestPath: cfg.manifestPath,
    compiledDir: cfg.compiledDir,
    dbtCmd: cfg.dbtCmd,
    mode,
    forceTier,
    generatedAt: new Date().toISOString(),
  });

  if (asJson) {
    console.log(JSON.stringify(env, null, 2));
  } else {
    console.log(renderSummary(env));
    if (explainTier) console.log("\n" + renderTierExplanation(env));
  }

  // Only a gate-mode REQUEST_CHANGES fails the process; comment mode never blocks.
  return env.verdict === "REQUEST_CHANGES" ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(String(e?.stack || e) + "\n");
    process.exit(1);
  });
