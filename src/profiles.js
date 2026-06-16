// Resolves Snowflake connection config from the dbt project's profiles.yml —
// the same source altimate-code's native driver layer uses. Handles dbt
// `{{ env_var('NAME'[, 'default']) }}` interpolation and both password and
// key-pair auth. Never logs secret values.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { findProjectDir } from "./schema.js";

const ENV_VAR_RE = /\{\{\s*env_var\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?\)\s*\}\}/g;

function resolveEnvVars(val, missing) {
  if (typeof val === "string") {
    return val.replace(ENV_VAR_RE, (_, name, dflt) => {
      const v = process.env[name];
      if (v !== undefined) return v;
      if (dflt !== undefined) return dflt;
      missing.push(name);
      return "";
    });
  }
  if (Array.isArray(val)) return val.map((v) => resolveEnvVars(v, missing));
  if (val && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = resolveEnvVars(v, missing);
    return out;
  }
  return val;
}

function profilesPath(projectDir) {
  return [
    process.env.DBT_PROFILES_DIR && path.join(process.env.DBT_PROFILES_DIR, "profiles.yml"),
    projectDir && path.join(projectDir, "profiles.yml"),
    path.join(os.homedir(), ".dbt", "profiles.yml"),
  ].filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

/** Load and resolve the active target's raw config. Throws on missing project/profile/target. */
export function loadProfile({ projectDir, target } = {}) {
  projectDir = projectDir || findProjectDir(process.cwd());
  if (!projectDir) throw new Error("dbt project not found (no dbt_project.yml).");
  const profileName = yaml.load(fs.readFileSync(path.join(projectDir, "dbt_project.yml"), "utf8"))?.profile;
  const pf = profilesPath(projectDir);
  if (!pf) throw new Error("profiles.yml not found (looked in DBT_PROFILES_DIR, project dir, ~/.dbt).");
  const profiles = yaml.load(fs.readFileSync(pf, "utf8")) || {};
  const prof = profiles[profileName];
  if (!prof) throw new Error(`profile '${profileName}' not in ${pf}.`);
  const tgt = target || process.env.DBT_TARGET || prof.target || "default";
  const rawTarget = prof.outputs?.[tgt];
  if (!rawTarget) throw new Error(`target '${tgt}' not found in profile '${profileName}'.`);
  const missing = [];
  const o = resolveEnvVars(rawTarget, missing);
  if (String(o.type || "").toLowerCase() !== "snowflake") {
    throw new Error(`opende warehouse layer supports Snowflake only; target '${tgt}' is type '${o.type}'.`);
  }
  return { profileName, target: tgt, config: o, missingEnvVars: [...new Set(missing)], profilesPath: pf };
}

/** Build snowflake-sdk connection options from a resolved dbt target config. */
export function snowflakeConnectionOptions(o) {
  const opts = {
    account: o.account,
    username: o.user,
    role: o.role,
    warehouse: o.warehouse,
    database: o.database,
    schema: o.schema,
    application: "opende",
  };
  if (o.authenticator) opts.authenticator = o.authenticator;
  if (o.private_key_path) {
    // key-pair auth (e.g. the `prod` target)
    opts.authenticator = "SNOWFLAKE_JWT";
    opts.privateKey = fs.readFileSync(o.private_key_path, "utf8");
    if (o.private_key_passphrase) opts.privateKeyPass = o.private_key_passphrase;
  } else if (o.password) {
    opts.password = o.password;
  }
  return opts;
}

/** Non-secret summary of available targets for warehouse_list. */
export function listTargets({ projectDir } = {}) {
  projectDir = projectDir || findProjectDir(process.cwd());
  const profileName = yaml.load(fs.readFileSync(path.join(projectDir, "dbt_project.yml"), "utf8"))?.profile;
  const pf = profilesPath(projectDir);
  const prof = (yaml.load(fs.readFileSync(pf, "utf8")) || {})[profileName] || {};
  return {
    profile: profileName,
    default_target: prof.target,
    targets: Object.entries(prof.outputs || {}).map(([name, o]) => ({
      name,
      type: o.type,
      auth: o.private_key_path ? "key-pair" : o.authenticator || "password",
      database: o.database,
      // values left unresolved here to avoid surfacing secrets
    })),
  };
}
