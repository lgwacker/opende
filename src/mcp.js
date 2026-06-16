#!/usr/bin/env node
// altimate-core MCP server — exposes the deterministic (no-LLM, offline) engine
// functions to Claude Code as native tools (mcp__opende__*). This is the
// Claude-Code analog of the altimate agent's `altimate_core_*` tools.
//
// Schema-aware tools resolve a Schema from the dbt project (target/catalog.json)
// automatically; callers may override with `schema_json` / `schema_yaml`.
// Backend/AI/telemetry functions (initSdk, reviewAi*) are never exposed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call } from "./core.js";
import { resolveSchema } from "./schema.js";
import { resolveConfig, parseFlags } from "./config.js";
import * as wh from "./warehouse.js";
import * as finops from "./finops.js";
import { listTargets } from "./profiles.js";
import { runDataDiff, formatDiff } from "./datadiff.js";
import { buildIndex, search as schemaSearch, cacheStatus } from "./schemaindex.js";
import { impactAnalysis } from "./impact.js";
import { schemaVerify } from "./schemaverify.js";
import { reviewPullRequest } from "./review/run.js";
import { renderSummary, verdictHeadline } from "./review/format.js";

// Resolve where the dbt project + artifacts live: --project-dir / env / auto-detect.
const cfg = resolveConfig({ flags: parseFlags(process.argv.slice(2)) });
const DBT_DIR = cfg.projectDir;

const schemaFrom = (a) =>
  resolveSchema({
    schemaJson: a.schema_json, schemaYaml: a.schema_yaml,
    projectDir: a.project_dir || cfg.projectDir,
    catalogPath: a.project_dir ? undefined : cfg.catalogPath,
    manifestPath: a.project_dir ? undefined : cfg.manifestPath,
  });

// Common optional inputs for schema-aware tools.
const SCHEMA_OPTS = {
  schema_json: z.string().optional().describe("Inline schema as JSON (SchemaDefinition). Overrides dbt auto-resolution."),
  schema_yaml: z.string().optional().describe("Inline schema as YAML. Overrides dbt auto-resolution."),
  project_dir: z.string().optional().describe("dbt project dir (defaults to the resolved project)."),
};
const sql = z.string().describe("SQL text.");
const dialect = z.string().optional().describe('SQL dialect (default "snowflake").');

