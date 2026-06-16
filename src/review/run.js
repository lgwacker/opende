// End-to-end dbt PR review: collect the diff, run the deterministic recipe
// against altimate-core (+ manifest/catalog), and return a SIGNED verdict
// envelope. Reconstruction of altimate-code's `review/run.ts` + `orchestrate.ts`,
// wired to OUR primitives (core.js call(), resolveSchema, impact, schemaVerify)
// and the consumer's configured dbt runner (cfg.dbtCmd). No second model, no network.
//
// Lanes (each best-effort; a failing lane degrades, never crashes the review):
//   gate composite  → sql_correctness / pii_exposure / join_risk / fanout / semantic_change
//   grade regression→ quality_regression
//   equivalence     → semantic_change  (UNDECIDABLE = unknown warning, never blocks)
//   lineage breakage→ lineage_breakage (removed output cols × downstream consumers)
//   contract        → contract_violation (schema_verify shape mismatch)
//   structural      → semantic_change (AST DISTINCT/grain/key changes)
//   portability     → portability (cross-dialect on added lines)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { call } from "../core.js";
import { resolveSchema } from "../schema.js";
import { impactAnalysis } from "../impact.js";
import { schemaVerify } from "../schemaverify.js";
import { makeFinding, dedupeFindings, SEVERITY_ORDER } from "./finding.js";
import { loadReviewConfig, resolveRubric, exclusionReason } from "./rubric.js";
import { buildEnvelope } from "./verdict.js";

