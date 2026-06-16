---
name: sql-translate
description: Translate SQL queries between database dialects — deterministic transpilation via mcp__opende__transpile, validation via mcp__opende__validate + scan_sql.
---

# SQL Translate

## Requirements
**Model:** Claude (Option A — no altimate agent)
**Deterministic tools:** `mcp__opende__transpile`, `mcp__opende__validate`, `mcp__opende__scan_sql`
**Reasoning:** Claude reviews warnings, flags lossy constructs, and presents findings

Translate SQL queries from one database dialect to another using the deterministic `mcp__opende__transpile` tool.

## Workflow

1. **Determine source and target dialects** — If the user did not specify both, ask. Common dialects: `snowflake`, `bigquery`, `postgres`, `mysql`, `tsql`, `hive`, `spark`, `databricks`, `redshift`, `duckdb`, `sqlite`, `oracle`, `trino`, `presto`.

2. **Get the SQL to translate** — Read from a file path or accept inline SQL.

3. **Gate check** — Run the gate before invoking MCP tools on any file:
   ```bash
   {{GATE_INVOCATION}} <file.sql>
   ```

4. **Transpile the SQL** (DETERMINISTIC):
   ```
   mcp__opende__transpile  { sql: "<original_sql>", source_dialect: "snowflake", target_dialect: "postgres" }
   ```
   Returns `transpiled_sql[]`, `success` (bool), and `error`. If `success` is false, report the error to the user — do not attempt manual fallback unless the user asks.

5. **Validate the translated SQL** (DETERMINISTIC):
   ```
   mcp__opende__validate  { sql: "<transpiled_sql>", dialect: "<target_dialect>" }
   mcp__opende__scan_sql  { sql: "<transpiled_sql>", dialect: "<target_dialect>" }
   ```
   Review parse/syntax errors and safety signals. Fix any issues surfaced and re-validate.

6. **Flag lossy or unrepresentable constructs** — Claude reviews the transpiled output and the `error`/warning fields to call out any constructs that have no direct equivalent and require manual review (e.g., Snowflake VARIANT/OBJECT/ARRAY in PostgreSQL, T-SQL cursors, BigQuery STRUCT).

7. **Present the output**:
   ```
   ## Translation: snowflake → postgres

   ### Original (Snowflake)
   ```sql
   SELECT DATEADD(day, 7, CURRENT_TIMESTAMP())
   ```

   ### Translated (PostgreSQL)
   ```sql
   SELECT CURRENT_TIMESTAMP + INTERVAL '7 days'
   ```

   ### Warnings / Manual Review Required
   - `ILIKE` replaced with `LOWER(...) LIKE LOWER(...)` — verify collation behavior matches your needs.
   - validate + scan_sql: no errors found.
   ```

8. **Offer next steps**:
   - Offer to write the translated SQL to a file
   - Offer to run `mcp__opende__lint` + `mcp__opende__check_semantics` for deeper quality analysis on the output
   - Offer to translate additional queries

## Supported Dialects

| Dialect | Key |
|---------|-----|
| Snowflake | `snowflake` |
| BigQuery | `bigquery` |
| PostgreSQL | `postgres` |
| MySQL | `mysql` |
| SQL Server | `tsql` |
| Hive | `hive` |
| Spark SQL | `spark` |
| Databricks | `databricks` |
| Redshift | `redshift` |
| DuckDB | `duckdb` |
| SQLite | `sqlite` |
| Oracle | `oracle` |
| Trino/Presto | `trino` / `presto` |

## Iron Rules

- NEVER call `altimate run`, `altimate check`, or any agent/TUI mode.
- NEVER skip `mcp__opende__validate` + `mcp__opende__scan_sql` on the translated output.
- Always flag constructs that are lossy or have no direct equivalent — never silently drop them.
- If `success` is false from `mcp__opende__transpile`, report the error — do not silently present partial output.
- If validation fails (syntax errors), fix and re-validate before presenting to the user.

## Common Mistakes

| Mistake | Correct approach |
|---------|-----------------|
| Treating `DATEADD(day, N, col)` as universal | Each dialect has its own date arithmetic syntax — map explicitly |
| Assuming QUALIFY works in PostgreSQL/MySQL | QUALIFY is Snowflake/BigQuery only — wrap in a subquery with ROW_NUMBER() |
| Carrying over Snowflake semi-structured types (VARIANT, ARRAY, OBJECT) to Postgres | Flag as manual-review; suggest JSONB or array types |
| Skipping validation on output | Always run `mcp__opende__validate` + `mcp__opende__scan_sql` on the translated SQL |
| Missing schema-level quoting differences | Snowflake is case-insensitive unquoted; PostgreSQL lowercases — verify identifier casing |

## How this maps (Option A)

| Step | What runs | Who reasons |
|------|-----------|-------------|
| Dialect transpilation | `mcp__opende__transpile` (deterministic) | — |
| Syntax / safety validation | `mcp__opende__validate` + `mcp__opende__scan_sql` (deterministic) | — |
| Lossy-construct review | — | Claude flags from transpile warnings + output diff |
| Deeper quality analysis (optional) | `mcp__opende__lint`, `mcp__opende__check_semantics` (deterministic) | — |

See [ALTIMATE_CLI.md](../ALTIMATE_CLI.md).
