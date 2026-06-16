#!/usr/bin/env node
// Deterministic SQL gate — composes altimate-core directly (NO `altimate` binary,
// NO LLM). Replaces the old `altimate check` wrapper.
//
//   PostToolUse hook:  node gate.js --hook       (reads hook JSON on stdin)
//   pre-commit / CLI:  node gate.js file1.sql …  [--fail-on warning]
//
// Composes: lint + validate + scanSql + checkQueryPii + checkSemantics + evaluate.
//
// Blocking is intentionally conservative — it fires only on findings that are TRUE
// regardless of schema completeness (lint errors like DELETE-without-WHERE, real
// parse/syntax errors, genuine injection vectors). Schema-dependent signals
// (TableNotFound, PII exposure, semantic notes, grade) are advisory only, because
// the resolved schema may be partial and would otherwise cause false blocks.
//
// Env: ALTIMATE_FAIL_ON=none|warning|error (default error)
//      ALTIMATE_CHECKS=comma list (default lint,validate,safety,pii,semantic,grade)
//      ALTIMATE_CORE_PATH=<dir>  (see core.js)
import fs from "node:fs";
import path from "node:path";
import { call } from "./core.js";
import { resolveSchema, findProjectDir } from "./schema.js";

const SEV = { info: 0, warning: 1, error: 2 };
const DEFAULT_CHECKS = "lint,validate,safety,pii,semantic,grade";

