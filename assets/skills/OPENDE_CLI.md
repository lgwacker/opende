# opende in Claude Code — shared reference

These skills give Claude Code deterministic SQL intelligence without ever invoking any LLM agent. Claude is the only model. There are three deterministic surfaces — all powered by **altimate-core** (the Rust/NAPI engine, run locally, no API key, no network):

## 1. `mcp__opende__*` — altimate-core as native MCP tools (primary surface)

A local MCP server exposes altimate-core's deterministic functions as Claude Code tools. Claude calls them directly mid-task. **64 tools** (49 altimate-core functions + warehouse/finops + the dbt PR-review verdict engine):

- **Transform:** `transpile`, `format_sql`, `get_statement_types`, `extract_metadata`, `extract_output_columns`, `extract_grain`, `extract_source_filters`, `compare_queries`
- **Lineage:** `column_lineage`, `diff_lineage`, `track_lineage`
- **Safety:** `scan_sql`, `is_safe`
- **Quality:** `lint`, `validate`, `check_semantics`, `evaluate` (A–F grade), `rewrite`, `explain`, `fix`, `correct`, `lint_diff`
- **PII:** `classify_pii`, `check_query_pii`
- **Migration/schema:** `analyze_migration`, `diff_schemas`, `import_ddl`, `export_ddl`, `introspection_sql`, `schema_fingerprint`
- **Tests:** `generate_tests`
- **Equivalence:** `check_equivalence`
- **Context/glossary:** `resolve_term`, `prune_schema`, `optimize_for_query`, `optimize_context`, `complete` (autocomplete)
- **Review (PR-diff):** `review_structural_diff` (AST grain/DISTINCT/key changes), `review_lexical_scan` (portability), `analyze_tags`, `lint_diff`
- **PR verdict / impact / contract:** `dbt_pr_review` (signed APPROVE/COMMENT/REQUEST_CHANGES verdict over changed models), `impact_analysis` (downstream blast radius from the manifest DAG), `schema_verify` (actual columns vs schema.yml spec → match/mismatch/no-spec)
- **dbt config:** `dbt_config_lint`, `dbt_config_diff`, `parse_dbt_project`
- **Warehouse / live data (Snowflake via your dbt profile):** `execute` (=sql_execute), `schema_inspect`, `warehouse_list`, `warehouse_test`, `data_diff`, `finops_credits`, `finops_expensive_queries`, `finops_warehouse_advice`, `finops_unused_resources`, `finops_query_history`, `finops_role_grants`, `finops_role_hierarchy`, `finops_user_roles`, `schema_tags`, `schema_tags_list`, `schema_index`, `schema_search`, `schema_cache_status`

The warehouse tools run through a **native snowflake-sdk executor** that reads credentials from `profiles.yml` (the active dbt target; `DBT_TARGET` to switch). They're **safety-gated by altimate-core**: `DROP DATABASE`/`DROP SCHEMA`/`TRUNCATE` are hard-blocked (unoverridable), non-`SELECT` needs `allow_write: true`, and reads get an auto-`LIMIT`. `data_diff` is same-warehouse (Snowflake) and returns up to 5 sample diff rows. `schema_index`/`schema_search` work offline from `target/catalog.json`.

Schema-aware tools (`lint`, `check_semantics`, `classify_pii`, `analyze_migration`,
`generate_tests`, `check_equivalence`, …) **auto-resolve the dbt project schema** from
`target/catalog.json` (real warehouse types) → `target/manifest.json` → empty. Refresh it
with `dbt docs generate`. Override per call with `schema_json` / `schema_yaml`. dbt models
contain Jinja — pass **compiled** SQL (`{{RUNNER}} compile --select <m>` → `target/compiled/...`)
for accurate parsing.

## 2. The gate — `{{GATE_INVOCATION}}` (deterministic CLI)

