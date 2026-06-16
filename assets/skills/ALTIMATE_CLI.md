# Altimate engine in Claude Code — shared reference

These skills give Claude Code the data-engineering capabilities of `altimate-code`
**without ever invoking the altimate LLM agent**. Claude is the only model. There are
three deterministic, no-model surfaces — all powered by **altimate-core** (the Rust/NAPI
engine, run locally, no API key, no network):

## 1. `mcp__opende__*` — altimate-core as native MCP tools (primary surface)

A local MCP server (`the MCP server (mcp__opende__*)`) exposes altimate-core's deterministic
functions as Claude Code tools. Claude calls them directly mid-task — the analog of the
altimate agent's `altimate_core_*` tools. **64 tools** (49 altimate-core 0.4.0 functions +
warehouse/finops + the dbt PR-review verdict engine):

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

The warehouse tools run through a **native snowflake-sdk executor** that reads credentials from `profiles.yml` (the active dbt target; `DBT_TARGET` to switch). They're **safety-gated by altimate-core**: `DROP DATABASE`/`DROP SCHEMA`/`TRUNCATE` are hard-blocked (unoverridable), non-`SELECT` needs `allow_write: true`, and reads get an auto-`LIMIT`. They need the Snowflake `env_var()` credentials present in the MCP server's environment; absent them they error gracefully. `data_diff` is same-warehouse (Snowflake) and returns up to 5 sample diff rows (shown to the model — use a `where_clause` or avoid on regulated data). `schema_index`/`schema_search` work offline from `target/catalog.json`.

Schema-aware tools (`lint`, `check_semantics`, `classify_pii`, `analyze_migration`,
`generate_tests`, `check_equivalence`, …) **auto-resolve the dbt project schema** from
`target/catalog.json` (real warehouse types) → `target/manifest.json` → empty. Refresh it
with `dbt docs generate` (or `altimate-dbt`-compiled artifacts). Override per call with
`schema_json` / `schema_yaml`. dbt models contain Jinja — pass **compiled** SQL
(`altimate-dbt compile --model <m>` → `target/compiled/...`) for accurate parsing.

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
`.altimate/review.yml` for the per-repo rubric. The blocking categories, the ≥3-warning
risk pattern, and the **safety invariant** (undecidable equivalence is a warning, never a
block) are all in code — see the `dbt-pr-review` skill.

## 3. `altimate-dbt` — deterministic dbt/warehouse bridge (no LLM)

`info`, `doctor`, `compile --model <m>`, `build --model <m> [--downstream]`, `run`/`test --model <m>`,
`execute --query <sql> [--limit n]`, `columns --model <m>`, `columns-source --source <s> --table <t>`,
`column-values --model <m> --column <c>`, `parents`/`children --model <m>`, `deps`. This is how the
engine reaches your actual Snowflake data (altimate-core itself never connects to a warehouse).

## What's still out of scope

`data_diff` is supported **same-warehouse (Snowflake)**; cross-warehouse (e.g. Postgres↔Snowflake)
needs a second connection and is deferred. Non-Snowflake warehouses aren't wired. The
`finops_*` queries target Snowflake `ACCOUNT_USAGE` (need those grants). Everything else
altimate-core does is covered.

## Agent modes (`.claude/agents/`)

`builder` (full read/write + Pre-Execution & dbt Verification protocols), `analyst` (read-only,
SELECT-only exploration), `plan` (read-only planning), `reviewer` (adversarial diff review). The
always-on doctrine lives in the dbt project's `AGENTS.md` §11.

## Hard rule

**Never call `altimate run`, the `altimate` TUI, `altimate check`, or any altimate LLM agent.**
Use the MCP tools, the gate, and `altimate-dbt` only. If a step needs a second model, do it yourself.
