// dbt metadata (schema.yml) review lane — the triage-promotion rule from
// altimate-code's R20 S4: a PR that only touches dbt YAML must never be
// auto-approved when the change is risk-bearing.
//
// Without this, a schema.yml-only PR collects zero changed .sql models, lands in
// the "trivial" tier, produces no findings, and the verdict is APPROVE — even if
// it silently deleted a `not_null` test or dropped an enforced contract.
//
// Pure JS + js-yaml. No network, no LLM. Every parse is best-effort: an
// unparseable YAML side degrades the lane, it never crashes the review.
import { load as yamlLoad } from "js-yaml";
import { makeFinding } from "./finding.js";

/** schema.yml files that describe models/sources (dbt_project.yml et al are not). */
export function isModelYaml(p) {
  return /\.ya?ml$/.test(p) && /(^|\/)models\//.test(p);
}

const asArray = (v) => (Array.isArray(v) ? v : []);

/** A dbt test entry is either a bare string or a single-key object. */
function testName(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const k = Object.keys(entry)[0];
    return k ?? null;
  }
  return null;
}

/** Test config severity: `{not_null: {severity: warn}}` → "warn", default "error". */
function testSeverity(entry) {
  if (entry && typeof entry === "object") {
    const k = Object.keys(entry)[0];
    const sev = entry[k]?.severity;
    if (typeof sev === "string") return sev.toLowerCase();
  }
  return "error";
}

// dbt 1.8 renamed `tests:` → `data_tests:`; both are still accepted.
const testEntries = (node) => [...asArray(node?.tests), ...asArray(node?.data_tests)];

function testsOf(node) {
  const out = new Map();
  for (const e of testEntries(node)) {
    const n = testName(e);
    if (n) out.set(n, testSeverity(e));
  }
  return out;
}

function columnsOf(node) {
  const out = new Map();
  for (const c of asArray(node?.columns)) {
    if (c?.name) out.set(String(c.name), { tests: testsOf(c), dataType: c.data_type ?? null });
  }
  return out;
}

/**
 * Normalize a schema.yml into the shape the diff compares. Returns null when the
 * document is absent or unparseable (→ lane degrades for that file).
 */