// Jinja markers ({{ }}, {% %}, {# #}) — the SQL parser can't read these.
const hasJinja = (sql) => /\{\{|\{%|\{#/.test(sql || "");

const isSyntaxError = (kind) =>
  typeof kind?.type === "string" && /syntax|parse|lex/i.test(kind.type);
const isStatementAllowlist = (t) =>
  /^Statement type /i.test(t.detail || "") || t.rule === "multi_statement";

function mapScanSeverity(sev) {
  if (sev === "critical" || sev === "high") return "error";
  if (sev === "medium") return "warning";
  return "info";
}

function dbtProjectName(projectDir) {
  try {
    const m = fs.readFileSync(path.join(projectDir, "dbt_project.yml"), "utf8").match(/^\s*name:\s*['"]?([A-Za-z0-9_]+)['"]?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// dbt render-then-analyze: prefer the COMPILED SQL (target/compiled/<project>/<rel>),
// but only when it's at least as fresh as the source — a stale artifact would lint
// the pre-edit version. Returns the compiled SQL string, or null.
function freshCompiledSql(projectDir, file) {
  if (!projectDir) return null;
  const name = dbtProjectName(projectDir);
  if (!name) return null;
  const rel = path.relative(projectDir, path.resolve(file));
  const compiled = path.join(projectDir, "target", "compiled", name, rel);
  try {
    if (!fs.existsSync(compiled)) return null;
    if (fs.statSync(compiled).mtimeMs < fs.statSync(file).mtimeMs) return null; // stale
    return fs.readFileSync(compiled, "utf8");
  } catch {
    return null;
  }
}

async function checkFile(file, checks) {
  const raw = fs.readFileSync(file, "utf8");
  const dir = path.dirname(path.resolve(file));
  const projectDir = findProjectDir(dir);

  // Render-then-analyze, like altimate-code: never feed raw Jinja to the parser.
  // Use fresh compiled SQL when available; if the source is still Jinja (no
  // current compiled artifact), skip the parse-dependent checks and DON'T block —
  // a raw dbt model can't be parsed pre-compile. Advisory only.
  const compiled = freshCompiledSql(projectDir, file);
  const sql = compiled ?? raw;
  if (!compiled && hasJinja(raw)) {
    return {
      findings: [{
        file, check: "jinja", code: "jinja_uncompiled", severity: "info",
        message: "dbt model has unrendered Jinja — parse-dependent checks skipped (not blocked). Lint the rendered SQL by compiling the model (e.g. `dbt compile --select <model>`, then target/compiled/...), or use mcp__opende__dbt_pr_review.",
      }],
      grade: null,
    };
  }

  const schema = resolveSchema({ cwd: dir });
  const findings = [];
  const add = (f) => findings.push({ file, ...f });
  let grade = null;

  if (checks.has("lint")) {
    const r = await call("lint", [sql, schema]);
    for (const f of r.findings || [])
      add({ check: "lint", code: f.code, severity: f.severity, message: f.message, suggestion: f.suggestion, line: f.line });
  }
  if (checks.has("validate")) {
    const r = await call("validate", [sql, schema]);
    for (const e of r.errors || [])
      // Only real syntax/parse errors block; schema-resolution errors are advisory.
      add({ check: "validate", code: e.code, severity: isSyntaxError(e.kind) ? "error" : "info",
            message: e.message, line: e.location?.line });
    for (const w of r.warnings || [])
      add({ check: "validate", code: w.code, severity: "warning", message: w.message, line: w.location?.line });
  }
  if (checks.has("safety")) {
    const r = await call("scanSql", [sql]);
    for (const t of r.threats || [])
      // Demote the SELECT/WITH allowlist policy to advisory; keep real injection.
      add({ check: "safety", code: t.rule,
            severity: isStatementAllowlist(t) ? "info" : mapScanSeverity(t.severity),
            message: t.message, suggestion: t.detail });
  }
  if (checks.has("pii")) {
    const r = await call("checkQueryPii", [sql, schema]);
    for (const c of r.pii_columns || [])
      add({ check: "pii", code: c.classification, severity: "warning",
            message: `PII exposed: ${c.table}.${c.column} (${c.classification})`, suggestion: c.suggested_masking });
  }
  if (checks.has("semantic")) {
    const r = await call("checkSemantics", [sql, schema]);
    for (const f of r.findings || [])
      add({ check: "semantic", code: f.code || f.rule || "semantic",
            severity: f.severity === "error" ? "warning" : f.severity || "info", // never block on semantic (schema-sensitive)
            message: f.message || JSON.stringify(f) });
  }
  if (checks.has("grade")) {
    const r = await call("evaluate", [sql, schema]);
    grade = r.overall_grade;
  }
  return { findings, grade };
}

function formatReport(findings) {
  const byFile = {};
  for (const f of findings) (byFile[f.file] ??= []).push(f);
  const out = [];
  for (const [file, items] of Object.entries(byFile)) {
    out.push(`  ${file}`);
    for (const f of items.sort((a, b) => (SEV[b.severity] ?? 0) - (SEV[a.severity] ?? 0))) {
      const loc = f.line ? `:${f.line}` : "";
      out.push(`    [${(f.severity || "info").toUpperCase()}] ${f.code || f.check}${loc}  ${f.message}`);
      if (f.suggestion) out.push(`            -> ${f.suggestion}`);
    }
  }
  return out.join("\n");
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function hookTarget() {
  try {
    const data = JSON.parse(readStdin());
    const p = data?.tool_input?.file_path || data?.tool_input?.notebook_path;
    if (p && p.endsWith(".sql") && fs.existsSync(p)) return [p];
  } catch {
    /* not a hook payload */
  }
  return [];
}

async function main() {
  let argv = process.argv.slice(2);
  const hookMode = argv.includes("--hook");
  argv = argv.filter((a) => a !== "--hook");

  let failOn = process.env.ALTIMATE_FAIL_ON || "error";
  const i = argv.indexOf("--fail-on");
  if (i !== -1) { failOn = argv[i + 1]; argv.splice(i, 2); }

  const checks = new Set((process.env.ALTIMATE_CHECKS || DEFAULT_CHECKS).split(",").map((s) => s.trim()));
  const files = hookMode ? hookTarget() : argv.filter((a) => a.endsWith(".sql") && fs.existsSync(a));
  if (files.length === 0) return 0;

  let all = [];
  let grades = [];
  for (const f of files) {
    try {
      const { findings, grade } = await checkFile(f, checks);
      all = all.concat(findings);
      if (grade) grades.push(`${path.basename(f)}=${grade}`);
    } catch (e) {
      process.stderr.write(`altimate gate: error checking ${f}: ${e.message}\n`);
      if (!hookMode) return 1;
    }
  }

  const floor = failOn === "none" ? 99 : SEV[failOn] ?? 2;
  const blocking = all.filter((f) => (SEV[f.severity] ?? 0) >= floor);
  const advisory = all.filter((f) => !blocking.includes(f));

  if (hookMode) {
    if (blocking.length) {
      process.stderr.write(
        `altimate SQL gate BLOCKED this edit — deterministic findings at/above '${failOn}':\n` +
          formatReport(blocking) + "\nFix these before continuing.\n"
      );
      return 2;
    }
    if (advisory.length) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "altimate SQL gate (advisory):\n" + formatReport(advisory) },
      }));
    }
    return 0;
  }

  if (all.length) console.log(formatReport(all));
  const errors = all.filter((f) => f.severity === "error").length;
  const warnings = all.filter((f) => f.severity === "warning").length;
  console.log(`\naltimate-core: ${errors} error(s), ${warnings} warning(s) across ${files.length} file(s).` +
    (grades.length ? ` Grades: ${grades.join(", ")}.` : ""));
  if (blocking.length) { console.log(`FAILED (--fail-on ${failOn})`); return 1; }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => { process.stderr.write(String(e?.stack || e) + "\n"); process.exit(1); });