// Tool registry: name -> { description, shape, run(args) }
const TOOLS = {
  // ── Transform (no schema) ──────────────────────────────────────────────
  transpile: { description: "Transpile SQL between dialects (deterministic, sqlglot engine).",
    shape: { sql, source: z.string(), target: z.string() },
    run: (a) => call("transpile", [a.sql, a.source, a.target]) },
  format_sql: { description: "Pretty-print / format SQL.", shape: { sql, dialect },
    run: (a) => call("formatSql", [a.sql, a.dialect]) },
  get_statement_types: { description: "Classify each statement (SELECT/DML/DDL/…).", shape: { sql, dialect },
    run: (a) => call("getStatementTypes", [a.sql, a.dialect]) },
  extract_metadata: { description: "Extract tables, columns, functions, and structure from SQL.", shape: { sql, dialect },
    run: (a) => call("extractMetadata", [a.sql, a.dialect]) },
  extract_output_columns: { description: "List the output (SELECT-list) column names.", shape: { sql, dialect },
    run: (a) => call("extractOutputColumns", [a.sql, a.dialect]) },
  extract_grain: { description: "Extract grain keys (GROUP BY / PARTITION BY) from SQL.", shape: { sql },
    run: (a) => call("extractGrain", [a.sql]) },
  extract_source_filters: { description: "Extract upstream WHERE filters from SQL.", shape: { sql },
    run: (a) => call("extractSourceFilters", [a.sql]) },
  compare_queries: { description: "Structural diff between two queries.",
    shape: { left_sql: z.string(), right_sql: z.string(), dialect },
    run: (a) => call("compareQueries", [a.left_sql, a.right_sql, a.dialect]) },

  // ── Lineage (schema optional) ──────────────────────────────────────────
  column_lineage: { description: "Column-level lineage for a query (deterministic).",
    shape: { sql, dialect, ...SCHEMA_OPTS, depth: z.string().optional() },
    run: (a) => call("columnLineage", [a.sql, a.dialect, schemaFrom(a), null, null, a.depth]) },
  diff_lineage: { description: "Diff column-level lineage between two SQL versions (added/removed/modified edges).",
    shape: { before_sql: z.string(), after_sql: z.string(), dialect, ...SCHEMA_OPTS, depth: z.string().optional() },
    run: (a) => call("diffLineage", [a.before_sql, a.after_sql, a.dialect, schemaFrom(a), null, null, a.depth]) },
  track_lineage: { description: "Track lineage across multiple queries.",
    shape: { queries: z.array(z.string()), ...SCHEMA_OPTS, depth: z.string().optional() },
    run: (a) => call("trackLineage", [a.queries, schemaFrom(a), a.depth]) },

  // ── Safety (no schema) ─────────────────────────────────────────────────
  scan_sql: { description: "Scan SQL for injection vectors and destructive ops.", shape: { sql },
    run: (a) => call("scanSql", [a.sql]) },
  is_safe: { description: "Quick boolean: is this SQL safe to run?", shape: { sql },
    run: (a) => call("isSafe", [a.sql]) },

  // ── Quality (schema-aware) ─────────────────────────────────────────────
  lint: { description: "Lint SQL for anti-patterns (26 rules), with severities and fixes.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("lint", [a.sql, schemaFrom(a)]) },
  validate: { description: "Validate SQL — syntax errors and schema-resolution checks.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("validate", [a.sql, schemaFrom(a)]) },
  check_semantics: { description: "Semantic checks — wrong joins, cartesian products, NULL comparisons.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("checkSemantics", [a.sql, schemaFrom(a)]) },
  evaluate: { description: "Composite quality scorecard with an A–F grade.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("evaluate", [a.sql, schemaFrom(a)]) },
  rewrite: { description: "Suggest optimized rewrites of a query.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("rewrite", [a.sql, schemaFrom(a)]) },
  explain: { description: "Explain a query — plan steps, cost signals, lineage.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("explain", [a.sql, schemaFrom(a)]) },
  fix: { description: "Auto-fix SQL errors (fuzzy table/column matching).",
    shape: { sql, ...SCHEMA_OPTS, max_iterations: z.number().optional() },
    run: (a) => call("fix", [a.sql, schemaFrom(a), a.max_iterations]) },
  correct: { description: "Iterative propose-verify-refine correction of SQL.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("correct", [a.sql, schemaFrom(a)]) },
  lint_diff: { description: "Lint only NEW findings introduced relative to a base SQL.",
    shape: { new_sql: z.string(), base_sql: z.string(), schema_context: z.string().optional() },
    run: (a) => call("lintDiff", [a.new_sql, a.base_sql, a.schema_context]) },

  // ── PII (schema-aware) ─────────────────────────────────────────────────
  classify_pii: { description: "Classify all schema columns for PII categories (SSN, email, …).", shape: { ...SCHEMA_OPTS },
    run: (a) => call("classifyPii", [schemaFrom(a)]) },
  check_query_pii: { description: "Detect which PII columns a query exposes.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("checkQueryPii", [a.sql, schemaFrom(a)]) },

  // ── Migration / schema ─────────────────────────────────────────────────
  analyze_migration: { description: "Analyze a DDL migration for data-loss / breaking-change risk.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("analyzeMigration", [a.sql, schemaFrom(a)]) },
  diff_schemas: { description: "Diff two schemas for breaking changes.",
    shape: { old_schema_json: z.string().optional(), old_schema_yaml: z.string().optional(),
             new_schema_json: z.string().optional(), new_schema_yaml: z.string().optional() },
    run: (a) => call("diffSchemas", [
      resolveSchema({ schemaJson: a.old_schema_json, schemaYaml: a.old_schema_yaml, projectDir: DBT_DIR }),
      resolveSchema({ schemaJson: a.new_schema_json, schemaYaml: a.new_schema_yaml, projectDir: DBT_DIR }),
    ]) },
  import_ddl: { description: "Parse DDL into a schema definition (JSON).", shape: { ddl: z.string(), dialect },
    run: (a) => call("importDdl", [a.ddl, a.dialect]).then((s) => s.toJson?.() ?? s) },
  export_ddl: { description: "Export the resolved schema as DDL.", shape: { ...SCHEMA_OPTS },
    run: (a) => call("exportDdl", [schemaFrom(a)]) },
  introspection_sql: { description: "Generate INFORMATION_SCHEMA introspection SQL for a warehouse.",
    shape: { db_type: z.string(), database: z.string(), schema_name: z.string().optional() },
    run: (a) => call("introspectionSql", [a.db_type, a.database, a.schema_name]) },
  schema_fingerprint: { description: "Stable fingerprint (SHA256) of the resolved schema.", shape: { ...SCHEMA_OPTS },
    run: (a) => call("schemaFingerprint", [schemaFrom(a)]) },

  // ── Tests / equivalence / context ──────────────────────────────────────
  generate_tests: { description: "Generate deterministic test cases (edge cases, NULLs, boundaries) for a query.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("generateTests", [a.sql, schemaFrom(a)]) },
  check_equivalence: { description: "Check whether two queries are semantically equivalent (verify a rewrite).",
    shape: { sql_a: z.string(), sql_b: z.string(), ...SCHEMA_OPTS },
    run: (a) => call("checkEquivalence", [a.sql_a, a.sql_b, schemaFrom(a)]) },
  resolve_term: { description: "Fuzzy-match a business term against schema/glossary.", shape: { term: z.string(), ...SCHEMA_OPTS },
    run: (a) => call("resolveTerm", [a.term, schemaFrom(a)]) },
  prune_schema: { description: "Return only the schema tables/columns relevant to a query.", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("pruneSchema", [a.sql, schemaFrom(a)]) },
  optimize_for_query: { description: "Compress schema context to what a query needs (for context windows).", shape: { sql, ...SCHEMA_OPTS },
    run: (a) => call("optimizeForQuery", [a.sql, schemaFrom(a)]) },

  // ── Review / completion / context ──────────────────────────────────────
  complete: { description: "Schema-aware SQL autocomplete at a cursor position (tables/columns/functions/keywords).",
    shape: { sql, cursor_pos: z.number().describe("0-indexed character offset of the cursor."), ...SCHEMA_OPTS },
    run: (a) => call("complete", [a.sql, a.cursor_pos, schemaFrom(a)]) },
  optimize_context: { description: "Compress the schema for an LLM context window (progressive disclosure + token estimate).",
    shape: { ...SCHEMA_OPTS },
    run: (a) => call("optimizeContext", [schemaFrom(a)]) },
  analyze_tags: { description: "Fast tag-based anti-pattern detection on SQL (no schema needed).",
    shape: { sql, dialect, skip_tags: z.array(z.string()).optional() },
    run: (a) => call("analyzeTags", [a.sql, a.dialect || "snowflake", a.skip_tags]) },
  review_structural_diff: { description: "AST base-vs-head structural change detection — DISTINCT/UNION flips, grain shifts, surrogate-key changes, removed COALESCE/predicates, type narrowing. Ideal for PR review.",
    shape: { base_sql: z.string(), head_sql: z.string() },
    run: async (a) => JSON.parse(await call("reviewStructuralDiff", [a.base_sql, a.head_sql])) },
  review_lexical_scan: { description: "Scan added diff lines for cross-dialect portability issues (reserved words, operator shifts).",
    shape: { added_lines: z.array(z.string()).describe("Added (+) lines, without the leading +.") },
    run: async (a) => JSON.parse(await call("reviewLexicalScan", [a.added_lines])) },
  parse_dbt_project: { description: "Parse the dbt project (models, refs, sources, materializations, build order).",
    shape: { project_dir: z.string().optional() },
    run: (a) => call("parseDbtProject", [a.project_dir || DBT_DIR]) },

  // ── dbt config (no schema) ─────────────────────────────────────────────
  dbt_config_lint: { description: "Lint dbt model config / Jinja.", shape: { sql },
    run: (a) => call("dbtConfigLint", [a.sql]) },
  dbt_config_diff: { description: "Report dbt config changes between two model versions.",
    shape: { base_sql: z.string(), head_sql: z.string() },
    run: (a) => call("dbtConfigDiff", [a.base_sql, a.head_sql]) },

  // ── Warehouse / live data (Snowflake via dbt profile; safety-gated) ─────
  execute: { description: "Run SQL against Snowflake (=sql_execute). DROP DATABASE/SCHEMA/TRUNCATE hard-blocked; non-SELECT needs allow_write; reads get an auto-LIMIT.",
    shape: { sql, limit: z.number().optional(), allow_write: z.boolean().optional().describe("Permit non-SELECT (DROP DB/SCHEMA/TRUNCATE stay blocked).") },
    run: async (a) => wh.formatTable(await wh.execute(a.sql, { limit: a.limit ?? 100, allowWrite: a.allow_write })) },
  schema_inspect: { description: "Inspect a Snowflake table's columns/types (information_schema).",
    shape: { table: z.string().describe("Table, optionally schema-qualified (schema.table)."), schema_name: z.string().optional() },
    run: async (a) => {
      const parts = a.table.split("."); const tbl = parts.pop(); const sch = a.schema_name || (parts.length ? parts.pop() : null);
      const esc = (s) => s.replace(/'/g, "''");
      const sql2 = `SELECT column_name, data_type, is_nullable, ordinal_position FROM information_schema.columns WHERE upper(table_name)=upper('${esc(tbl)}')${sch ? ` AND upper(table_schema)=upper('${esc(sch)}')` : ""} ORDER BY ordinal_position`;
      const r = await wh.query(sql2);
      return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length });
    } },
  warehouse_list: { description: "List configured dbt/Snowflake targets (=warehouse_list).", shape: {},
    run: () => listTargets({ projectDir: DBT_DIR }) },
  data_diff: { description: "Row-by-row diff of two Snowflake tables/queries — deterministic, via altimate-core DataParitySession. Same-warehouse. NOTE: up to 5 sample diff rows are returned and shown to the model (avoid on regulated data, or use a where_clause).",
    shape: { source: z.string(), target: z.string(), key_columns: z.array(z.string()),
      extra_columns: z.array(z.string()).optional(), algorithm: z.string().optional().describe("auto|joindiff|hashdiff|profile|cascade"),
      where_clause: z.string().optional(), source_database: z.string().optional(), source_schema: z.string().optional(),
      target_database: z.string().optional(), target_schema: z.string().optional() },
    run: async (a) => { const r = await runDataDiff(a); return formatDiff(r) + "\n\n" + JSON.stringify(r.outcome?.stats || { error: r.error }, null, 2); } },
  finops_credits: { description: "Snowflake credit consumption by warehouse/day (ACCOUNT_USAGE).", shape: { days: z.number().optional() },
    run: async (a) => { const r = await finops.credits(a.days ?? 30); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  finops_expensive_queries: { description: "Most expensive queries by bytes scanned (ACCOUNT_USAGE.QUERY_HISTORY).", shape: { days: z.number().optional(), limit: z.number().optional() },
    run: async (a) => { const r = await finops.expensiveQueries(a.days ?? 7, a.limit ?? 20); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  finops_warehouse_advice: { description: "Warehouse load/sizing signals (query counts, exec/queue time).", shape: { days: z.number().optional() },
    run: async (a) => { const r = await finops.warehouseAdvice(a.days ?? 14); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  finops_unused_resources: { description: "Stale tables not altered within N days (cleanup candidates).", shape: { days: z.number().optional() },
    run: async (a) => { const r = await finops.unusedResources(a.days ?? 30); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  finops_query_history: { description: "Recent query execution history (ACCOUNT_USAGE.QUERY_HISTORY).", shape: { days: z.number().optional(), limit: z.number().optional(), user: z.string().optional() },
    run: async (a) => { const r = await finops.queryHistory(a.days ?? 7, a.limit ?? 100, a.user ?? null); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  finops_role_grants: { description: "RBAC: privileges granted to roles (ACCOUNT_USAGE.GRANTS_TO_ROLES).", shape: { role: z.string().optional() },
    run: async (a) => { const r = await finops.roleGrants(a.role ?? null); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  finops_role_hierarchy: { description: "RBAC: role-to-role grants (inheritance hierarchy).", shape: {},
    run: async () => { const r = await finops.roleHierarchy(); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  finops_user_roles: { description: "RBAC: roles granted to users (ACCOUNT_USAGE.GRANTS_TO_USERS).", shape: { user: z.string().optional() },
    run: async (a) => { const r = await finops.userRoles(a.user ?? null); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  schema_tags: { description: "Snowflake object tags assigned to objects/columns (ACCOUNT_USAGE.TAG_REFERENCES).", shape: { object: z.string().optional() },
    run: async (a) => { const r = await finops.schemaTags(a.object ?? null); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  schema_tags_list: { description: "List all defined Snowflake tags (ACCOUNT_USAGE.TAGS).", shape: {},
    run: async () => { const r = await finops.schemaTagsList(); return wh.formatTable({ columns: r.columns, rows: r.rows.map((o) => r.columns.map((c) => o[c])), row_count: r.rows.length }); } },
  warehouse_test: { description: "Test Snowflake connectivity for the active dbt target (=warehouse_test).", shape: {},
    run: () => wh.test({ projectDir: DBT_DIR }) },
  schema_cache_status: { description: "Status of the local schema index vs dbt artifacts (offline).", shape: {},
    run: () => cacheStatus({ projectDir: DBT_DIR, catalogPath: cfg.catalogPath, manifestPath: cfg.manifestPath, cacheDir: cfg.cacheDir }) },

  // ── Schema index / search (offline, from dbt catalog/manifest) ──────────
  schema_index: { description: "(Re)build the local schema index from dbt catalog.json + manifest.json.", shape: {},
    run: () => buildIndex({ projectDir: DBT_DIR, catalogPath: cfg.catalogPath, manifestPath: cfg.manifestPath, cacheDir: cfg.cacheDir }) },
  schema_search: { description: "Search indexed schema for tables/columns by keyword (=schema_search).",
    shape: { query: z.string(), limit: z.number().optional() },
    run: (a) => schemaSearch(a.query, { projectDir: DBT_DIR, catalogPath: cfg.catalogPath, manifestPath: cfg.manifestPath, cacheDir: cfg.cacheDir, limit: a.limit ?? 20 }) },

  // ── dbt PR review / impact / contract (deterministic, signed verdict) ──────
  schema_verify: { description: "Verify a model's ACTUAL columns (catalog.json / `dbt show`) against its schema.yml spec (manifest). Returns verdict match|mismatch|no-spec + columns_extra/missing/reordered/type_mismatches. A model isn't 'done' until this is `match` — even if the build is green.",
    shape: { model: z.string(), manifest_path: z.string().optional() },
    run: (a) => schemaVerify({ model: a.model, projectDir: DBT_DIR, manifestPath: a.manifest_path || cfg.manifestPath, catalogPath: cfg.catalogPath, dbtCmd: cfg.dbtCmd }) },
  impact_analysis: { description: "DAG-aware downstream blast radius of a model/column change (offline, from the dbt manifest). Lists direct + transitive downstream models, affected tests, and a SAFE/LOW/MEDIUM/HIGH severity. Use before breaking changes.",
    shape: { model: z.string(), column: z.string().optional(),
      change_type: z.enum(["remove", "rename", "retype", "add", "modify"]).optional(),
      manifest_path: z.string().optional(), dialect },
    run: (a) => impactAnalysis({ model: a.model, column: a.column, changeType: a.change_type || "modify",
      manifestPath: a.manifest_path || cfg.manifestPath, projectDir: DBT_DIR, dialect: a.dialect || "snowflake" }) },
  dbt_pr_review: { description: "Layered dbt PR review over changed models → SIGNED verdict (APPROVE | COMMENT | REQUEST_CHANGES) where every blocking finding is backed by a deterministic engine call (equivalence counterexample, lineage blast-radius, PII, contract shape, A–F grade). Reads .altimate/review.yml for rubric/mode. UNDECIDABLE equivalence is a warning, never a block.",
    shape: { base: z.string().optional().describe("Base git ref (default: merge-base with origin/main)."),
      head: z.string().optional().describe("Head git ref (omit to review the working tree)."),
      manifest_path: z.string().optional(),
      mode: z.enum(["comment", "gate"]).optional().describe("comment (never blocks) | gate (blocks on REQUEST_CHANGES).") },
    run: async (a) => {
      const env = await reviewPullRequest({ cwd: DBT_DIR, base: a.base, head: a.head,
        manifestPath: a.manifest_path || cfg.manifestPath, compiledDir: cfg.compiledDir, dbtCmd: cfg.dbtCmd,
        mode: a.mode, generatedAt: new Date().toISOString() });
      return verdictHeadline(env) + "\n\n" + renderSummary(env);
    } },
};

async function main() {
  const server = new McpServer({ name: "opende", version: "0.1.0" });
  for (const [name, def] of Object.entries(TOOLS)) {
    server.registerTool(name, { description: def.description, inputSchema: def.shape }, async (args) => {
      try {
        const result = await def.run(args ?? {});
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `altimate-core ${name} error: ${e?.message || e}` }] };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + "\n");
  process.exit(1);
});