export function parseSchemaYaml(text) {
  if (!text || !text.trim()) return { models: new Map(), sources: new Map() };
  let raw;
  try {
    raw = yamlLoad(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return { models: new Map(), sources: new Map() };
  const doc = /** @type {Record<string, unknown>} */ (raw);

  const models = new Map();
  for (const m of asArray(doc.models)) {
    if (!m?.name) continue;
    models.set(String(m.name), {
      columns: columnsOf(m),
      tests: testsOf(m),
      materialized: m.config?.materialized ?? null,
      contractEnforced: m.config?.contract?.enforced === true,
    });
  }

  const sources = new Map();
  for (const s of asArray(doc.sources)) {
    if (!s?.name) continue;
    const srcFreshness = s.freshness ?? null;
    for (const t of asArray(s.tables)) {
      if (!t?.name) continue;
      sources.set(`${s.name}.${t.name}`, {
        columns: columnsOf(t),
        tests: testsOf(t),
        // A table inherits source-level freshness unless it overrides it.
        freshness: t.freshness !== undefined ? t.freshness : srcFreshness,
        loadedAtField: t.loaded_at_field ?? s.loaded_at_field ?? null,
      });
    }
  }
  return { models, sources };
}

// Tests whose removal weakens a real correctness guarantee, vs. cosmetic ones.
// Anything not listed still reports — at `suggestion` — so nothing is silent.
const CORRECTNESS_TESTS = /^(not_null|unique|relationships|accepted_values|unique_combination_of_columns|expression_is_true|not_null_proportion|accepted_range)$/;
const isCorrectnessTest = (n) => CORRECTNESS_TESTS.test(String(n).replace(/^dbt_utils\.|^dbt_expectations\.expect_/, ""));

function diffTests({ push, base, head, entity, column, kind }) {
  const where = column ? `${entity}.${column}` : entity;
  for (const [name, baseSev] of base) {
    const headSev = head.get(name);
    if (headSev === undefined) {
      const correctness = isCorrectnessTest(name);
      push({
        severity: correctness ? "warning" : "suggestion",
        category: "test_coverage",
        title: `Test removed: \`${name}\` on ${where}`,
        body: `The \`${name}\` ${kind} test was deleted from the ${kind} spec. Removing a correctness test hides regressions rather than fixing them — restore it, or state in the PR why the guarantee no longer holds.`,
        column,
        ruleKey: `test_removed:${where}:${name}`,
        confidence: "high",
      });
    } else if (baseSev === "error" && headSev === "warn") {
      push({
        severity: "warning",
        category: "test_coverage",
        title: `Test downgraded to \`warn\`: \`${name}\` on ${where}`,
        body: `\`${name}\` was severity \`error\` and is now \`warn\` — it no longer fails the build. Justify the downgrade or restore it.`,
        column,
        ruleKey: `test_downgraded:${where}:${name}`,
        confidence: "high",
      });
    }
  }
}

function diffColumns({ push, base, head, entity, kind }) {
  for (const [col, baseCol] of base.columns) {
    const headCol = head.columns.get(col);
    if (!headCol) {
      push({
        severity: baseCol.tests.size ? "warning" : "suggestion",
        category: "contract_violation",
        title: `Column dropped from spec: ${entity}.${col}`,
        body: baseCol.tests.size
          ? `\`${col}\` was removed from the ${kind} spec along with its ${baseCol.tests.size} test(s) (${[...baseCol.tests.keys()].join(", ")}). If the column still exists, it is now untested and undocumented.`
          : `\`${col}\` was removed from the ${kind} spec. If the column still exists in the warehouse, the spec no longer describes it.`,
        column: col,
        ruleKey: `column_dropped:${entity}:${col}`,
        confidence: "medium",
      });
      continue;
    }
    diffTests({ push, base: baseCol.tests, head: headCol.tests, entity, column: col, kind });
    if (baseCol.dataType && headCol.dataType && baseCol.dataType !== headCol.dataType) {
      push({
        severity: "warning",
        category: "contract_violation",
        title: `Declared type changed: ${entity}.${col} ${baseCol.dataType} → ${headCol.dataType}`,
        body: "A declared `data_type` change is a contract change for every downstream consumer. Confirm the warehouse type matches and that consumers tolerate it.",
        column: col,
        ruleKey: `type_changed:${entity}:${col}`,
        confidence: "high",
      });
    }
  }
}

/**
 * Compare the base and head sides of one schema.yml and push findings for
 * risk-bearing metadata changes. Faithful in intent to upstream R20 S4: the goal
 * is that such a PR can never reach APPROVE, not that it necessarily blocks.
 *
 * Only `contract.enforced: true → false` is a blocking-category `critical`;
 * everything else lands at warning/suggestion so an honest YAML refactor
 * comments rather than fails.
 */
export function metadataLane({ findings, file, baseYaml, headYaml }) {
  const base = parseSchemaYaml(baseYaml);
  const head = parseSchemaYaml(headYaml);
  if (!base || !head) {
    findings.push(
      makeFinding({
        file,
        severity: "suggestion",
        category: "test_coverage",
        title: "Could not parse changed schema YAML",
        body: "The base or head side of this file failed to parse, so its metadata changes were not reviewed. Verify the YAML is valid.",
        ruleKey: `yaml_unparseable:${file}`,
        confidence: "unknown",
        degraded: true,
      }),
    );
    return;
  }

  const pushFor = (model) => (f) => findings.push(makeFinding({ file, model, ...f }));

  for (const [name, baseModel] of base.models) {
    const push = pushFor(name);
    const headModel = head.models.get(name);
    if (!headModel) {
      push({
        severity: "warning",
        category: "contract_violation",
        title: `Model removed from spec: ${name}`,
        body: `\`${name}\` and its entire spec (${baseModel.columns.size} column(s), ${baseModel.tests.size} model-level test(s)) were deleted from this file. If the model still exists it is now unspecified and untested.`,
        ruleKey: `model_dropped:${name}`,
        confidence: "medium",
      });
      continue;
    }
    if (baseModel.contractEnforced && !headModel.contractEnforced) {
      push({
        severity: "critical",
        category: "contract_violation",
        title: `Contract enforcement disabled: ${name}`,
        body: "`config.contract.enforced` went `true → false`. The column shape of this model is no longer enforced at build time, so a breaking shape change would ship silently.",
        ruleKey: `contract_disabled:${name}`,
        confidence: "high",
      });
    }
    if (baseModel.materialized && headModel.materialized && baseModel.materialized !== headModel.materialized) {
      push({
        severity: "warning",
        category: "materialization",
        title: `Materialization changed: ${name} ${baseModel.materialized} → ${headModel.materialized}`,
        body: "A materialization change alters build cost, freshness and — for incremental↔table — whether history is rebuilt. Confirm this is intended and that a full refresh is scheduled if required.",
        ruleKey: `materialization_changed:${name}`,
        confidence: "high",
      });
    }
    diffTests({ push, base: baseModel.tests, head: headModel.tests, entity: name, column: undefined, kind: "model" });
    diffColumns({ push, base: baseModel, head: headModel, entity: name, kind: "model" });
  }

  for (const [name, baseSrc] of base.sources) {
    const push = pushFor(name);
    const headSrc = head.sources.get(name);
    if (!headSrc) {
      push({
        severity: "warning",
        category: "contract_violation",
        title: `Source removed from spec: ${name}`,
        body: `Source table \`${name}\` was deleted from this file. Any model selecting it via \`source()\` will fail to compile.`,
        ruleKey: `source_dropped:${name}`,
        confidence: "medium",
      });
      continue;
    }
    if (baseSrc.freshness && !headSrc.freshness) {
      push({
        severity: "warning",
        category: "freshness",
        title: `Freshness check removed: ${name}`,
        body: "The `freshness` block was deleted, so stale data in this source will no longer be detected. Restore it or justify why staleness is acceptable.",
        ruleKey: `freshness_removed:${name}`,
        confidence: "high",
      });
    }
    diffTests({ push, base: baseSrc.tests, head: headSrc.tests, entity: name, column: undefined, kind: "source" });
    diffColumns({ push, base: baseSrc, head: headSrc, entity: name, kind: "source" });
  }
}
