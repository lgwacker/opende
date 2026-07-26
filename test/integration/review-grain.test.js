// The grain lane end-to-end: real `extractGrain` from altimate-core, driven
// through reviewPullRequest over a throwaway git repo. The pure comparison logic
// is covered in test/unit/grain.test.js.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewPullRequest } from "../../src/review/run.js";
import { call } from "../../src/core.js";

let repo;

const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

/** Write a model + optional schema.yml, then review the working tree against the base commit. */
function reviewWith({ sql, yaml, manifest, name = "fct_orders" }) {
  const modelsDir = path.join(repo, "models");
  fs.rmSync(modelsDir, { recursive: true, force: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(modelsDir, `${name}.sql`), sql);
  if (yaml) fs.writeFileSync(path.join(modelsDir, "schema.yml"), yaml);

  const target = path.join(repo, "target");
  fs.rmSync(target, { recursive: true, force: true });
  if (manifest) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest));
  }
  return reviewPullRequest({ cwd: repo, base: "HEAD", generatedAt: "2026-01-01T00:00:00Z" });
}

// Findings are id-fingerprinted, not ruleKey-tagged, so match on the lane's titles.
const grainFindings = (env) => env.findings.filter((f) => f.category === "test_coverage" && /grain key/i.test(f.title));

const manifestFor = (model, notNullColumns) => ({
  metadata: { adapter_type: "snowflake" },
  nodes: {
    [`model.tp.${model}`]: { resource_type: "model", name: model, columns: {}, depends_on: { nodes: [] } },
    ...Object.fromEntries(
      notNullColumns.map((c) => [
        `test.tp.not_null_${model}_${c}`,
        {
          resource_type: "test",
          name: `not_null_${model}_${c}`,
          test_metadata: { name: "not_null", kwargs: { column_name: c } },
          column_name: c,
          attached_node: `model.tp.${model}`,
          depends_on: { nodes: [`model.tp.${model}`] },
        },
      ]),
    ),
  },
  child_map: { [`model.tp.${model}`]: [] },
});

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "opende-grain-"));
  fs.writeFileSync(path.join(repo, "dbt_project.yml"), "name: tp\nversion: '1.0'\n");
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "base");
});

after(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("extractGrain (real engine)", () => {
  test("returns the final-SELECT GROUP BY columns", async () => {
    const g = JSON.parse(await call("extractGrain", ["select customer_id, count(*) n from orders group by customer_id"]));
    assert.deepEqual(g.group_by, ["customer_id"]);
  });
});

describe("grain lane", () => {
  const GROUPED = "select customer_id, count(*) as n from orders group by customer_id\n";

  test("warns once, naming the column, when a grain key has no not_null test", async () => {
    const env = await reviewWith({ sql: GROUPED, manifest: manifestFor("fct_orders", []) });
    const found = grainFindings(env);
    assert.equal(found.length, 1, JSON.stringify(env.findings, null, 1));
    assert.equal(found[0].severity, "warning");
    assert.equal(found[0].category, "test_coverage");
    assert.equal(found[0].column, "customer_id");
  });

  test("reports nothing when the grain key carries not_null", async () => {
    const env = await reviewWith({ sql: GROUPED, manifest: manifestFor("fct_orders", ["customer_id"]) });
    assert.deepEqual(grainFindings(env), []);
  });

  test("reports nothing for a model with no GROUP BY or PARTITION BY", async () => {
    const env = await reviewWith({ sql: "select order_id from orders\n", manifest: manifestFor("fct_orders", []) });
    assert.deepEqual(grainFindings(env), []);
  });

  test("degrades silently on raw Jinja head SQL with no compiled artifact", async () => {
    const env = await reviewWith({
      sql: "select customer_id, count(*) n from {{ ref('stg_orders') }} group by customer_id\n",
      manifest: manifestFor("fct_orders", []),
    });
    assert.deepEqual(grainFindings(env), []);
  });

  test("falls back to schema.yml when there is no manifest", async () => {
    const yaml = "version: 2\nmodels:\n  - name: fct_orders\n    columns:\n      - name: customer_id\n        tests: [not_null]\n";
    const guarded = await reviewWith({ sql: GROUPED, yaml });
    assert.deepEqual(grainFindings(guarded), []);

    const unguarded = await reviewWith({
      sql: GROUPED,
      yaml: "version: 2\nmodels:\n  - name: fct_orders\n    columns:\n      - name: customer_id\n        tests: [unique]\n",
    });
    assert.equal(grainFindings(unguarded).length, 1);
  });

  test("stays silent when neither the manifest nor a schema.yml declares the model", async () => {
    const env = await reviewWith({ sql: GROUPED });
    assert.deepEqual(grainFindings(env), []);
  });

  test("a wide unguarded grain rolls up to one warning, so it cannot block on its own", async () => {
    const env = await reviewWith({
      sql: "select a, b, c, d, count(*) n from orders group by a, b, c, d\n",
      manifest: manifestFor("fct_orders", []),
    });
    const found = grainFindings(env);
    assert.equal(found.length, 1);
    for (const c of ["a", "b", "c", "d"]) assert.ok(found[0].title.includes(c), `missing ${c}`);
  });
});

describe("tier signals", () => {
  test("records the three signals and what decided the tier", async () => {
    const env = await reviewWith({ sql: "select 1 as a\n", manifest: manifestFor("fct_orders", []) });
    assert.equal(typeof env.tierSignals.totalSqlLines, "number");
    assert.equal(env.tierSignals.maxBlast, 0);
    assert.equal(env.tierSignals.metadataRisk, false);
    assert.ok(env.tierSignals.reason);
    assert.equal(env.tierSignals.computedTier, env.tier);
    assert.equal(env.tierSignals.forced, undefined);
  });

  test("forceTier overrides the reported tier and marks it forced", async () => {
    fs.writeFileSync(path.join(repo, "models", "fct_orders.sql"), "select 1 as a\n");
    const env = await reviewPullRequest({ cwd: repo, base: "HEAD", forceTier: "full", generatedAt: "2026-01-01T00:00:00Z" });
    assert.equal(env.tier, "full");
    assert.equal(env.tierSignals.forced, true);
    assert.notEqual(env.tierSignals.computedTier, "full");
  });

  test("an invalid forceTier is rejected", async () => {
    await assert.rejects(() => reviewPullRequest({ cwd: repo, base: "HEAD", forceTier: "enormous" }), /invalid tier/);
  });
});

// The CLI surface for the tier flags, spawned as a subprocess (exit codes matter).
describe("pr_review.js tier flags", () => {
  // fileURLToPath, not import.meta.dirname — the latter is Node 20.11+ and CI runs 18.
  const BIN = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "src/pr_review.js");
  const run = (...args) =>
    execFileSync("node", [BIN, "--project-dir", repo, "--base", "HEAD", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  test("--explain-tier prints the signals and the deciding threshold", () => {
    const out = run("--explain-tier");
    assert.match(out, /changed SQL lines/);
    assert.match(out, /max blast radius/);
    assert.match(out, /decided by/);
  });

  test("--force-tier full reports full and labels it forced", () => {
    const out = run("--force-tier", "full", "--explain-tier");
    assert.match(out, /full tier, forced/);
    assert.match(out, /FORCED/);
  });

  test("an invalid --force-tier exits non-zero naming the valid values", () => {
    const r = spawnSync("node", [BIN, "--project-dir", repo, "--force-tier", "enormous"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /trivial\|lite\|full/);
  });
});
