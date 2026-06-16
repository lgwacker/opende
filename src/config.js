// Central configuration resolution — the one place that decides where the dbt
// project, its artifacts, the dbt runner, the cache, the engine, and the review
// signing key come from. Resolution order: explicit flag → env var → auto-detect
// (walk up for dbt_project.yml) → cwd. No module computes these paths on its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** Walk up from `start` to the nearest directory containing dbt_project.yml. */
export function findProjectDir(start) {
  let cur = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(cur, "dbt_project.yml"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Resolve a frozen config object.
 * @param {{cwd?:string, flags?:object, env?:object}} opts
 *   flags: { projectDir, targetDir, compiledDir, catalog, manifest, dbtCmd }
 */
export function resolveConfig({ cwd = process.cwd(), flags = {}, env = process.env } = {}) {
  const projectDir =
    flags.projectDir || env.ALTIMATE_DBT_PROJECT_DIR || findProjectDir(cwd) || cwd;
  const targetDir = flags.targetDir || env.ALTIMATE_TARGET_DIR || path.join(projectDir, "target");
  const cacheBase =
    env.ALTIMATE_CACHE_DIR ||
    path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opende");
  const projHash = crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 12);
  return Object.freeze({
    projectDir,
    targetDir,
    compiledDir: flags.compiledDir || env.ALTIMATE_COMPILED_DIR || path.join(targetDir, "compiled"),
    catalogPath: flags.catalog || env.ALTIMATE_CATALOG_PATH || path.join(targetDir, "catalog.json"),
    manifestPath: flags.manifest || env.ALTIMATE_MANIFEST_PATH || path.join(targetDir, "manifest.json"),
    dbtCmd: flags.dbtCmd || env.DBT_RUNNER_CMD || "dbt",
    cacheDir: path.join(cacheBase, projHash),
    corePath: env.ALTIMATE_CORE_PATH || null,
    reviewSigningKey: env.ALTIMATE_REVIEW_SIGNING_KEY || null,
  });
}

/** Minimal `--flag value` / `--flag=value` parser for the CLIs. */
export function parseFlags(argv) {
  const f = {};
  const map = {
    "--project-dir": "projectDir", "--target-dir": "targetDir", "--compiled-dir": "compiledDir",
    "--catalog": "catalog", "--manifest": "manifest", "--dbt-cmd": "dbtCmd",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    if (eq > 0 && map[a.slice(0, eq)]) { f[map[a.slice(0, eq)]] = a.slice(eq + 1); continue; }
    if (map[a]) { f[map[a]] = argv[++i]; }
  }
  return f;
}
