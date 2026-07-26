// Grain-key `not_null` completeness — port of altimate-code's R20 S1.
//
// A model's grain keys (final-SELECT `GROUP BY` + dedup `PARTITION BY`) ARE its
// uniqueness contract. A nullable grain key breaks that contract silently: nulls
// don't group the way the author assumed, so the "one row per key" promise holds
// on the sample the author checked and fails on the first null that lands.
// Nothing else in the review checks that grain columns carry a `not_null` test.
//
// Pure JS — the `extractGrain` engine call happens in the run.js lane, this module
// only compares grain columns against declared tests.
import fs from "node:fs";
import path from "node:path";
import { parseSchemaYaml } from "./metadata.js";

/** Grain columns beyond this many produce ONE rollup finding instead of N. */
export const GRAIN_ROLLUP_AT = 3;

/**
 * Normalize `extractGrain`'s JSON payload. Tolerant of the string/object and
 * snake/camel variants so a core upgrade degrades rather than throws.
 * @returns {{groupBy: string[], dedupPartition: string[]}}
 */
export function parseGrain(raw) {
  let r = raw;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return { groupBy: [], dedupPartition: [] };
    }
  }
  if (!r || typeof r !== "object") return { groupBy: [], dedupPartition: [] };
  const arr = (v) => (Array.isArray(v) ? v.map(String) : []);
  return {
    groupBy: arr(r.group_by ?? r.groupBy),
    dedupPartition: arr(r.dedup_partition ?? r.dedupPartition),
  };
}

/**
 * Reduce a grain expression to the bare column it tests as. Returns null when the
 * expression can't be mapped to one declarable column — a positional `GROUP BY 1`,
 * a function call, a literal — because a `not_null` test can only be declared
 * against a named column, and guessing would manufacture false positives.
 */
export function grainColumn(expr) {
  const s = String(expr ?? "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return null; // positional GROUP BY ordinal
  // Take the last dotted segment: `orders.customer_id` tests as `customer_id`.
  const parts = s.split(".");
  const last = parts[parts.length - 1].replace(/^["'`[]+|["'`\]]+$/g, "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(last)) return null; // expression, not a column
  return last.toLowerCase();
}

/** Unique, declarable grain columns across both grain sources. */
export function grainColumns(grain) {
  const out = new Map(); // normalized → first raw spelling (for the message)
  for (const e of [...grain.groupBy, ...grain.dedupPartition]) {
    const c = grainColumn(e);
    if (c && !out.has(c)) out.set(c, String(e).trim());
  }
  return out;
}

const isNotNull = (name) => /(^|\.)not_null$/.test(String(name ?? "").trim());

/**
 * Columns of `model` carrying a `not_null` test, read from the manifest. The
 * manifest is authoritative: it resolves tests inherited from `dbt_project.yml`
 * and defined by packages, which a raw schema.yml parse cannot see.
 * Returns null when the model isn't in the manifest (→ caller falls back to YAML).
 * @returns {Set<string>|null}
 */
export function notNullFromManifest(manifest, model) {
  const nodes = manifest?.nodes;
  if (!nodes || typeof nodes !== "object") return null;
  const target = Object.keys(nodes).find(
    (id) => nodes[id]?.resource_type === "model" && (nodes[id].name === model || id.endsWith(`.${model}`)),
  );
  if (!target) return null;
  const out = new Set();
  for (const n of Object.values(nodes)) {
    if (n?.resource_type !== "test") continue;
    if (!isNotNull(n.test_metadata?.name ?? n.name)) continue;
    // `attached_node` is the tested model; older manifests only carry depends_on.
    const attached = n.attached_node ?? null;
    if (attached ? attached !== target : !(n.depends_on?.nodes || []).includes(target)) continue;
    const col = n.column_name ?? n.test_metadata?.kwargs?.column_name;
    if (col) out.add(String(col).toLowerCase());
  }
  return out;
}

/**
 * Columns of `model` carrying a `not_null` test, read from any schema.yml sitting
 * beside the model file. Works with no `dbt compile`, at the cost of missing
 * inherited and package-defined tests.
 * @returns {Set<string>|null} null when no YAML in that directory mentions the model.
 */
export function notNullFromYamlDir(dir, model, readDir = fs.readdirSync, readFile = fs.readFileSync) {
  let entries;
  try {
    entries = readDir(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/\.ya?ml$/.test(name)) continue;
    let parsed;
    try {
      parsed = parseSchemaYaml(readFile(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const spec = parsed?.models?.get(model);
    if (!spec) continue;
    const out = new Set();
    for (const [col, meta] of spec.columns) {
      for (const t of meta.tests.keys()) if (isNotNull(t)) out.add(String(col).toLowerCase());
    }
    return out;
  }
  return null;
}

/**
 * Compare grain columns against declared `not_null` tests and return finding
 * inputs (not Findings — the lane stamps file/model via makeFinding).
 *
 * `test_coverage` is deliberately non-blocking (rubric.js blockOn), but three
 * confident warnings still escalate to REQUEST_CHANGES via
 * `warningPatternThreshold`. A wide `GROUP BY` would therefore block an innocent
 * PR on its own, so at GRAIN_ROLLUP_AT+ unguarded columns we emit ONE finding
 * naming all of them instead of N.
 *
 * @param {{grain: object, notNull: Set<string>|null, source: "manifest"|"schema.yml"}} input
 */
export function grainNotNullFindings({ grain, notNull, source }) {
  if (!notNull) return []; // no declared-test source → nothing provable, stay silent
  const cols = grainColumns(grain);
  const missing = [...cols].filter(([norm]) => !notNull.has(norm)).map(([, raw]) => raw);
  if (!missing.length) return [];

  const provenance = `Declared tests read from ${source}.`;
  if (missing.length >= GRAIN_ROLLUP_AT) {
    const list = missing.join(", ");
    return [{
      severity: "warning",
      category: "test_coverage",
      title: `${missing.length} grain keys lack a \`not_null\` test: ${list}`,
      body: `These columns form this model's grain, so a null in any of them silently breaks its uniqueness contract — nulls do not group as the author assumed. Add \`not_null\` to each, or narrow the grain. ${provenance}`,
      // Column-less on purpose: one rollup per model, so it can't be mistaken
      // for a per-column finding when a later lane dedupes by fingerprint.
      ruleKey: `grain_not_null_rollup:${[...cols.keys()].sort().join(",")}`,
      confidence: "high",
    }];
  }
  return missing.map((raw) => ({
    severity: "warning",
    category: "test_coverage",
    title: `Grain key without a \`not_null\` test: ${raw}`,
    body: `\`${raw}\` is part of this model's grain (GROUP BY / dedup PARTITION BY), so a null in it silently breaks the model's uniqueness contract — nulls do not group as the author assumed. Add a \`not_null\` test on \`${raw}\`, or drop it from the grain. ${provenance}`,
    column: grainColumn(raw) ?? raw,
    ruleKey: `grain_not_null:${grainColumn(raw) ?? raw}`,
    confidence: "high",
  }));
}
