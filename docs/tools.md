# MCP Tools Reference

> Auto-generated from `src/mcp.js`. Run `npm run docs:generate` to update.

opende exposes **64 deterministic tools** to Claude Code as `mcp__opende__<tool_name>`.

## Contents

- [Transform](#transform) — 8 tools
- [Lineage](#lineage) — 3 tools
- [Safety](#safety) — 2 tools
- [Quality](#quality) — 9 tools
- [PII](#pii) — 2 tools
- [Migration / schema](#migration-schema) — 6 tools
- [Tests / equivalence / context](#tests-equivalence-context) — 5 tools
- [Review / completion / context](#review-completion-context) — 6 tools
- [dbt config](#dbt-config) — 2 tools
- [Warehouse / live data](#warehouse-live-data) — 16 tools
- [Schema index / search](#schema-index-search) — 2 tools
- [dbt PR review / impact / contract](#dbt-pr-review-impact-contract) — 3 tools

---

## Transform

### `transpile`

Transpile SQL between dialects (deterministic, sqlglot engine).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |
| `source` | `string` | yes | — |
| `target` | `string` | yes | — |

### `format_sql`

Pretty-print / format SQL.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |

### `get_statement_types`

Classify each statement (SELECT/DML/DDL/…).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |

### `extract_metadata`

Extract tables, columns, functions, and structure from SQL.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |

### `extract_output_columns`

List the output (SELECT-list) column names.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |

### `extract_grain`

Extract grain keys (GROUP BY / PARTITION BY) from SQL.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |

### `extract_source_filters`

Extract upstream WHERE filters from SQL.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |

### `compare_queries`

Structural AST diff between two queries (CTEs, joins, predicates, column order). Use for quick syntactic comparison. For a semantic equivalence proof use `check_equivalence`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `left_sql` | `string` | yes | — |
| `right_sql` | `string` | yes | — |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |

## Lineage

### `column_lineage`

Column-level lineage for a compiled SQL query — returns a per-column source/transform map. Pass compiled SQL only; raw Jinja ({{ ref() }}) produces incomplete results. For lineage across multiple queries use `track_lineage`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |
| `depth` | `string` | no | — |

### `diff_lineage`

Diff column-level lineage between two compiled SQL versions — returns added/removed/modified edges and affected_downstream columns. Pass compiled SQL only (no Jinja). Use before/after a model change to see exactly which column flows broke.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `before_sql` | `string` | yes | — |
| `after_sql` | `string` | yes | — |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |
| `depth` | `string` | no | — |

### `track_lineage`

Build a cross-query provenance graph across a pipeline of compiled SQL queries in sequence. Use when lineage spans more than one model (e.g. staging → intermediate → mart). For a single query use `column_lineage`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `queries` | `string[]` | yes | — |
| `depth` | `string` | no | — |

## Safety

### `scan_sql`

Scan SQL for injection vectors and destructive operations — returns detailed findings per risk. Use when you need to know WHY SQL is unsafe. For a quick boolean gate use `is_safe`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |

### `is_safe`

Quick boolean: is this SQL safe to run? Returns true/false. Use as a fast pre-execution gate. For detailed findings on what is unsafe use `scan_sql`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |

## Quality

### `lint`

Lint SQL for style and anti-pattern violations (26 rules: SELECT *, missing aliases, naming, etc.) with severities and fix suggestions. For syntax/schema errors use `validate`; for semantic logic errors use `check_semantics`; for a combined A–F scorecard use `evaluate`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `validate`

Validate SQL for syntax errors and schema-resolution failures (unknown tables/columns). Run before executing. For style/anti-patterns use `lint`; for semantic logic errors use `check_semantics`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `check_semantics`

Detect semantic logic errors: wrong join types, cartesian products, NULL comparisons, fan-out risk. Run after `validate` passes. For style violations use `lint`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `evaluate`

Composite quality scorecard (A–F grade) combining lint + validate + check_semantics results. Use for an overall quality signal or to detect a grade regression between two versions. For targeted checks run `lint`, `validate`, or `check_semantics` directly.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `rewrite`

Suggest optimized rewrites of a query.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `explain`

Static offline analysis of a query: logical plan steps, cost signals (scan size, join type), and column lineage. No warehouse connection needed. For a live execution plan use `dbt show --inline 'EXPLAIN ...' --output json`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `fix`

Auto-fix SQL errors by fuzzy-matching wrong/misspelled table and column names against the schema. Use when the error is an unknown identifier. For logic/semantic errors that name-matching can't resolve use `correct`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |
| `max_iterations` | `number` | no | — |

### `correct`

Iterative propose-verify-refine loop for SQL logic errors — slower than `fix` but handles semantic issues that fuzzy name-matching can't resolve. Use when `fix` fails or the error is in logic, not identifiers.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `lint_diff`

Lint only NEW findings introduced relative to a base SQL.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `new_sql` | `string` | yes | — |
| `base_sql` | `string` | yes | — |
| `schema_context` | `string` | no | — |

## PII

### `classify_pii`

Classify all schema columns for PII categories (SSN, email, …).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |

### `check_query_pii`

Detect which PII columns a query exposes.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

## Migration / schema

### `analyze_migration`

Analyze a DDL migration for data-loss / breaking-change risk.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `diff_schemas`

Diff two schemas for breaking changes.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `old_schema_json` | `string` | no | — |
| `old_schema_yaml` | `string` | no | — |
| `new_schema_json` | `string` | no | — |
| `new_schema_yaml` | `string` | no | — |

### `import_ddl`

Parse DDL into a schema definition (JSON).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `ddl` | `string` | yes | — |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |

### `export_ddl`

Export the resolved schema as DDL.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |

### `introspection_sql`

Generate INFORMATION_SCHEMA introspection SQL for a warehouse.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `db_type` | `string` | yes | — |
| `database` | `string` | yes | — |
| `schema_name` | `string` | no | — |

### `schema_fingerprint`

Stable fingerprint (SHA256) of the resolved schema.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |

## Tests / equivalence / context

### `generate_tests`

Generate deterministic test cases (edge cases, NULLs, boundaries) for a query.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `check_equivalence`

Check whether two queries are semantically equivalent (verify a rewrite).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql_a` | `string` | yes | — |
| `sql_b` | `string` | yes | — |
| `dialect` | `string` | no | SQL dialect hint (e.g. 'snowflake', 'bigquery', 'redshift |

### `resolve_term`

Fuzzy-match a business term against schema/glossary.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `term` | `string` | yes | — |

### `prune_schema`

Return only the schema tables/columns referenced by a specific query (removes noise). Use to reduce schema size before passing it to other tools. For full context-window token compression use `optimize_context`; for a query-scoped token estimate use `optimize_for_query`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

### `optimize_for_query`

Compress schema to the tokens a specific query actually needs, with a token estimate. Query-scoped — narrows more aggressively than `prune_schema`. For full-schema compression not tied to a query use `optimize_context`.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |

## Review / completion / context

### `complete`

Schema-aware SQL autocomplete at a cursor position (tables/columns/functions/keywords).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |
| `sql` | `string` | yes | SQL text. |
| `cursor_pos` | `number` | yes | 0-indexed character offset of the cursor. |

### `optimize_context`

Compress the full schema for an LLM context window using progressive disclosure, with a token estimate. Not query-scoped — use `optimize_for_query` when you have a specific query to optimize for.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `schema_json` | `string` | no | Inline schema as JSON. Overrides dbt auto-resolution. |
| `schema_yaml` | `string` | no | Inline schema as YAML. Overrides dbt auto-resolution. |
| `project_dir` | `string` | no | dbt project directory (defaults to the resolved project). |

### `analyze_tags`

Fast tag-based anti-pattern detection on SQL (no schema needed).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |
| `skip_tags` | `string[]` | no | — |

### `review_structural_diff`

AST base-vs-head structural change detection — DISTINCT/UNION flips, grain shifts, surrogate-key changes, removed COALESCE/predicates, type narrowing. Ideal for PR review.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `base_sql` | `string` | yes | — |
| `head_sql` | `string` | yes | — |

### `review_lexical_scan`

Scan added diff lines for cross-dialect portability issues (reserved words, operator shifts).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `added_lines` | `string[]` | yes | Added (+) lines, without the leading +. |

### `parse_dbt_project`

Parse the dbt project (models, refs, sources, materializations, build order).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `project_dir` | `string` | no | — |

## dbt config

### `dbt_config_lint`

Lint a dbt model file for config/Jinja issues: missing required configs, invalid materializations, macro usage errors, Jinja syntax problems. Operates on raw model SQL (pre-compile, Jinja intact).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |

### `dbt_config_diff`

Report dbt config changes between two model versions.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `base_sql` | `string` | yes | — |
| `head_sql` | `string` | yes | — |

## Warehouse / live data

### `execute`

Run SQL against Snowflake. DROP DATABASE/SCHEMA/TRUNCATE hard-blocked; non-SELECT needs allow_write:true; reads get an auto-LIMIT. Does NOT resolve Jinja/{{ ref() }} — use `dbt show --inline` for dbt model queries.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `sql` | `string` | yes | SQL text. |
| `limit` | `number` | no | — |
| `allow_write` | `boolean` | no | Permit non-SELECT (DROP DB/SCHEMA/TRUNCATE stay blocked). |

### `schema_inspect`

Inspect a Snowflake table's columns/types (information_schema).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `table` | `string` | yes | Table, optionally schema-qualified (schema.table). |
| `schema_name` | `string` | no | — |

### `warehouse_list`

List configured dbt/Snowflake targets from profiles.yml (name, type, auth method, database). No credentials returned.

_No parameters._

### `data_diff`

Row-by-row diff of two Snowflake tables/queries (same-warehouse). Algorithms: auto|joindiff|hashdiff|profile|cascade. NOTE: up to 5 sample diff rows are returned and shown to the model — use `algorithm:"profile"` (column stats only, no row scan) on large or regulated tables, or add a where_clause to scope it.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `source` | `string` | yes | — |
| `target` | `string` | yes | — |
| `key_columns` | `string[]` | yes | — |
| `extra_columns` | `string[]` | no | — |
| `algorithm` | `string` | no | auto|joindiff|hashdiff|profile|cascade |
| `where_clause` | `string` | no | — |
| `source_database` | `string` | no | — |
| `source_schema` | `string` | no | — |
| `target_database` | `string` | no | — |
| `target_schema` | `string` | no | — |

### `finops_credits`

Snowflake credit consumption by warehouse/day (ACCOUNT_USAGE).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `days` | `number` | no | — |

### `finops_expensive_queries`

Most expensive queries by bytes scanned (ACCOUNT_USAGE.QUERY_HISTORY).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `days` | `number` | no | — |
| `limit` | `number` | no | — |

### `finops_warehouse_advice`

Warehouse load/sizing signals (query counts, exec/queue time).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `days` | `number` | no | — |

### `finops_unused_resources`

Stale tables not altered within N days (cleanup candidates).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `days` | `number` | no | — |

### `finops_query_history`

Recent query execution history (ACCOUNT_USAGE.QUERY_HISTORY).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `days` | `number` | no | — |
| `limit` | `number` | no | — |
| `user` | `string` | no | — |

### `finops_role_grants`

RBAC: privileges granted to roles (ACCOUNT_USAGE.GRANTS_TO_ROLES).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `role` | `string` | no | — |

### `finops_role_hierarchy`

RBAC: role-to-role grants (inheritance hierarchy).

_No parameters._

### `finops_user_roles`

RBAC: roles granted to users (ACCOUNT_USAGE.GRANTS_TO_USERS).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `user` | `string` | no | — |

### `schema_tags`

Snowflake object tags assigned to objects/columns (ACCOUNT_USAGE.TAG_REFERENCES).

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `object` | `string` | no | — |

### `schema_tags_list`

List all defined Snowflake tags (ACCOUNT_USAGE.TAGS).

_No parameters._

### `warehouse_test`

Test Snowflake connectivity for the active dbt target. Run this first when warehouse tools fail.

_No parameters._

### `schema_cache_status`

Status of the local schema index vs dbt artifacts (offline).

_No parameters._

## Schema index / search

### `schema_index`

(Re)build the local schema index from dbt catalog.json + manifest.json.

_No parameters._

### `schema_search`

Search the local schema index for tables/columns by keyword (offline, from catalog.json). Use to discover table names before writing SQL. Run `schema_index` first if results are stale.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `query` | `string` | yes | — |
| `limit` | `number` | no | — |

## dbt PR review / impact / contract

### `schema_verify`

Verify a model's ACTUAL columns (catalog.json / `dbt show`) against its schema.yml spec (manifest). Returns verdict match|mismatch|no-spec + columns_extra/missing/reordered/type_mismatches. A model isn't 'done' until this is `match` — even if the build is green.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `model` | `string` | yes | — |
| `manifest_path` | `string` | no | — |

### `impact_analysis`

DAG-aware downstream blast radius of a model/column change (offline, from the dbt manifest). Lists direct + transitive downstream models, affected tests, and a SAFE/LOW/MEDIUM/HIGH severity. Use before breaking changes.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `model` | `string` | yes | — |
| `column` | `string` | no | — |
| `change_type` | `"remove" | "rename" | "retype" | "add" | "modify"` | no | — |
| `manifest_path` | `string` | no | — |
| `dialect` | `string` | no | SQL dialect (default `"snowflake"`). |

### `dbt_pr_review`

Layered dbt PR review over changed models → SIGNED verdict (APPROVE | COMMENT | REQUEST_CHANGES) where every blocking finding is backed by a deterministic engine call (equivalence counterexample, lineage blast-radius, PII, contract shape, A–F grade). Reads .altimate/review.yml for rubric/mode. UNDECIDABLE equivalence is a warning, never a block.

| Parameter | Type | Required | Description |
|-----------|------|:--------:|-------------|
| `base` | `string` | no | Base git ref (default: merge-base with origin/main). |
| `head` | `string` | no | Head git ref (omit to review the working tree). |
| `manifest_path` | `string` | no | — |
| `mode` | `"comment" | "gate"` | no | comment (never blocks) | gate (blocks on REQUEST_CHANGES). |
| `force_tier` | `"trivial" | "lite" | "full"` | no | Override the computed risk tier. Changes the reported label only — every lane always runs, so this does NOT make a review cheaper. |
| `explain_tier` | `boolean` | no | Append the tier signals (changed SQL lines, blast radius, metadata risk) and which threshold decided the tier. |
