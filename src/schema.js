// Schema resolver — the one job `altimate check` used to do for us. Builds an
// altimate-core `Schema` from the dbt project so the schema-aware engine
// functions (lint, checkSemantics, classifyPii, analyzeMigration, generateTests,
// checkEquivalence, …) run with real table/column context.
//
// Resolution order: explicit JSON/YAML > dbt target/catalog.json (real warehouse
// types) > dbt target/manifest.json (names only) > empty Schema (functions still
// run, they just can't resolve refs). Results are cached by file mtime so the
// gate stays fast on every edit.
import fs from "node:fs";
import path from "node:path";
import { loadCore } from "./core.js";
import { findProjectDir } from "./config.js";

const DEFAULT_DIALECT = "snowflake";
const _cache = new Map(); // key: `${path}:${mtimeMs}` -> Schema

// Re-exported for back-compat; the canonical implementation lives in config.js.
export { findProjectDir };

function emptySchema(dialect = DEFAULT_DIALECT) {
  // altimate-core requires at least one table, so we seed a synthetic one that
  // won't match any real reference — this is the "no schema context" degraded mode.
  const Schema = loadCore().Schema;
  return Schema.fromJson(
    JSON.stringify({
      version: "1",
      dialect,
      database: null,
      schema_name: null,
      tables: { __ALTIMATE_NO_SCHEMA__: { columns: [{ name: "_", type: "VARCHAR", nullable: true }] } },
    })
  );
}

function tableDefFromColumns(database, schema, columns) {
  return { database: database || undefined, schema: schema || undefined, columns };
}

// catalog.json: nodes/sources -> { metadata:{database,schema,name}, columns:{COL:{name,type}} }
function defFromCatalog(catalogPath, dialect) {
  const cat = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const tables = {};
  for (const group of [cat.nodes, cat.sources]) {
    for (const node of Object.values(group || {})) {
      const meta = node.metadata || {};
      const cols = Object.values(node.columns || {}).map((c) => ({
        name: c.name,
        type: c.type || "VARCHAR",
        nullable: true,
      }));
      if (!meta.name || cols.length === 0) continue;
      tables[String(meta.name).toUpperCase()] = tableDefFromColumns(meta.database, meta.schema, cols);
    }
  }
  return { version: "1", dialect, database: null, schema_name: null, tables };
}

// manifest.json fallback: nodes/sources -> { database, schema, name, columns:{COL:{name,data_type}} }
function defFromManifest(manifestPath, dialect) {
  const man = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const tables = {};
  for (const group of [man.nodes, man.sources]) {
    for (const node of Object.values(group || {})) {
      if (node.resource_type && !["model", "seed", "snapshot", "source"].includes(node.resource_type)) continue;
      const name = node.name || (node.identifier ?? null);
      const cols = Object.values(node.columns || {}).map((c) => ({
        name: c.name,
        type: c.data_type || "VARCHAR",
        nullable: true,
      }));
      if (!name || cols.length === 0) continue;
      tables[String(name).toUpperCase()] = tableDefFromColumns(node.database, node.schema, cols);
    }
  }
  return { version: "1", dialect, database: null, schema_name: null, tables };
}

function cachedFromFile(filePath, builder) {
  const stat = fs.statSync(filePath);
  const key = `${filePath}:${stat.mtimeMs}`;
  if (_cache.has(key)) return _cache.get(key);
  const Schema = loadCore().Schema;
  const schema = Schema.fromJson(JSON.stringify(builder()));
  _cache.set(key, schema);
  return schema;
}

/**
 * Resolve a Schema. opts:
 *   - schemaJson / schemaYaml   : explicit inline schema (highest priority)
 *   - catalogPath / manifestPath: explicit artifact paths (from config)
 *   - projectDir / cwd          : where to find the dbt project (auto-detected otherwise)
 *   - dialect                   : default "snowflake"
 * Never throws — falls back to an empty Schema so callers degrade gracefully.
 */
export function resolveSchema(opts = {}) {
  const dialect = opts.dialect || DEFAULT_DIALECT;
  const Schema = loadCore().Schema;
  try {
    if (opts.schemaJson) return Schema.fromJson(opts.schemaJson);
    if (opts.schemaYaml) return Schema.fromYaml(opts.schemaYaml);
    const projectDir = opts.projectDir || findProjectDir(opts.cwd);
    const catalog = opts.catalogPath || (projectDir && path.join(projectDir, "target", "catalog.json"));
    const manifest = opts.manifestPath || (projectDir && path.join(projectDir, "target", "manifest.json"));
    if (catalog && fs.existsSync(catalog)) return cachedFromFile(catalog, () => defFromCatalog(catalog, dialect));
    if (manifest && fs.existsSync(manifest)) return cachedFromFile(manifest, () => defFromManifest(manifest, dialect));
  } catch {
    /* fall through to empty schema */
  }
  return emptySchema(dialect);
}
