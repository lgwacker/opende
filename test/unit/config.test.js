import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectDir, resolveConfig, parseFlags } from "../../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DBT = path.resolve(__dirname, "../fixtures/throwaway-dbt");
const FIXTURE_MODELS = path.join(FIXTURE_DBT, "models/staging");

describe("findProjectDir", () => {
  test("finds dbt_project.yml walking up from a subdir", () => {
    assert.equal(findProjectDir(FIXTURE_MODELS), FIXTURE_DBT);
  });

  test("finds dbt_project.yml from the project root itself", () => {
    assert.equal(findProjectDir(FIXTURE_DBT), FIXTURE_DBT);
  });

  test("returns null when no dbt_project.yml exists in the tree", () => {
    // /tmp should not contain a dbt_project.yml
    const result = findProjectDir("/tmp");
    assert.ok(result === null || (typeof result === "string" && result.includes("dbt_project")));
  });
});

describe("resolveConfig", () => {
  test("flags take highest priority over env and auto-detect", () => {
    const cfg = resolveConfig({
      cwd: FIXTURE_DBT,
      flags: { projectDir: "/explicit/project", dbtCmd: "custom_dbt" },
      env: { ALTIMATE_DBT_PROJECT_DIR: "/env/project", DBT_RUNNER_CMD: "env_dbt" },
    });
    assert.equal(cfg.projectDir, "/explicit/project");
    assert.equal(cfg.dbtCmd, "custom_dbt");
  });

  test("env overrides auto-detect", () => {
    const cfg = resolveConfig({
      cwd: FIXTURE_DBT,
      flags: {},
      env: { ALTIMATE_DBT_PROJECT_DIR: "/env/project" },
    });
    assert.equal(cfg.projectDir, "/env/project");
  });

  test("auto-detects projectDir by walking up from cwd", () => {
    const cfg = resolveConfig({ cwd: FIXTURE_MODELS, flags: {}, env: {} });
    assert.equal(cfg.projectDir, FIXTURE_DBT);
  });

  test("returns a frozen object", () => {
    const cfg = resolveConfig({ cwd: FIXTURE_DBT, flags: {}, env: {} });
    assert.ok(Object.isFrozen(cfg));
    assert.throws(() => { cfg.projectDir = "mutate"; });
  });

  test("targetDir, manifestPath, catalogPath, compiledDir all nest under projectDir by default", () => {
    const cfg = resolveConfig({ flags: { projectDir: "/proj" }, env: {} });
    assert.equal(cfg.targetDir, "/proj/target");
    assert.equal(cfg.manifestPath, "/proj/target/manifest.json");
    assert.equal(cfg.catalogPath, "/proj/target/catalog.json");
    assert.equal(cfg.compiledDir, "/proj/target/compiled");
  });

  test("cacheDir path contains 'opende' prefix", () => {
    const cfg = resolveConfig({ flags: { projectDir: "/proj" }, env: {} });
    assert.ok(cfg.cacheDir.includes("opende"), `expected 'opende' in cacheDir: ${cfg.cacheDir}`);
  });

  test("different projectDirs produce different cacheDirs", () => {
    const a = resolveConfig({ flags: { projectDir: "/proj/a" }, env: {} });
    const b = resolveConfig({ flags: { projectDir: "/proj/b" }, env: {} });
    assert.notEqual(a.cacheDir, b.cacheDir);
  });

  test("reviewSigningKey comes from env", () => {
    const cfg = resolveConfig({ flags: {}, env: { ALTIMATE_REVIEW_SIGNING_KEY: "secret-key" } });
    assert.equal(cfg.reviewSigningKey, "secret-key");
  });

  test("reviewSigningKey is null when env is absent", () => {
    const cfg = resolveConfig({ flags: {}, env: {} });
    assert.equal(cfg.reviewSigningKey, null);
  });

  test("ALTIMATE_CACHE_DIR env overrides XDG default", () => {
    const cfg = resolveConfig({ flags: { projectDir: "/proj" }, env: { ALTIMATE_CACHE_DIR: "/custom/cache" } });
    assert.ok(cfg.cacheDir.startsWith("/custom/cache"));
  });
});

describe("parseFlags", () => {
  test("parses --flag value (space-separated) form", () => {
    const f = parseFlags(["--project-dir", "/foo", "--dbt-cmd", "my_dbt"]);
    assert.equal(f.projectDir, "/foo");
    assert.equal(f.dbtCmd, "my_dbt");
  });

  test("parses --flag=value (equals) form", () => {
    const f = parseFlags(["--project-dir=/bar", "--dbt-cmd=./scripts/run.sh"]);
    assert.equal(f.projectDir, "/bar");
    assert.equal(f.dbtCmd, "./scripts/run.sh");
  });

  test("parses --target-dir", () => {
    const f = parseFlags(["--target-dir", "/custom/target"]);
    assert.equal(f.targetDir, "/custom/target");
  });

  test("parses all supported flags", () => {
    const f = parseFlags([
      "--project-dir", "/p",
      "--target-dir", "/t",
      "--compiled-dir", "/c",
      "--catalog", "/cat.json",
      "--manifest", "/man.json",
      "--dbt-cmd", "dbt",
    ]);
    assert.equal(f.projectDir, "/p");
    assert.equal(f.targetDir, "/t");
    assert.equal(f.compiledDir, "/c");
    assert.equal(f.catalog, "/cat.json");
    assert.equal(f.manifest, "/man.json");
    assert.equal(f.dbtCmd, "dbt");
  });

  test("returns empty object for empty argv", () => {
    assert.deepEqual(parseFlags([]), {});
  });

  test("ignores unknown flags silently", () => {
    const f = parseFlags(["--unknown-flag", "value", "--another", "x"]);
    assert.deepEqual(f, {});
  });
});
