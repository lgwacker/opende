---
name: data-parity
description: Validate that two tables or query results are identical — profile and row diff via mcp__opende__data_diff (real DataParitySession via native Snowflake executor). Same-warehouse Snowflake supported; cross-warehouse is deferred (single dbt connection).
---

# Data Parity (Table Diff)

## CRITICAL: Regulated / Sensitive Data

This skill runs SQL against live tables. `mcp__opende__data_diff` returns up to 5 sample diff rows that appear in the conversation and are sent to the LLM provider.

Before running any diff against a table that might contain PII, PHI, PCI, or other regulated data:

1. **Ask the user** whether the target contains regulated columns.
2. If yes, prefer `algorithm: "profile"` — it compares column-level statistics (count, nulls, min/max, distinct count) **without any row values** leaving the database.
3. If a row-level diff is genuinely required, tell the user that up to 5 sample rows will appear in the conversation and get explicit approval before proceeding.
4. Consider scoping with a `where_clause` to exclude sensitive customers/accounts.

Default to `algorithm: "profile"` whenever the table name suggests regulated data (`customers`, `patients`, `orders`, `payments`, `accounts`, `users`, etc.) unless the user explicitly requests row-level comparison.

---

## CRITICAL: Always Start With a Plan

Before doing anything else, generate a numbered TODO list for the user:

```
Here's my plan:
1. [ ] Run schema structural diff (mcp__opende__diff_schemas) to detect breaking column changes
2. [ ] Inspect schema, discover primary key candidates, and detect auto-timestamp columns
3. [ ] Confirm primary keys with you
4. [ ] Confirm which auto-timestamp columns to exclude
5. [ ] Check row counts on both sides
6. [ ] Run column-level profile (algorithm:"profile" — aggregates only, no row scan)
7. [ ] If comparing refactored queries: run mcp__opende__check_equivalence before any row diff
8. [ ] Ask whether to proceed with row-level diff (may be expensive for large tables)
9. [ ] Run targeted row-level diff on diverging columns only via mcp__opende__data_diff
10. [ ] Present findings with scope, filters, columns compared/excluded, and assumptions
```

Update each item to `[x]` as you complete it.

---

## Step 1: Inspect Schema, Detect Structural Drift, and Discover Keys

First, run `mcp__opende__diff_schemas` on the two tables/models to catch breaking schema changes (added/removed columns, type changes) before doing any data-level work. If structural drift is found, surface it to the user immediately — data-level comparison may be misleading until schema issues are resolved.

Then inspect both tables to discover primary key candidates. Use `mcp__opende__schema_inspect` or `mcp__opende__execute`:

```
mcp__opende__schema_inspect  →  table: "<database>.<schema>.<table>"
```

Or via SQL:
```
mcp__opende__execute  →  sql: "
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = '<schema>' AND table_name = '<table>'
ORDER BY ordinal_position"
```

Look for: columns named `id`, `*_id`, `*_key`, `uuid`, or with NOT NULL + unique constraint.

Detect auto-timestamp columns — any column whose `column_default` contains a time-generating function (e.g., `CURRENT_TIMESTAMP()`, `SYSDATE()`, `now()`). Collect them for confirmation in Step 3.

If no obvious PK, run a cardinality check:
```
mcp__opende__execute  →  sql: "
SELECT COUNT(*) AS total_rows,
       COUNT(DISTINCT <candidate_col>) AS distinct_values
FROM <schema>.<table>",  limit: 1
```

For composite key candidates:
```
mcp__opende__execute  →  sql: "
SELECT <col1>, <col2>, COUNT(*) AS cnt
FROM <schema>.<table>
GROUP BY <col1>, <col2>
HAVING COUNT(*) > 1",  limit: 5
```
Zero rows returned → valid composite key.

---

## Step 2: Confirm Keys With the User

Always confirm before proceeding:
> "I identified `order_id` as the primary key (150,000 distinct values = 150,000 rows, no NULLs). Does that look right, or should I use a different column?"

Do not proceed until the user confirms.

---

## Step 3: Confirm Auto-Timestamp Column Exclusions

If auto-timestamp columns were detected, present them:
> "I found columns with auto-generating timestamp defaults that will inherently differ between source and target due to write timing. Should I exclude `created_at`, `updated_at` from the comparison? (In migration validation, you may want to *include* them to verify they were preserved.)"

Only exclude after explicit user confirmation.

---

## Step 4: Check Row Counts

```
mcp__opende__execute  →  sql: "SELECT COUNT(*) AS row_count FROM <source_table>",  limit: 1
mcp__opende__execute  →  sql: "SELECT COUNT(*) AS row_count FROM <target_table>",  limit: 1
```

If counts differ by more than 5%, flag it immediately before any column-level work.

---

## Step 5: Column-Level Profile (Always Run First)

Profile is cheap — aggregates only, no sample rows returned. Always run before any row-level diff.

```
mcp__opende__data_diff  →  {
  source: "<database>.<schema>.<source_table>",
  target: "<database>.<schema>.<target_table>",
  key_columns: ["<key_col>"],
  extra_columns: ["<col1>", "<col2>"],   // omit excluded columns
  algorithm: "profile"
}
```

The tool returns column-level statistics for both tables. Claude compares them side by side and identifies which columns diverge.

Example output interpretation:
```
Column Profile Comparison

  row_count:   source=150,000  target=149,950  <- DIFFER (count gap)
  amount_min:  source=10.00    target=10.01    <- DIFFER (rounding?)
  status_nulls: source=0       target=47       <- DIFFER (NULL mapping bug?)
  customer_id: match
```

---

## Step 6: Ask Before Row-Level Diff on Large Tables

After profiling, check row count and ask the user:

- **< 100K rows:** proceed automatically
- **100K – 10M rows:** "The table has 1.2M rows. Row-level diff will scan all rows. Do you want to proceed? You can also provide a WHERE clause to limit scope."
- **> 10M rows:** "The table has 50M rows. Full diff could be expensive. Options: (1) diff a recent window only using `where_clause`, (2) partition by date/key range, (3) proceed with full diff. Which would you prefer?"

---

## Step 6b: Equivalence Check for Refactored Queries (Optional)

If the user is validating a **refactored or migrated query** (same intent, rewritten SQL) rather than two live tables with independent data, use `mcp__opende__check_equivalence` first. Pass both SQL definitions; the tool returns whether they are semantically equivalent.

- If equivalent → no row-level diff needed; report the result and stop.
- If not equivalent → proceed to row-level diff to find where they diverge.

Skip this step when comparing two independently-populated tables (ETL source vs target).

---

## Step 7: Row-Level Diff

Use only the columns the profile identified as diverging. Pass them in `extra_columns` to keep the result focused. Let `mcp__opende__data_diff` choose the algorithm (default `auto`) or specify `joindiff` / `hashdiff`:

```
mcp__opende__data_diff  →  {
  source: "<database>.<schema>.<source_table>",
  target: "<database>.<schema>.<target_table>",
  key_columns: ["<key_col>"],
  extra_columns: ["<diverging_col1>", "<diverging_col2>"],
  algorithm: "auto",             // or "joindiff" / "hashdiff"
  where_clause: "<optional filter, e.g. created_at >= '2024-01-01'>"
}
```

The tool returns aggregate diff stats (rows only in source, only in target, updated) and up to 5 sample diff rows. Cross-warehouse comparison is not supported — both tables must be in the same Snowflake account (single dbt connection).

For large tables, always supply a `where_clause` to scope to a date window or key range.

---

## Step 8: Present Findings — Always Surface Context

Never present bare numbers. Always frame the result with full context.

Required elements in every result summary:
1. **Scope** — which tables/databases were compared
2. **Filters** — any `where_clause` applied (or "no filter — full table")
3. **Key columns** used
4. **Columns included and excluded** (and why)
5. **Method** — profile only, or profile + row-level diff (algorithm used)

Example:
```
## Data Parity Results

**Compared:** `analytics.orders` (source) vs `dwh.orders` (target)
**Scope:** `created_at >= '2024-01-01'` (Q1 2024 — 42,301 rows)
**Key:** `order_id`
**Columns compared:** `amount`, `status`, `customer_id`
**Columns excluded:** `created_at`, `updated_at` (auto-timestamp, per your confirmation)
**Method:** profile + row-level diff (algorithm: joindiff, via mcp__opende__data_diff)

### Result: DIFFER

| Metric | Value |
|--------|-------|
| Source rows | 42,301 |
| Target rows | 42,298 |
| Only in source | 3 |
| Only in target | 0 |
| Updated rows | 47 |

**Findings:**
- 3 rows in source missing from target → possible ETL delete propagation gap
- 47 rows have value differences in `amount` → check rounding or cast logic
```

### Pattern → Root Cause Guide

| Pattern | Root cause |
|---------|-----------|
| `only_in_source > 0`, target = 0 | ETL dropped rows — check filters, incremental logic |
| `only_in_target > 0`, source = 0 | Target has extra rows — dedup issue or wrong join |
| Updated rows > 0, counts match | Silent value corruption — check type casts, rounding |
| Row counts differ significantly | Load completeness — check ETL watermarks |

---

## Common Mistakes

| Mistake | Correct approach |
|---------|-----------------|
| Skipping the profile step and jumping to full row diff | Profile first — it's free and shows which columns actually differ |
| Running full diff on a billion-row table without asking | Always ask before expensive operations; offer `where_clause` filtering |
| Not confirming the key before diffing | A wrong key gives meaningless results — always confirm cardinality |
| Silently excluding auto-timestamp columns | Always ask the user — in migration validation, those columns should be identical |
| Omitting scope/filter context from results | "Tables are identical" without context is meaningless — always state what was checked |
| Running row-level diff without PII confirmation | Always ask about regulated data first; default to `algorithm:"profile"` |
| Expecting cross-warehouse diff to work | `mcp__opende__data_diff` requires both tables in the same Snowflake account |

---

## How this maps

| Step | What runs | Who reasons |
|------|-----------|-------------|
| Schema structural diff | `mcp__opende__diff_schemas` (deterministic) | Claude surfaces breaking changes |
| Schema inspection, cardinality checks, row counts | `mcp__opende__execute` or `mcp__opende__schema_inspect` (deterministic) | — |
| Column-level profile (aggregates) | `mcp__opende__data_diff` with `algorithm:"profile"` (deterministic) | Claude compares stats side-by-side |
| Equivalence check (refactored queries) | `mcp__opende__check_equivalence` (deterministic) | Claude interprets equivalence verdict |
| Row-level diff | `mcp__opende__data_diff` with `algorithm:"auto"/"joindiff"/"hashdiff"` (deterministic, via DataParitySession + native Snowflake executor) | Claude interprets aggregate stats and sample rows |
| Key identification | `mcp__opende__execute` cardinality queries | Claude reasons about results |
| Partition/scope recommendations | No CLI | Claude reasons from row counts |

`mcp__opende__data_diff` runs altimate-core's DataParitySession through the native Snowflake SDK executor (safety-gated, credentials from dbt profiles.yml). Same-warehouse Snowflake is fully supported; cross-warehouse diff is deferred (single dbt connection). The PII caution, key-confirmation step, auto-timestamp-exclusion confirmation, profile-first guidance, and "ask before scanning huge tables" guidance are fully preserved.

See [REFERENCE.md](../REFERENCE.md).