Composes `lint + validate + scan_sql + check_query_pii + check_semantics + evaluate` over
files, for batch / PR review and the PostToolUse edit-time gate:
```
{{GATE_INVOCATION}} <files...> [--fail-on warning]
```
Blocks only on schema-independent truths (lint errors, real syntax errors, real injection);
PII/semantic/grade/TableNotFound are advisory (the resolved schema may be partial). Env:
`ALTIMATE_FAIL_ON`, `ALTIMATE_CHECKS`, `ALTIMATE_CORE_PATH`.

**PR-review CLI** — `{{REVIEW_INVOCATION}}` drives the same signed-verdict
engine as `mcp__opende__dbt_pr_review`, for a one-shot review over changed models:
```
{{REVIEW_INVOCATION}} [--base R --head R] [--mode comment|gate] [--json]
```
Emits an APPROVE/COMMENT/REQUEST_CHANGES verdict (HMAC-signed, keyed to the manifest).
`gate` mode exits 1 on REQUEST_CHANGES; `comment` mode (default) never blocks. Reads
`.altimate/review.yml` for the per-repo rubric.

## 3. Standard dbt CLI — `{{RUNNER}}` (dbt ≥ 1.5)

`{{RUNNER}}` is the standard `dbt` command (or a custom wrapper passed via `--dbt-cmd` at `opende init` time). Use it for all dbt project operations:

```bash
# Project info and setup
{{RUNNER}} debug                                   # connection check, adapter info, missing deps
{{RUNNER}} deps                                    # install packages.yml

# Build / run / test
{{RUNNER}} compile --select <model>               # resolve Jinja → target/compiled/
{{RUNNER}} build --select <model>                 # compile + materialize + run tests
{{RUNNER}} build --select <model>+                # build model and all downstream
{{RUNNER}} run --select <model>                   # materialize only
{{RUNNER}} test --select <model>                  # run tests only

# Inspect model output (dbt ≥ 1.5)
{{RUNNER}} show --select <model> --limit 10 --output json       # preview rows (resolves Jinja, shows column names)
{{RUNNER}} show --inline "SELECT * FROM {{ ref('<model>') }}" --limit 5 --output json   # arbitrary Jinja-aware SQL
{{RUNNER}} show --inline "SELECT DISTINCT <col>, count(*) FROM {{ ref('<model>') }} GROUP BY 1 ORDER BY 2 DESC" --limit 20 --output json   # sample column values

# DAG traversal
{{RUNNER}} ls --select +1<model> --output json                  # immediate upstream parents (depth 1)
{{RUNNER}} ls --select <model>+1 --output json                  # immediate downstream children (depth 1)
{{RUNNER}} ls --select +<model> --output json                   # all upstream ancestors
{{RUNNER}} ls --select <model>+ --output json                   # all downstream descendants

# Schema / catalog
{{RUNNER}} docs generate                          # refresh target/manifest.json + catalog.json
```

> **Output format:** `dbt show --output json` returns `{"data": {"preview": "[{...}]", ...}}` — rows are in `data.preview` as a JSON string. `dbt ls --output json` returns JSONL (one JSON object per line) with `name`, `resource_type`, `path`, `config`, etc. Use `--output-keys "name path config"` to select specific fields from `dbt ls`.

For live warehouse column types and source tables not yet in dbt YAML:
```
mcp__opende__schema_inspect {"table": "<table>", "schema_name": "<schema>"}
```

For Jinja-free raw SQL against fully-qualified tables (no `{{ ref() }}`):
```
mcp__opende__execute {"sql": "SELECT * FROM <db>.<schema>.<table> LIMIT 5"}
```

**Do NOT call `dbt` commands that invoke the altimate LLM agent.** Use `{{RUNNER}}` (standard dbt), the MCP tools, and the gate only.

## Hard rules

- Never call `altimate run`, the `altimate` TUI, `altimate check`, or any altimate LLM agent.
- Use MCP tools, the gate, and `{{RUNNER}}` only. If a step needs a second model, do it yourself.
- Always compile before passing SQL to MCP tools — they need plain SQL, not raw Jinja.