const hasJinja = (sql) => /\{\{|\{%/.test(sql || "");
const lower = (s) => String(s || "").toLowerCase();

// ── git helpers (read-only) ────────────────────────────────────────────────
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function gitSafe(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
}
function defaultBaseRef(cwd) {
  // Try merge-base against the usual default branches, in order (upstream git.ts).
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const mb = gitSafe(cwd, ["merge-base", ref, "HEAD"]).trim();
    if (mb) return mb;
  }
  return "HEAD~1";
}
function isModelSql(p) {
  return p.endsWith(".sql") && /(^|\/)models\//.test(p);
}
function collectChangedModels(cwd, base, head) {
  const out = new Set();
  // --relative makes diff paths cwd-relative (models/...), matching ls-files —
  // essential in a monorepo where the git root is ABOVE the dbt project dir.
  const diffArgs = ["diff", "--name-only", "--relative", "--diff-filter=d", base];
  if (head) diffArgs.push(head);
  for (const line of gitSafe(cwd, diffArgs).split("\n")) {
    const p = line.trim();
    if (p && isModelSql(p)) out.add(p);
  }
  if (!head) {
    for (const line of gitSafe(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
      const p = line.trim();
      if (p && isModelSql(p)) out.add(p);
    }
  }
  return [...out];
}
function manifestHashOf(manifestAbs) {
  try {
    return fs.existsSync(manifestAbs)
      ? crypto.createHash("sha256").update(fs.readFileSync(manifestAbs)).digest("hex").slice(0, 16)
      : undefined;
  } catch {
    return undefined;
  }
}

// dbt adapter_type → core SQL dialect (upstream ADAPTER_DIALECT, mostly identity).
const ADAPTER_DIALECT = {
  bigquery: "bigquery", snowflake: "snowflake", redshift: "redshift", postgres: "postgres",
  databricks: "databricks", spark: "databricks", duckdb: "duckdb", trino: "trino",
  athena: "athena", mysql: "mysql", oracle: "oracle", sqlserver: "tsql", synapse: "tsql", fabric: "fabric",
};
function detectDialect(manifestAbs) {
  try {
    const adapter = String(JSON.parse(fs.readFileSync(manifestAbs, "utf8"))?.metadata?.adapter_type ?? "").toLowerCase();
    return ADAPTER_DIALECT[adapter] ?? (adapter || null);
  } catch {
    return null;
  }
}

// ── dbt project helpers ──────────────────────────────────────────────────────
function dbtProjectName(cwd) {
  try {
    const txt = fs.readFileSync(path.join(cwd, "dbt_project.yml"), "utf8");
    const m = txt.match(/^\s*name:\s*['"]?([A-Za-z0-9_]+)['"]?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
function compiledSqlFor(compiledDir, projectName, relpath) {
  if (!projectName || !compiledDir) return null;
  const compiled = path.join(compiledDir, projectName, relpath);
  if (fs.existsSync(compiled)) return fs.readFileSync(compiled, "utf8");
  return null;
}
const modelName = (relpath) => path.basename(relpath, ".sql");

// ── equivalence verdict normalizer (defensive across core result shapes) ─────
function equivalenceVerdict(r) {
  if (!r || typeof r !== "object") return "unknown";
  if (typeof r.equivalent === "boolean") return r.equivalent ? "equivalent" : "different";
  if (typeof r.is_equivalent === "boolean") return r.is_equivalent ? "equivalent" : "different";
  const s = lower(r.status || r.result || r.verdict);
  if (/equivalent/.test(s) && !/not|non/.test(s)) return "equivalent";
  if (/(not_equivalent|different|mismatch)/.test(s)) return "different";
  if (/(unknown|undecidable|indeterminate)/.test(s)) return "unknown";
  if (Array.isArray(r.diffs)) return r.diffs.length ? "different" : "equivalent";
  return "unknown";
}

const GRADE_SCORE = { A: 4, B: 3, C: 2, D: 1, F: 0 };

// ── the lanes ────────────────────────────────────────────────────────────────
async function gateLane({ findings, headEngine, schema, file, model }) {
  if (!headEngine || hasJinja(headEngine)) return; // can't parse Jinja — skip lint/semantics
  const push = (f) => findings.push(makeFinding({ file, model, ...f }));

  try {
    const r = await call("scanSql", [headEngine]);
    for (const t of r.threats || []) {
      const isAllowlist = /^Statement type /i.test(t.detail || "") || t.rule === "multi_statement";
      if (isAllowlist) continue;
      const sev = t.severity === "critical" || t.severity === "high" ? "critical" : "warning";
      push({ severity: sev, category: "sql_correctness", title: `Injection/destructive risk: ${t.rule}`, body: t.message, ruleKey: t.rule, evidence: { tool: "scan_sql", result: t } });
    }
  } catch { /* lane degrade */ }

  try {
    const r = await call("lint", [headEngine, schema]);
    for (const f of r.findings || []) {
      const sev = f.severity === "error" ? "warning" : "suggestion";
      // lint/readability/best-practice → sql_quality (upstream's graded catch-all, non-blocking).
      push({ severity: sev, category: "sql_quality", title: `${f.code}: ${f.message}`, body: f.suggestion || f.message, startLine: f.line, ruleKey: f.code, evidence: { tool: "lint", result: f } });
    }
  } catch { /* lane degrade */ }

  try {
    const r = await call("checkQueryPii", [headEngine, schema]);
    for (const c of r.pii_columns || []) {
      push({ severity: "critical", category: "pii_exposure", title: `PII exposed: ${c.table}.${c.column}`, body: `Classified ${c.classification}. ${c.suggested_masking || "Mask or justify before merge."}`, column: c.column, ruleKey: `${c.table}.${c.column}`, evidence: { tool: "check_query_pii", result: c } });
    }
  } catch { /* lane degrade */ }

  try {
    const r = await call("checkSemantics", [headEngine, schema]);
    for (const f of r.findings || []) {
      const msg = f.message || JSON.stringify(f);
      const cat = /cartesian|cross\s*join/i.test(msg) ? "join_risk" : /fan|grain|duplicat/i.test(msg) ? "fanout" : "semantic_change";
      push({ severity: "warning", category: cat, title: f.code || f.rule || "semantic issue", body: msg, ruleKey: f.code || f.rule || "semantic", evidence: { tool: "check_semantics", result: f } });
    }
  } catch { /* lane degrade */ }
}

async function gradeRegressionLane({ findings, baseEngine, headEngine, schema, file, model, rubric }) {
  if (!baseEngine || hasJinja(baseEngine) || hasJinja(headEngine)) return;
  try {
    const [b, h] = await Promise.all([call("evaluate", [baseEngine, schema]), call("evaluate", [headEngine, schema])]);
    const drop = (GRADE_SCORE[b.overall_grade] ?? 0) - (GRADE_SCORE[h.overall_grade] ?? 0);
    if (drop >= (rubric.thresholds.gradeRegressionLetters ?? 1)) {
      findings.push(makeFinding({ file, model, severity: "warning", category: "sql_quality", title: `Quality grade dropped ${b.overall_grade}→${h.overall_grade}`, body: "Composite quality scorecard regressed across the change.", ruleKey: "grade_regression", evidence: { tool: "evaluate", result: { base: b.overall_grade, head: h.overall_grade } } }));
    }
  } catch { /* lane degrade */ }
}

async function equivalenceLane({ findings, baseEngine, headEngine, schema, file, model }) {
  if (!baseEngine || !headEngine || hasJinja(baseEngine) || hasJinja(headEngine)) return;
  try {
    const r = await call("checkEquivalence", [baseEngine, headEngine, schema]);
    const v = equivalenceVerdict(r);
    if (v === "different") {
      findings.push(makeFinding({ file, model, severity: "critical", category: "semantic_change", title: "Rewrite is NOT equivalent to the base", body: "The engine found a counterexample — this change alters results. Confirm intent.", ruleKey: "equivalence", evidence: { tool: "check_equivalence", result: r } }));
    } else if (v === "unknown") {
      findings.push(makeFinding({ file, model, severity: "warning", confidence: "unknown", degraded: true, category: "semantic_change", title: "Equivalence could not be decided", body: "Could not prove this rewrite preserves results. NOT a block — run a `data_diff` to confirm before merge.", ruleKey: "equivalence", evidence: { tool: "check_equivalence", result: r } }));
    }
  } catch { /* lane degrade */ }
}

async function lineageLane({ findings, baseEngine, headEngine, file, model, dialect, rubric, manifestPath, cwd }) {
  if (!baseEngine || hasJinja(baseEngine) || hasJinja(headEngine)) return;
  try {
    const [baseCols, headCols] = await Promise.all([
      call("extractOutputColumns", [baseEngine, dialect]),
      call("extractOutputColumns", [headEngine, dialect]),
    ]);
    const headSet = new Set((headCols || []).map(lower));
    const removed = (baseCols || []).filter((c) => !headSet.has(lower(c)));
    if (!removed.length) return;

    const impact = impactAnalysis({ model, changeType: "remove", manifestPath, projectDir: cwd, dialect });
    const consumers = impact.success ? impact.downstream_count : 0;
    const degraded = !impact.success;
    let severity, confidence;
    if (degraded) {
      severity = "warning";
      confidence = "unknown";
    } else if (consumers >= (rubric.thresholds.lineageCriticalConsumers ?? 1)) {
      severity = "critical";
      confidence = "high";
    } else if (consumers >= (rubric.thresholds.lineageWarnConsumers ?? 1)) {
      severity = "warning";
      confidence = "high";
    } else {
      severity = "suggestion";
      confidence = "high";
    }
    findings.push(makeFinding({
      file, model, severity, confidence, degraded,
      category: "lineage_breakage",
      title: `Removed output column(s): ${removed.join(", ")}`,
      body: degraded
        ? "Downstream impact unverified (no manifest). Run `dbt compile` to confirm blast radius."
        : `${consumers} downstream model(s) depend on ${model}; ${impact.affected_tests} test(s) affected.`,
      ruleKey: `removed:${removed.map(lower).sort().join(",")}`,
      evidence: { tool: "impact_analysis", result: impact },
    }));
  } catch { /* lane degrade */ }
}

function contractLane({ findings, file, model, manifestPath, cwd }) {
  try {
    // catalog-only — never spawn dbt per model during a multi-model review.
    const r = schemaVerify({ model, projectDir: cwd, manifestPath, allowShow: false });
    if (r.verdict === "mismatch") {
      const parts = [];
      if (r.columns_extra?.length) parts.push(`extra: ${r.columns_extra.join(", ")}`);
      if (r.columns_missing?.length) parts.push(`missing: ${r.columns_missing.join(", ")}`);
      if (r.columns_reordered?.length) parts.push(`reordered: ${r.columns_reordered.map((c) => c.column).join(", ")}`);
      if (r.type_mismatches?.length) parts.push(`type: ${r.type_mismatches.map((c) => `${c.column}(${c.actual_type}≠${c.expected_type})`).join(", ")}`);
      findings.push(makeFinding({ file, model, severity: "critical", category: "contract_violation", title: "Column shape does not match schema.yml spec", body: parts.join(" · "), ruleKey: "schema_verify", evidence: { tool: "schema_verify", result: r } }));
    } else if (r.error) {
      findings.push(makeFinding({ file, model, severity: "suggestion", confidence: "unknown", degraded: true, category: "contract_violation", title: "Column shape not verified", body: r.error, ruleKey: "schema_verify_degraded", evidence: { tool: "schema_verify", result: r } }));
    }
  } catch { /* lane degrade */ }
}

async function structuralLane({ findings, baseRaw, headRaw, file, model }) {
  if (!baseRaw) return;
  try {
    const r = JSON.parse(await call("reviewStructuralDiff", [baseRaw, headRaw]));
    const changes = r.changes || r.findings || (Array.isArray(r) ? r : []);
    for (const c of changes) {
      const sev = /high|structural|critical/i.test(c.severity || "") ? "warning" : "suggestion";
      findings.push(makeFinding({ file, model, severity: sev, category: "semantic_change", title: c.title || c.code || "Structural change", body: c.description || c.message || JSON.stringify(c), ruleKey: c.code || c.title || "structural", evidence: { tool: "review_structural_diff", result: c } }));
    }
  } catch { /* lane degrade */ }
}

async function portabilityLane({ findings, baseRaw, headRaw, file, model }) {
  try {
    const baseSet = new Set((baseRaw || "").split("\n").map((l) => l.trim()));
    const added = (headRaw || "").split("\n").map((l) => l.trim()).filter((l) => l && !baseSet.has(l));
    if (!added.length) return;
    const r = JSON.parse(await call("reviewLexicalScan", [added]));
    const items = r.findings || r.issues || (Array.isArray(r) ? r : []);
    for (const it of items) {
      // cross-dialect portability → sql_quality (non-blocking; no upstream "portability" category).
      findings.push(makeFinding({ file, model, severity: "suggestion", category: "sql_quality", title: it.title || it.rule || "Portability concern", body: it.message || it.description || JSON.stringify(it), ruleKey: it.rule || it.code || "portability", evidence: { tool: "review_lexical_scan", result: it } }));
    }
  } catch { /* lane degrade */ }
}

/**
 * Run the review. opts:
 *   cwd (required), base?, head?, manifestPath?, mode?, generatedAt?, coreVersion?
 * Returns a signed VerdictEnvelope.
 */
export async function reviewPullRequest(opts) {
  const cwd = opts.cwd;
  const config = loadReviewConfig(cwd);
  if (opts.manifestPath) config.manifestPath = opts.manifestPath;
  if (opts.mode) config.mode = opts.mode;
  const rubric = resolveRubric(config);
  const mode = config.mode || "comment";

  const base = opts.base ?? defaultBaseRef(cwd);
  const head = opts.head; // undefined ⇒ working tree
  const changed = collectChangedModels(cwd, base, head);

  const manifestAbs = path.isAbsolute(config.manifestPath) ? config.manifestPath : path.join(cwd, config.manifestPath);
  const catalogAbs = path.join(path.dirname(manifestAbs), "catalog.json");
  const compiledDir = opts.compiledDir || path.join(path.dirname(manifestAbs), "compiled");
  const manifestExists = fs.existsSync(manifestAbs);
  const catalogExists = fs.existsSync(catalogAbs);
  const lintOnly = !manifestExists && !catalogExists;

  // Dialect: explicit config wins; else auto-detect from the manifest's adapter_type
  // (so a BigQuery/Redshift project isn't analyzed as the snowflake default).
  const dialect = config.dialect || detectDialect(manifestAbs) || "snowflake";

  const schema = resolveSchema({ projectDir: cwd, catalogPath: catalogAbs, manifestPath: manifestAbs, dialect });
  const projectName = dbtProjectName(cwd);
  // cwd's path relative to the git root (e.g. "services/transformation/dbt/").
  // `git show <rev>:<path>` needs a ROOT-relative path; our relpaths are cwd-relative.
  const prefix = gitSafe(cwd, ["rev-parse", "--show-prefix"]).trim();
  const findings = [];
  let totalSqlLines = 0;
  let maxBlast = 0;

  for (const relpath of changed) {
    const model = modelName(relpath);
    // base side: always the file at the base ref (empty for newly-added models).
    const baseRaw = gitSafe(cwd, ["show", `${base}:${prefix}${relpath}`]);
    // head side: the head ref when given, else the working tree.
    const absPath = path.join(cwd, relpath);
    const headRaw = head
      ? gitSafe(cwd, ["show", `${head}:${prefix}${relpath}`])
      : fs.existsSync(absPath)
        ? fs.readFileSync(absPath, "utf8")
        : "";
    // Prefer compiled SQL for the engine lanes (Jinja-free); else raw (lanes guard on Jinja).
    const headEngine = compiledSqlFor(compiledDir, projectName, relpath) || headRaw;
    const baseEngine = baseRaw; // compiled base unavailable offline → raw

    // Risk-tier signals: changed SQL size + downstream blast radius (upstream risk-tier.ts).
    totalSqlLines += (headRaw || "").split("\n").length;
    if (manifestExists) {
      const imp = impactAnalysis({ model, manifestPath: manifestAbs, projectDir: cwd, dialect });
      if (imp.success) maxBlast = Math.max(maxBlast, imp.downstream_count);
    }

    const ctx = { findings, headEngine, baseEngine, baseRaw, headRaw, schema, file: relpath, model, dialect, rubric, manifestPath: manifestAbs, cwd };
    await gateLane(ctx);
    await gradeRegressionLane(ctx);
    await equivalenceLane(ctx);
    await lineageLane(ctx);
    contractLane(ctx);
    await structuralLane(ctx);
    await portabilityLane(ctx);
  }

  // rubric exclusions → dedupe → severityThreshold filter → severity-desc sort.
  let kept = dedupeFindings(findings.filter((f) => exclusionReason(f, rubric) === null));
  const threshold = config.severityThreshold;
  if (threshold && SEVERITY_ORDER[threshold] != null) {
    kept = kept.filter((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[threshold]);
  }
  kept.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.file.localeCompare(b.file));

  // Risk tier (upstream risk-tier.ts thresholds: line count + downstream blast).
  // NOTE: upstream additionally hard-floors to "full" on PII/contract/source/macro
  // signals and gates lanes per tier — we classify but always run all lanes (offline).
  let tier;
  if (changed.length === 0) tier = "trivial";
  else if (totalSqlLines > 100 || maxBlast > 5) tier = "full";
  else if (totalSqlLines <= 10 && maxBlast === 0) tier = "trivial";
  else tier = "lite";

  return buildEnvelope({
    findings: kept,
    tier,
    mode,
    rubric,
    degraded: lintOnly,
    manifestHash: manifestHashOf(manifestAbs),
    generatedAt: opts.generatedAt,
    engine: { core: opts.coreVersion },
  });
}
