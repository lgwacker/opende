---
name: dbt-analyze
description: Analyze downstream impact of dbt model changes using the dependency graph and compiled SQL. Use when evaluating the blast radius of a change before shipping. Deterministic CLI only (no altimate agent).
---

# dbt Impact Analysis

## Requirements
**Agent:** Claude Code (read-only analysis; no file writes needed)
**Tools used:** bash (`dbt`, `git`), MCP (`mcp__opende__*`), Read, Glob

See [OPENDE_CLI.md](../OPENDE_CLI.md) for the full CLI reference.

## When to Use This Skill

**Use when the user wants to:**
- Understand what breaks if they change a model
- Evaluate downstream impact before shipping
- Find all consumers of a model or column
- Assess risk of a refactoring

**Do NOT use for:**
- Creating or fixing models → use `dbt-develop` or `dbt-troubleshoot`
- Adding tests → use `dbt-test`

## Workflow

### 1. Identify the Changed Model

Accept from the user, or auto-detect from git:
```bash
git diff --name-only | grep '\.sql$'

# Verify it exists and compiles:
{{RUNNER}} compile --select <name>
```

### 2. Map the Dependency Graph

```bash
{{RUNNER}} ls --select <name>+1 --output json    # direct downstream
{{RUNNER}} ls --select +1<name> --output json    # what feeds it
```

For the full downstream tree, call `{{RUNNER}} ls --select <name>+` for all descendants, or recurse depth-1 with `{{RUNNER}} ls --select <name>+1`. Claude tracks the tree depth manually.

### 3. Column-Level Lineage (DETERMINISTIC via MCP)

Compile the changed model and all relevant downstream models, then gate and call:

```bash
{{RUNNER}} compile --select <name>
{{GATE_INVOCATION}} target/compiled/.../models/<name>.sql
```

**Single-model column lineage:**
```
mcp__opende__column_lineage  compiled SQL   # returns per-column source/transform map for <name>
```

**Before/after a change (returns affected_downstream columns):**
```
mcp__opende__diff_lineage  before_sql  after_sql   # DETERMINISTIC — lists affected downstream columns
```
Compile the model before and after your change (use `git show HEAD:path/to/model.sql` for the "before" version), then feed both compiled outputs to `diff_lineage`.

**Structural helpers** (model graph, not column-level):
```bash
{{RUNNER}} show --select <name> --limit 10 --output json              # columns before the change
{{RUNNER}} show --select <downstream> --limit 10 --output json        # columns consumed downstream
{{RUNNER}} show --inline "SELECT DISTINCT <col>, count(*) FROM {{ ref('<name>') }} GROUP BY 1 ORDER BY 2 DESC" --limit 20 --output json  # cardinality/sample check
```

**Ad-hoc row-count / impact checks on the live warehouse** — use `mcp__opende__execute` for raw SQL against fully-qualified tables (e.g. checking how many rows a change would affect). It does NOT resolve `{{ ref() }}`/Jinja; use `{{RUNNER}} show --inline` when ref-based queries are needed.

```
mcp__opende__execute {"sql": "SELECT count(*) FROM <db>.<schema>.<table> WHERE <condition>"}
mcp__opende__execute {"sql": "SELECT count(DISTINCT <col>) FROM <db>.<schema>.<table>"}
```

**Surface additional semantic/structural signals on compiled SQL:**
```
mcp__opende__validate       compiled SQL   # structural correctness, column references
mcp__opende__check_semantics compiled SQL  # wrong joins, cartesian products, NULL comparisons
```

For manifest-based metadata:
```bash
# Read target/manifest.json directly — contains compiled SQL, node metadata, and schema
```

### 4. Cross-Reference with Downstream

For each downstream model:
1. Read its compiled SQL
2. Check if it references any changed/removed columns
3. Classify impact:

| Classification | Meaning | Action |
|---------------|---------|--------|
| **BREAKING** | Removed/renamed column used downstream | Must fix before shipping |
| **SAFE** | Added column, no downstream reference | Ship freely |
| **UNKNOWN** | Can't determine (dynamic SQL, macros) | Manual review needed |

### 5. Generate Impact Report

Produce a structured report in this format:

```
Impact Analysis: stg_orders
════════════════════════════

Changed Model: stg_orders (materialized: view)
  Columns: 5 → 6 (+1 added)
  Removed: total_amount (renamed to order_total)

Downstream Impact (3 models):

  Depth 1:
    [BREAKING] int_order_metrics
      Uses: total_amount → COLUMN RENAMED
      Fix: Update column reference to order_total

    [SAFE] int_order_summary
      No references to changed columns

  Depth 2:
    [BREAKING] mart_revenue
      Uses: total_amount via int_order_metrics → CASCADING
      Fix: Verify after fixing int_order_metrics

Tests at Risk: 4
  - not_null_stg_orders_order_total
  - unique_int_order_metrics_order_id

Summary: 2 BREAKING, 1 SAFE
  Recommended: Fix int_order_metrics first, then rebuild:
  {{RUNNER}} build --select stg_orders+
```

## Without Manifest (SQL-Only Mode)

If no manifest is available (`target/manifest.json` absent):
1. Run `{{RUNNER}} compile --select <name>` to generate it, OR
2. Read raw `.sql` files directly
3. Note: downstream impact still requires reading each downstream model's SQL manually
4. Suggest: `{{RUNNER}} build --select <name>` to generate an up-to-date manifest

## How this maps (Option A)

| What stays deterministic (CLI / MCP) | What Claude reasons |
|--------------------------------------|---------------------|
| `{{RUNNER}} compile/ls/show` | Model-graph traversal, impact classification (BREAKING / SAFE / UNKNOWN) |
| `git diff --name-only` to detect changed models | — |
| `mcp__opende__column_lineage` on compiled SQL | — (DETERMINISTIC, replaces Claude-derived column flow) |
| `mcp__opende__diff_lineage` before/after compiled SQL | — (DETERMINISTIC, returns affected_downstream columns) |
| `mcp__opende__validate` + `check_semantics` on compiled SQL | Interpreting findings, deciding severity |
| `mcp__opende__execute` — raw SQL for live row-count / impact probes on fully-qualified tables (no Jinja/ref; use `{{RUNNER}} show --inline` when ref() is needed) | Interprets counts to quantify blast radius |
| Reading `target/manifest.json` directly | — |

Gate compiled files with `{{GATE_INVOCATION}} <files...>` before MCP calls. No `altimate run`, no TUI, no agent invocations.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Only checking direct children | Always trace the FULL downstream tree recursively |
| Ignoring test impacts | Check which tests reference changed columns |
| Shipping without building downstream | Always `{{RUNNER}} build --select <name>+` |
| Not considering renamed columns | A rename is a break + add — downstream still references the old name |
| Calling MCP tools on raw `.sql` with Jinja | Compile first — MCP tools need plain SQL; lineage from unresolved `ref()` calls is incomplete |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [OPENDE_CLI.md](../OPENDE_CLI.md) | Full CLI reference for `dbt` and MCP tools |
| [OPENDE_CLI.md](../OPENDE_CLI.md) | dbt CLI command reference |
| [references/lineage-interpretation.md](references/lineage-interpretation.md) | Understanding lineage output |
