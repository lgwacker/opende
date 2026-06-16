---
name: query-optimize
description: Analyze and optimize SQL queries for performance — deterministic lint/anti-pattern checks via MCP tools, optimized rewrites and equivalence verification via MCP tools, EXPLAIN plans via {{RUNNER}}.
---

# Query Optimize

## Requirements
**Model:** Claude (Option A — no altimate agent)
**Deterministic tools:** `mcp__opende__lint`, `mcp__opende__check_semantics`, `mcp__opende__evaluate`, `mcp__opende__rewrite`, `mcp__opende__check_equivalence`, `mcp__opende__explain`, `{{RUNNER}} show --inline`
**Reasoning:** Claude interprets MCP tool output and presents findings

Analyze SQL queries for performance issues and suggest concrete optimizations including rewritten SQL.

## Workflow

1. **Get the SQL query** — Either read from a file path provided by the user, accept inline SQL from the conversation, or read the most recently discussed SQL.

2. **Determine the dialect** — Default to `snowflake`. If the user specifies a different dialect, use that.

3. **Gate check** — Run the gate before invoking MCP tools on any file:
   ```bash
   {{GATE_INVOCATION}} <file.sql>
   ```

4. **Run deterministic anti-pattern checks** using MCP tools:
   - `mcp__opende__lint` — style and anti-pattern findings (severity, rule, message)
   - `mcp__opende__check_semantics` — semantic issues (e.g. implicit Cartesian, ambiguous refs)
   - `mcp__opende__evaluate` — overall quality grade and signals

   Collect all findings across these three calls.

5. **Generate an optimized rewrite** (DETERMINISTIC):
   ```
   mcp__opende__rewrite  { sql: "<original_sql>", dialect: "snowflake" }
   ```
   Returns the rewritten SQL with optimization notes.

6. **Verify rewrite equivalence** (DETERMINISTIC):
   ```
   mcp__opende__check_equivalence  { sql_a: "<original_sql>", sql_b: "<rewritten_sql>", dialect: "snowflake" }
   ```
   Returns `equivalent` (bool), `confidence`, and `differences`. If `equivalent` is false or confidence is low, flag the divergence explicitly — present both versions and let the user decide.

7. **Get an execution plan explanation** (DETERMINISTIC):
   ```
   mcp__opende__explain  { sql: "<original_sql>", dialect: "snowflake" }
   ```
   Returns plan steps and `cost_signals`. Summarize key findings under "Execution Plan Insights".

   Optionally also run a live EXPLAIN against Snowflake (requires a live connection):
   ```bash
   {{RUNNER}} show --inline "EXPLAIN <original_sql>" --limit 50 --output json
   ```

8. **Present findings** in this format:

   ```
   Query Optimization Report
   =========================

   Summary: X suggestions found, Y anti-patterns detected

   High Impact:
     1. [REWRITE] Replace SELECT * with explicit columns
        Before: SELECT *
        After:  SELECT id, name, email

     2. [REWRITE] Use UNION ALL instead of UNION
        Before: ... UNION ...
        After:  ... UNION ALL ...

   Medium Impact:
     3. [PERFORMANCE] Add LIMIT to ORDER BY
        ...

   Execution Plan Insights:
   ------------------------
   (key findings from mcp__opende__explain cost_signals)

   Equivalence Check:
   ------------------
   equivalent: true | false  (confidence: X%)
   differences: <list if any>

   Optimized SQL:
   --------------
   SELECT id, name, email
   FROM users
   WHERE status = 'active'
   ORDER BY name
   LIMIT 100

   Anti-Pattern Details (from lint / check_semantics / evaluate):
   --------------------------------------------------------------
     [WARNING] SELECT_STAR: Query uses SELECT * ...
       -> Consider selecting only the columns you need.
   ```

9. **If no issues are found**, confirm the query looks well-optimized and briefly explain why.

## Usage

- `/query-optimize SELECT * FROM users ORDER BY name` — Optimize inline SQL
- `/query-optimize models/staging/stg_orders.sql` — Optimize SQL from a file
- `/query-optimize` — Optimize the most recently discussed SQL

## Iron Rules

- NEVER call `altimate run`, `altimate check`, or any agent/TUI mode.
- Always run `mcp__opende__lint` + `mcp__opende__check_semantics` before proposing any rewrite — findings anchor the report.
- Always run `mcp__opende__check_equivalence` on the rewrite before presenting it as safe.
- If `equivalent` is false or confidence is low, flag it — never silently present a semantically different rewrite.
- If `{{RUNNER}} show --inline` is unavailable (no live connection), skip the live EXPLAIN and note it.

## How this maps (Option A)

| Step | What runs | Who reasons |
|------|-----------|-------------|
| Anti-pattern detection | `mcp__opende__lint`, `mcp__opende__check_semantics`, `mcp__opende__evaluate` (deterministic) | — |
| Optimized rewrite | `mcp__opende__rewrite` (deterministic) | — |
| Equivalence verification | `mcp__opende__check_equivalence` (deterministic) | Claude flags divergences |
| Execution plan | `mcp__opende__explain` (deterministic); optional `{{RUNNER}} show --inline` live EXPLAIN | Claude interprets cost_signals |

See [REFERENCE.md](../REFERENCE.md).
