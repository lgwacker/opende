// schema-verify — diff a model's ACTUAL produced columns against the spec
// declared in schema.yml. Faithful reconstruction of altimate-code's
// `dbt-tools/commands/schema-verify.ts`, sourced from dbt artifacts:
//
//   expected (spec)  ← manifest.json node.columns  (schema.yml, order preserved)
//   actual (table)   ← catalog.json node.columns   (real warehouse columns)
//                       fallback: `<dbtCmd> show --select <m>` (default `dbt`)
//
// Four contract buckets + a verdict (match / mismatch / no-spec). Targets the
// "build is green but equality tests fail because the column SHAPE is wrong" bug.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function readJson(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

// Find a model/seed/snapshot node by its base name in a manifest- or catalog-shaped map.
function findNode(group, base) {
  if (!group) return null;
  for (const [id, n] of Object.entries(group)) {
    const rtype = n?.resource_type;
    if (rtype && !["model", "seed", "snapshot"].includes(rtype)) continue;
    const name = n?.name ?? n?.metadata?.name;
    if (name === base || id.endsWith(`.${base}`)) return n;
  }
  return null;
}

// catalog columns carry an `index` for ordering; manifest columns preserve
// schema.yml insertion order.
function actualFromCatalog(catalog, model) {
  const node = findNode(catalog.nodes, model) || findNode(catalog.sources, model);
  if (!node) return null;
  return Object.values(node.columns || {})
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((c) => ({ column: c.name, dtype: c.type || "" }));
}

// Best-effort fallback: parse `dbt show --output json` column keys. With no
// catalog this is the only offline source of actual columns. `dbtCmd` is the
// configured runner (default "dbt"; may be a wrapper script) — whitespace-split
// so a wrapper-with-args works.
function actualFromShow(projectDir, model, dbtCmd = "dbt") {
  const [cmd, ...pre] = String(dbtCmd).trim().split(/\s+/);
  let out;
  try {
    out = execFileSync(cmd, [...pre, "show", "--select", model, "--limit", "1", "--output", "json"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 180000,
    });
  } catch {
    return null;
  }
  // dbt prints a JSON object with a "show" array of row objects; take the keys.
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    const rows = parsed.show || parsed.rows || (Array.isArray(parsed) ? parsed : null);
    if (Array.isArray(rows) && rows.length && typeof rows[0] === "object") {
      return Object.keys(rows[0]).map((k) => ({ column: k, dtype: "" }));
    }
  } catch {
    /* unparseable */
  }
  return null;
}

/**
 * Verify a model's column shape against its schema.yml spec.
 * @param {{model:string, projectDir:string, manifestPath?:string, catalogPath?:string, dbtCmd?:string, allowShow?:boolean}} opts
 *        allowShow (default true): permit the `dbt show` fallback when the catalog
 *        lacks the model. The PR-review orchestrator sets this false so a
 *        multi-model review never spawns dbt (catalog-only, fast).
 *        dbtCmd: the dbt runner for the show fallback (default "dbt").
 */
export function schemaVerify({ model, projectDir, manifestPath, catalogPath, dbtCmd = "dbt", allowShow = true }) {
  manifestPath = manifestPath || path.join(projectDir, "target", "manifest.json");
  catalogPath = catalogPath || path.join(path.dirname(manifestPath), "catalog.json");

  const man = readJson(manifestPath);
  if (!man) return { model, error: `No manifest at ${manifestPath}. Run \`dbt compile\` / build first.`, degraded: true };
  const node = findNode(man.nodes, model);
  if (!node) return { model, error: `Model '${model}' not found in manifest.` };

  const expectedEntries = Object.values(node.columns || {}); // { name, data_type, ... }

  // Actual columns: catalog first (real warehouse types), then `<dbtCmd> show`.
  let actual = null;
  const cat = readJson(catalogPath);
  if (cat) actual = actualFromCatalog(cat, model);
  if (!actual && allowShow) actual = actualFromShow(projectDir, model, dbtCmd);
  if (!actual || !actual.length) {
    return {
      model,
      error: `No actual columns for '${model}'. Run \`dbt docs generate\` (catalog) or build the model.`,
      degraded: true,
    };
  }

  // No spec → nothing to verify against.
  if (expectedEntries.length === 0) {
    return {
      model,
      verdict: "no-spec",
      message: `Model '${model}' has no columns declared in schema.yml — no contract to verify; column choices are unconstrained.`,
      actual_columns: actual.map((c) => c.column),
    };
  }

  // Diff — case-insensitive name comparison (dbt convention).
  const actualNames = actual.map((c) => c.column ?? "");
  const actualLower = actualNames.map((n) => n.toLowerCase());
  const expectedNames = expectedEntries.map((c) => c.name ?? "");
  const expectedLower = expectedNames.map((n) => n.toLowerCase());
  const actualSet = new Set(actualLower);
  const expectedSet = new Set(expectedLower);

  const columns_extra = actualNames.filter((_, i) => !expectedSet.has(actualLower[i]));
  const columns_missing = expectedNames.filter((_, i) => !actualSet.has(expectedLower[i]));

  // Reordered: present in both, different positions within the intersection.
  const intersection = expectedLower.filter((n) => actualSet.has(n));
  const actualIntersection = actualLower.filter((n) => expectedSet.has(n));
  const columns_reordered = [];
  for (let i = 0; i < intersection.length; i++) {
    if (intersection[i] !== actualIntersection[i]) {
      const colLower = intersection[i];
      const expectedPos = expectedLower.indexOf(colLower);
      columns_reordered.push({
        column: expectedNames[expectedPos] ?? colLower,
        actual_position: actualLower.indexOf(colLower),
        expected_position: expectedPos,
      });
    }
  }

  // Type mismatches — only when the spec declared a data_type.
  const actualTypeByName = {};
  for (const c of actual) actualTypeByName[(c.column || "").toLowerCase()] = c.dtype || "";
  const type_mismatches = [];
  for (const ec of expectedEntries) {
    const key = (ec.name || "").toLowerCase();
    if (!actualTypeByName[key] || !ec.data_type) continue;
    if (actualTypeByName[key].toLowerCase() !== ec.data_type.toLowerCase()) {
      type_mismatches.push({ column: ec.name, actual_type: actualTypeByName[key], expected_type: ec.data_type });
    }
  }

  const verdict =
    columns_extra.length === 0 &&
    columns_missing.length === 0 &&
    columns_reordered.length === 0 &&
    type_mismatches.length === 0
      ? "match"
      : "mismatch";

  return {
    model,
    verdict,
    expected_columns: expectedNames,
    actual_columns: actualNames,
    columns_extra,
    columns_missing,
    columns_reordered,
    type_mismatches,
  };
}
