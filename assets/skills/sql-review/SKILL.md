---
name: sql-review
description: Pre-merge SQL quality gate — lint 26 anti-patterns, grade readability/performance A-F, validate syntax, and scan for injection threats. Fully deterministic via MCP tools; Claude presents the findings.
---

# SQL Review

## Requirements
**Model:** Claude (reads output, presents findings)
**CLI:** `{{RUNNER}} compile --select`, project gate script, `bash` (git)
**MCP:** `mcp__opende__lint`, `mcp__opende__validate`, `mcp__opende__scan_sql`, `mcp__opende__check_query_pii`, `mcp__opende__check_semantics`, `mcp__opende__evaluate`

## When to Use This Skill

**Use when the user wants to:**
- Review SQL quality before merging a PR
- Get a quality grade (A-F) on a query or model
- Run a comprehensive lint + safety + syntax check in one pass
- Audit SQL files in a directory for anti-patterns

**Do NOT use for:**
- Optimizing query performance — use `query-optimize`
- Fixing broken SQL — use `dbt-troubleshoot`
- Translating between dialects — use `sql-translate`

## Workflow

### 1. Collect SQL to Review

Either read the file path the user provides, accept SQL pasted into the conversation, or auto-detect changed SQL files from git:

```bash
git diff --name-only HEAD~1 | grep '\.sql$'
```

For dbt models, compile first so Jinja is resolved before checking:

```bash
{{RUNNER}} compile --select <name>
# compiled output lands in target/compiled/<project>/<path>.sql
```

### 2. Run the Check

**Single query or model** — call these MCP tools on the compiled SQL:

- `mcp__opende__lint` — 26 anti-pattern rules with code/severity/suggestion
- `mcp__opende__validate` — parse errors with line/column
- `mcp__opende__scan_sql` — injection vectors and destructive-op risks
- `mcp__opende__check_query_pii` — columns matching PII categories
- `mcp__opende__check_semantics` — cartesian products, NULL-comparison issues, wrong joins
- `mcp__opende__evaluate` — A-F quality score with per-category breakdown

Schema-aware tools (`lint`, `check_semantics`, `evaluate`) auto-resolve the dbt schema from `target/catalog.json`. Refresh with `dbt docs generate` if the catalog is stale. Pass compiled SQL (from `{{RUNNER}} compile --select`) for Jinja models.

**Batch / PR review — use the project gate script** (handles exit codes and JSON stripping):
```bash
{{GATE_INVOCATION}} <files...> [--fail-on warning]
```

### 3. Present the Review

```
SQL Review: <file_or_query_name>
==============================

Grade: B+ (82/100)
  Readability:  A  (clear CTEs, good naming)
  Performance:  B- (missing partition filter on large table)
  Correctness:  A  (proper NULL handling)
  Best Practices: C (SELECT * in staging model)

Issues Found: 3
  [HIGH]   SELECT_STAR — Use explicit column list for contract stability
  [MEDIUM] MISSING_PARTITION_FILTER — Add date filter to avoid full scan
  [LOW]    IMPLICIT_CAST — VARCHAR compared to INTEGER on line 23

Safety: PASS (no injection vectors detected)
PII: PASS (no PII columns exposed)

Verdict: Fix HIGH issues before merging. MEDIUM issues are recommended.
```

### 4. Batch Mode

When reviewing multiple files (e.g., all changed SQL in a PR), present a summary table:

```
| File | Grade | Issues | Safety | Verdict |
|------|-------|--------|--------|---------|
| stg_orders.sql   | A  | 0 | PASS | Ship       |
| int_revenue.sql  | B- | 2 | PASS | Fix HIGH   |
| mart_daily.sql   | C  | 5 | WARN | Block      |
```

## Usage

- `/sql-review models/marts/fct_orders.sql` — Review a specific file
- `/sql-review` — Review all SQL files changed in the current git diff
- `/sql-review --all models/` — Review all SQL files in a directory

## How this maps (Option A)

**Fully deterministic:** Every check in Step 2 is performed by dedicated MCP tools (or the project gate script for batch/PR). `mcp__opende__lint` produces lint codes; `mcp__opende__validate` catches parse errors; `mcp__opende__scan_sql` flags injection vectors; `mcp__opende__check_query_pii` detects PII exposure; `mcp__opende__check_semantics` catches semantic issues; `mcp__opende__evaluate` computes the A-F grade. No LLM reasoning is involved in producing these results.

**Claude-reasoned:** Presenting findings in readable prose, deciding which issues are blockers for a given PR context, and suggesting remediation wording.

See [REFERENCE.md](../REFERENCE.md).
