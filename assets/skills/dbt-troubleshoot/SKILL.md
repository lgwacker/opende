---
name: dbt-troubleshoot
description: Debug dbt errors — compilation failures, runtime database errors, test failures, wrong data, and performance issues. Use when something is broken, producing wrong results, or failing to build.
---

# dbt Troubleshooting

See [OPENDE_CLI.md](../OPENDE_CLI.md) for full CLI reference.

## When to Use This Skill

**Use when:**
- A dbt model fails to compile or build
- Tests are failing
- Model produces wrong or unexpected data
- Builds are slow or timing out
- User shares an error message from dbt

**Do NOT use for:**
- Creating new models → use `dbt-develop`
- Adding tests → use `dbt-test`
- Analyzing change impact → use `dbt-analyze`

## Iron Rules

1. **Never modify a test to make it pass without understanding why it's failing.**
2. **Fix ALL errors, not just the reported one.** After fixing the specific issue, run a full `dbt build`. If other models fail — even ones not mentioned in the error report — fix them too. Your job is to leave the project in a fully working state. Never dismiss errors as "pre-existing" or "out of scope".

## Diagnostic Workflow

### Step 1: Health Check

```bash
{{RUNNER}} debug
```

If `debug` fails, fix the environment first. Common issues:
- dbt-core not installed → `pip install dbt-core`
- No `dbt_project.yml` → run from the dbt project root
- Missing packages → if `packages.yml` exists but `dbt_packages/` doesn't, run `{{RUNNER}} deps`

### Step 2: Classify the Error

| Error Type | Symptom | Reference |
|-----------|---------|-----------|
| Compilation Error | Jinja/YAML parse failure | [compilation-errors.md](references/compilation-errors.md) |
| Runtime/Database Error | SQL execution failure | [runtime-errors.md](references/runtime-errors.md) |
| Test Failure | Tests return failing rows | [test-failures.md](references/test-failures.md) |
| Wrong Data | Model builds but data is incorrect | Step 3 below |

### Step 3: Isolate the Problem

```bash
# Compile only — catches Jinja errors without hitting the database
{{RUNNER}} compile --select <name>

# If compile succeeds, try building
{{RUNNER}} build --select <name>

# Probe the data directly
{{RUNNER}} show --inline "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1 --output json
{{RUNNER}} show --inline "SELECT * FROM {{ ref('<name>') }}" --limit 5 --output json
```

### Step 3b: Offline SQL Analysis

After compiling, gate the file and run deterministic MCP checks:

```bash
{{GATE_INVOCATION}} target/compiled/<project>/models/<path>/<name>.sql
```
```
mcp__opende__check_semantics  compiled SQL   # wrong joins, cartesian products, NULL comparisons
mcp__opende__lint             compiled SQL   # style, naming, anti-patterns
mcp__opende__validate         compiled SQL   # structural correctness, column references
```

Claude reasons from the check output to identify root causes:
- **Wrong join type**: `INNER JOIN` dropping rows that should appear → switch to `LEFT JOIN`
- **Fan-out**: One-to-many join inflating row counts → add deduplication or aggregate
- **Column mismatch**: Output columns don't match schema.yml definition → reorder SELECT
- **NULL comparison**: Using `= NULL` instead of `IS NULL` → silent data loss

**Auto-fix options** (use after understanding root cause):
```
mcp__opende__fix      compiled SQL   # auto-fix fuzzy table/column name mismatches
mcp__opende__correct  compiled SQL   # iterative correction — propose → apply → re-check loop
```

**Trace column lineage** to identify where wrong data originates:
```
mcp__opende__column_lineage  compiled SQL   # DETERMINISTIC — per-column source/transform map
```
Use `{{RUNNER}} show` for model-graph schema; `mcp__opende__column_lineage` for tracing data flow upstream.

### Step 3c: Wrong Data Diagnosis — Deep Data Exploration

When a model builds but produces wrong results, explore the actual data.

**Use `{{RUNNER}} show --inline` for Jinja-aware queries (resolves `{{ ref() }}`):**

```bash
# 1. Check for unexpected NULLs
{{RUNNER}} show --inline "SELECT count(*) as total, count(<col>) as non_null, count(*) - count(<col>) as nulls FROM {{ ref('<name>') }}" --limit 1 --output json

# 2. Check value ranges
{{RUNNER}} show --inline "SELECT min(<metric>), max(<metric>), avg(<metric>) FROM {{ ref('<name>') }}" --limit 1 --output json

# 3. Check distinct values for key columns
{{RUNNER}} show --inline "SELECT <col>, count(*) FROM {{ ref('<name>') }} GROUP BY 1 ORDER BY 2 DESC" --limit 20 --output json

# 4. Compare row counts between model output and parent tables
{{RUNNER}} show --inline "SELECT count(*) FROM {{ ref('<parent>') }}" --limit 1 --output json
```

