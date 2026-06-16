---
name: cost-report
description: Analyze Snowflake query costs and identify optimization opportunities — deterministic finops data via mcp__opende__finops_* tools, anti-pattern analysis via mcp__opende__lint + check_semantics + evaluate, warehouse/waste reasoning by Claude.
---

# Cost Report

## Requirements
**Model:** Claude Code (no altimate agent)
**Deterministic tools:** `mcp__opende__finops_credits`, `mcp__opende__finops_expensive_queries`, `mcp__opende__finops_warehouse_advice`, `mcp__opende__finops_unused_resources`, `mcp__opende__finops_query_history`, `mcp__opende__lint`, `mcp__opende__check_semantics`, `mcp__opende__evaluate`, `mcp__opende__rewrite`
**Reasoning:** Claude performs warehouse right-sizing, waste detection, and recommendations from tool results

Analyze Snowflake warehouse query costs, identify the most expensive queries, detect anti-patterns, and recommend optimizations.

**Note:** The `mcp__opende__finops_*` tools run curated SNOWFLAKE.ACCOUNT_USAGE SQL via the native Snowflake executor. They require ACCOUNT_USAGE grants (ACCOUNTADMIN or a role with IMPORTED PRIVILEGES on the SNOWFLAKE database). If any finops call fails with a permission error, tell the user and stop — do not attempt to hand-write the ACCOUNT_USAGE SQL as a workaround.

## Workflow

### Step 1 — Pull credit consumption

```
mcp__opende__finops_credits  →  { days: <N> }   // default 30
```

Returns total credits consumed and a breakdown by warehouse/service. Present as a markdown summary table.

### Step 2 — Find top expensive queries

```
mcp__opende__finops_expensive_queries  →  { days: <N>, limit: 20 }
```

Returns top queries ranked by bytes scanned. Present as a markdown table with query snippet, bytes scanned, and warehouse.

### Step 3 — Get query history

```
mcp__opende__finops_query_history  →  { days: <N>, limit: 50 }
```

Returns recent query history with execution stats. Use this to identify high-frequency expensive patterns and flag candidates for result caching or materialization.

### Step 4 — Analyze top 10 expensive queries with MCP tools

For each of the top 10 query texts from Step 2, run the following MCP tools in sequence. Pass the raw SQL string directly to each tool.

1. **`mcp__opende__lint`** — detects style and structural anti-patterns (SELECT *, missing LIMIT, cross joins, non-SARGable predicates). Returns a list of findings with severity.

2. **`mcp__opende__check_semantics`** — verifies the query makes logical sense (e.g., aggregation without GROUP BY, ambiguous column references, implicit type coercions).

3. **`mcp__opende__evaluate`** — scores the query on readability, maintainability, and performance risk; returns a structured grade and rationale.

4. **`mcp__opende__rewrite`** — request a rewrite focused on performance and materialization. Prompt: `"Rewrite for Snowflake performance: reduce bytes scanned, avoid correlated subqueries, and suggest whether this query is a candidate for an incremental dbt model or a result cache."` Review the suggestion before including it in the report.

Summarize anti-patterns (SELECT *, missing LIMIT, Cartesian products, correlated subqueries) and their severity using findings from lint + check_semantics + evaluate.

### Step 5 — Classify each query into a cost tier

| Tier | Credits | Label | Action |
|------|---------|-------|--------|
| 1 | < $0.01 | Cheap | No action needed |
| 2 | $0.01 – $1.00 | Moderate | Review if frequent |
| 3 | $1.00 – $100.00 | Expensive | Optimize or review warehouse sizing |
| 4 | > $100.00 | Dangerous | Immediate review required |

### Step 6 — Warehouse right-sizing

```
mcp__opende__finops_warehouse_advice  →  { days: <N> }
```

Returns per-warehouse sizing analysis (avg/peak concurrency, queue times, credit spend). Claude interprets: avg_concurrent_queries < 1 with a large warehouse size → candidate to downsize. High queue times → candidate to upsize or add clusters. Present recommendations in the report.

### Step 7 — Unused resource detection

```
mcp__opende__finops_unused_resources  →  { days: <N> }
```

Returns stale tables (not accessed in the window) and idle warehouses. Claude flags candidates for archival/suspension.

### Step 8 — Output the final report

```
# Snowflake Cost Report (Last N Days)

## Summary
- Total credits consumed: X
- Number of unique queries: Y
- Most expensive query: Z credits

## Credit Consumption by Warehouse
| Warehouse | Total Credits | Query Count |

## Top 10 Expensive Queries (Detailed Analysis)

### Query 1 (X bytes scanned) — DANGEROUS
**User:** user | **Warehouse:** wh | **Type:** SELECT
**Anti-patterns found:** (from mcp__opende__lint + check_semantics + evaluate)
- SELECT_STAR (warning): ...
**Optimization suggestions:** ...
**Cost tier:** Tier 4

...

## Waste Detection
### Stale Tables (not accessed in N+ days)
| Table | Last Accessed | Size (GB) | Recommendation |

### Idle Warehouses
| Warehouse | Size | Last Query | Recommendation |

## Warehouse Right-Sizing
| Warehouse | Current Size | Avg Concurrent | Peak Concurrent | Queue Time | Recommendation |

## Recommendations
1. Top priority query optimizations
2. Warehouse sizing suggestions
3. Unused resource cleanup
```

## Usage

- `/cost-report` — Analyze the last 30 days
- `/cost-report 7` — Analyze the last 7 days (pass `days: 7` to each finops tool)

## Iron Rules

- NEVER call `altimate run` or any agent mode.
- Always run `mcp__opende__lint`, `mcp__opende__check_semantics`, and `mcp__opende__evaluate` on expensive query texts — findings anchor the anti-pattern section.
- Use `mcp__opende__rewrite` to generate materialization/optimization hints; always review the suggestion before including it in the report.
- Requires SNOWFLAKE.ACCOUNT_USAGE privileges. If finops tool calls fail with permission errors, tell the user they need ACCOUNTADMIN or a role with IMPORTED PRIVILEGES on the SNOWFLAKE database.

## How this maps

| Step | What runs | Who reasons |
|------|-----------|-------------|
| Credit consumption | `mcp__opende__finops_credits` (deterministic) | — |
| Top expensive queries by bytes scanned | `mcp__opende__finops_expensive_queries` (deterministic) | — |
| Query history (frequency × cost) | `mcp__opende__finops_query_history` (deterministic) | Claude identifies caching/materialization candidates |
| Anti-pattern analysis per query | `mcp__opende__lint` + `mcp__opende__check_semantics` + `mcp__opende__evaluate` (deterministic) | — |
| Rewrite / materialization hints | `mcp__opende__rewrite` (deterministic execution, Claude reviews output) | Claude validates suggestion |
| Warehouse right-sizing | `mcp__opende__finops_warehouse_advice` (deterministic) | Claude interprets avg/peak/queue metrics |
| Waste detection | `mcp__opende__finops_unused_resources` (deterministic) | Claude flags candidates |

The `mcp__opende__finops_*` tools run curated ACCOUNT_USAGE SQL via the native Snowflake executor (safety-gated by altimate-core, credentials from dbt profiles.yml). Per-query anti-pattern analysis still uses `mcp__opende__lint`/`check_semantics`/`evaluate`; optimization hints via `mcp__opende__rewrite`.

See [ALTIMATE_CLI.md](../ALTIMATE_CLI.md).
