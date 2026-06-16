// Local schema index over dbt artifacts (catalog.json + manifest.json) with
// keyword search — approximates altimate's schema_index / schema_search. Offline,
// Snowflake-only, cached to disk (an XDG/per-project location, NEVER inside the
// package) and rebuilt when the artifacts change.
import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "./config.js";

// Resolve the artifact + cache locations for a call, defaulting via config.js
// (auto-detects projectDir, XDG cache, target/ paths). Callers may override any.
function locate(opts = {}) {
  const cfg = resolveConfig({
    flags: { projectDir: opts.projectDir, catalog: opts.catalogPath, manifest: opts.manifestPath },
  });
  return {
    projectDir: cfg.projectDir,
    catalog: cfg.catalogPath,
    manifest: cfg.manifestPath,
    cacheDir: opts.cacheDir || cfg.cacheDir,
    cacheFile: path.join(opts.cacheDir || cfg.cacheDir, "schema_index.json"),
  };
}

function buildEntries(catalog, manifest) {
  const entries = [];
  let descByTable = {};
  if (fs.existsSync(manifest)) {
    const man = JSON.parse(fs.readFileSync(manifest, "utf8"));
    for (const group of [man.nodes, man.sources]) {
      for (const node of Object.values(group || {})) {
        const name = node.name;
        if (!name) continue;
        descByTable[name.toUpperCase()] = {
          description: node.description || "",
          columns: Object.fromEntries(Object.values(node.columns || {}).map((c) => [c.name?.toUpperCase(), c.description || ""])),
        };
      }
    }
  }
  if (fs.existsSync(catalog)) {
    const cat = JSON.parse(fs.readFileSync(catalog, "utf8"));
    for (const group of [cat.nodes, cat.sources]) {
      for (const node of Object.values(group || {})) {
        const meta = node.metadata || {};
        if (!meta.name) continue;
        const tinfo = descByTable[meta.name.toUpperCase()] || {};
        entries.push({
          table: meta.name,
          database: meta.database,
          schema: meta.schema,
          description: tinfo.description || meta.comment || "",
          columns: Object.values(node.columns || {}).map((c) => ({
            name: c.name,
            type: c.type,
            description: (tinfo.columns || {})[String(c.name).toUpperCase()] || c.comment || "",
          })),
        });
      }
    }
  }
  return entries;
}

const stampOf = (catalog, manifest) =>
  [catalog, manifest].map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0));

export function buildIndex(opts = {}) {
  const loc = locate(opts);
  if (!loc.projectDir) throw new Error("dbt project not found.");
  const entries = buildEntries(loc.catalog, loc.manifest);
  fs.mkdirSync(loc.cacheDir, { recursive: true });
  fs.writeFileSync(loc.cacheFile, JSON.stringify({ stamp: stampOf(loc.catalog, loc.manifest), entries }));
  return { tables: entries.length, columns: entries.reduce((n, e) => n + e.columns.length, 0), cache: loc.cacheFile };
}

function loadIndex(loc) {
  const stamp = stampOf(loc.catalog, loc.manifest);
  if (fs.existsSync(loc.cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(loc.cacheFile, "utf8"));
    if (JSON.stringify(cached.stamp) === JSON.stringify(stamp)) return cached.entries;
  }
  buildIndex({ projectDir: loc.projectDir, catalogPath: loc.catalog, manifestPath: loc.manifest, cacheDir: loc.cacheDir });
  return JSON.parse(fs.readFileSync(loc.cacheFile, "utf8")).entries;
}

/** Report whether the on-disk index is present and fresh vs the dbt artifacts. */
export function cacheStatus(opts = {}) {
  const loc = locate(opts);
  const current = stampOf(loc.catalog, loc.manifest);
  const exists = fs.existsSync(loc.cacheFile);
  let fresh = false;
  let entries = 0;
  if (exists) {
    const cached = JSON.parse(fs.readFileSync(loc.cacheFile, "utf8"));
    fresh = JSON.stringify(cached.stamp) === JSON.stringify(current);
    entries = (cached.entries || []).length;
  }
  return {
    cache_file: loc.cacheFile,
    indexed: exists,
    fresh,
    tables_indexed: entries,
    catalog_present: fs.existsSync(loc.catalog),
    manifest_present: fs.existsSync(loc.manifest),
    note: !exists ? "run schema_index to build" : fresh ? "up to date" : "stale — run schema_index to rebuild",
  };
}

/** Keyword search over tables/columns/types/descriptions; ranked by match count. */
export function search(queryStr, opts = {}) {
  const loc = locate(opts);
  const limit = opts.limit ?? 20;
  const entries = loadIndex(loc);
  const terms = String(queryStr).toLowerCase().split(/\s+/).filter(Boolean);
  const score = (text) => {
    const t = (text || "").toLowerCase();
    return terms.reduce((n, term) => n + (t.includes(term) ? 1 : 0), 0);
  };
  const results = [];
  for (const e of entries) {
    const tableScore = score(`${e.table} ${e.description}`);
    const cols = e.columns
      .map((c) => ({ ...c, s: score(`${c.name} ${c.type} ${c.description}`) }))
      .filter((c) => c.s > 0);
    const total = tableScore * 2 + cols.reduce((n, c) => n + c.s, 0);
    if (total > 0)
      results.push({
        table: e.table, database: e.database, schema: e.schema, description: e.description,
        matched_columns: cols.slice(0, 10).map((c) => ({ name: c.name, type: c.type, description: c.description })),
        score: total,
      });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