**Use `mcp__opende__execute` for raw warehouse queries — fully-qualified table names, `information_schema`, `ACCOUNT_USAGE`, or ad-hoc exploration. It does NOT resolve `{{ ref() }}`/Jinja.**

```
# Quick column check on a source or fully-qualified table
mcp__opende__execute {"sql": "SELECT * FROM <db>.<schema>.<table> LIMIT 5"}

# Count/null/range probe without going through dbt
mcp__opende__execute {"sql": "SELECT count(*), count(<col>), min(<col>), max(<col>) FROM <db>.<schema>.<table>"}
```

**Use `mcp__opende__schema_inspect` for a fast column-type check** before writing exploration queries:
```
mcp__opende__schema_inspect {"table": "<table>", "schema_name": "<schema>"}
```

**Common wrong-data root causes:**
- **Fan-out from joins**: Check with `SELECT key, count(*) ... GROUP BY 1 HAVING count(*) > 1`
- **Missing rows from INNER JOIN**: Switch to LEFT JOIN and check for NULL join keys
- **Date spine issues**: Check min/max dates on `current_date` or `dbt_utils.date_spine` usage

### Step 4: Check Upstream

```bash
{{RUNNER}} ls --select +1<name> --output json
```

Read the parent models. Build them individually. Query the parent data:

```bash
{{RUNNER}} show --inline "SELECT count(*), count(DISTINCT <pk>) FROM {{ ref('<parent>') }}" --limit 1 --output json
{{RUNNER}} show --inline "SELECT * FROM {{ ref('<parent>') }}" --limit 5 --output json
```

### Step 5: Fix and Verify

Claude proposes the fix based on Step 3b analysis. After applying:

```bash
# Build with downstream to catch cascading impacts
{{RUNNER}} build --select <name>+

# Verify the fix with data queries — don't just trust the build
{{RUNNER}} show --inline "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1 --output json
{{RUNNER}} show --inline "SELECT * FROM {{ ref('<name>') }}" --limit 10 --output json
{{RUNNER}} show --inline "SELECT min(<col>), max(<col>), count(*) - count(<col>) as nulls FROM {{ ref('<name>') }}" --limit 1 --output json
```

Re-gate and re-run MCP checks on the fixed compiled SQL:
```bash
{{RUNNER}} compile --select <name>
{{GATE_INVOCATION}} target/compiled/<project>/models/<path>/<name>.sql
```
```
mcp__opende__check_semantics  compiled SQL
mcp__opende__lint             compiled SQL
mcp__opende__validate         compiled SQL
```

## Rationalizations to Resist

| You're Thinking... | Reality |
|--------------------|---------|
| "Just make the test pass" | The test is telling you something. Investigate first. |
| "Let me delete this test" | Ask WHY it exists before removing it. |
| "It works on my machine" | Check the adapter, Python version, and profile config. |
| "I'll fix it later" | Later never comes. Fix it now. |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Changing tests before understanding failures | Read the error. Query the data. Understand the root cause. |
| Fixing symptoms instead of root cause | Trace the problem upstream. The bug is often 2 models back. |
| Not checking upstream models | Run `{{RUNNER}} ls --select +1<name>` and build parents individually |
| Ignoring warnings | Warnings often become errors. Fix them proactively. |
| Not running offline SQL analysis | Compile first, then `mcp__opende__check_semantics` + `lint` + `validate` on compiled SQL |
| Column names/order don't match schema | Read compiled SQL + `{{RUNNER}} show` to verify output columns |
| Not querying actual data when debugging wrong results | Always run data exploration queries — check NULLs, value ranges, distinct values |
| Trusting build success as proof of correctness | Build only checks syntax and constraints — wrong values pass silently |

## How this maps (Option A)

| Step | Deterministic (CLI / MCP) | Claude reasons |
|------|---------------------------|----------------|
| Health check | `{{RUNNER}} debug` | — |
| Compile | `{{RUNNER}} compile --select` | — |
| Semantic/lint checks | `mcp__opende__check_semantics` + `lint` + `validate` on compiled SQL | Interprets findings, decides root cause |
| Column lineage | `mcp__opende__column_lineage` on compiled SQL (DETERMINISTIC) | — |
| Auto-fix proposals | `mcp__opende__fix` (fuzzy name mismatches) / `mcp__opende__correct` (iterative) | Decides which fix to apply |
| Fix verification | `{{RUNNER}} compile/build`, MCP re-check, `{{RUNNER}} show --inline` | — |
| Data exploration (ref-based queries) | `{{RUNNER}} show --inline` (resolves `{{ ref() }}`/Jinja) | Interprets query results |
| Data exploration (raw warehouse / fully-qualified tables) | `mcp__opende__execute` (raw SQL, safety-gated, no Jinja) | — |
| Quick column/type check | `mcp__opende__schema_inspect` | — |

Gate compiled files with `{{GATE_INVOCATION}} <files...>` before MCP calls. No `altimate run`, no TUI, no agent invocations.
