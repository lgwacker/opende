---
name: pii-audit
description: Classify schema columns for PII (SSN, email, phone, name, address, credit card) and check whether queries expose them. Both schema-wide classification and per-query exposure are now fully deterministic via MCP tools.
---

# PII Audit

## Requirements
**Model:** Claude (report synthesis)
**CLI:** `{{RUNNER}} show`, `{{RUNNER}} show-source`, `altimate-dbt compile`
**MCP:** `mcp__opende__classify_pii`, `mcp__opende__check_query_pii`, `mcp__opende__schema_search`, `mcp__opende__schema_inspect`, `mcp__opende__execute`

## When to Use This Skill

**Use when the user wants to:**
- Scan a database schema for PII columns (SSN, email, phone, name, address, credit card, IP)
- Check if a specific query exposes PII data
- Audit dbt models for PII leakage before production deployment
- Generate a PII inventory for compliance (GDPR, CCPA, HIPAA)

**Do NOT use for:**
- SQL injection scanning — use `sql-review`
- General SQL quality checks — use `sql-review`

## Iron Rules

1. Never flag a column as safe solely because its name is innocuous — check type + context too.
2. Compiled SQL (Jinja-resolved) must be used for query-level checks; raw dbt model SQL with `{{ ref() }}` gives inaccurate results.
3. Always distinguish **exposed in SELECT** (HIGH risk) vs **used only in WHERE/JOIN** (MEDIUM risk) — the latter doesn't appear in downstream results.

## Workflow

### 1. Classify Schema for PII (Deterministic)

Call `mcp__opende__classify_pii` — it auto-resolves the dbt schema from `target/catalog.json` and returns a structured result:

- `columns[]` — each column with its detected PII category
- `pii_count` — total PII columns found
- `risk_level` — overall schema risk level
- `suggested_masking` — recommended masking strategy per column

Supply column metadata from `{{RUNNER}} show` or `{{RUNNER}} show-source` as input if a specific model or source is the target:

```bash
{{RUNNER}} show --model <model_name>
# or for a source:
{{RUNNER}} show-source --source <source_name> --table <table_name>
```

**Alternative — live warehouse schema discovery** (faster when the catalog is stale or the target is a raw source table):

- `mcp__opende__schema_search {query}` — keyword search across the indexed dbt schema to find tables/columns by name or description (offline, no warehouse hit).
- `mcp__opende__schema_inspect {table, schema_name?}` — fetch live column names and types directly from `information_schema` for a fully-qualified table.

Use `schema_search` first to locate relevant tables, then `schema_inspect` to enumerate their columns before passing them to `classify_pii`.

Refresh the catalog before running if it may be stale: `dbt docs generate`.

PII taxonomy (used by the engine):
- **HIGH — direct identifiers**: SSN, email, phone, full name, credit card number
- **MEDIUM — quasi-identifiers**: date of birth, zip code, IP address, device ID
- **SENSITIVE**: salary, health records, religious affiliation

**Common Mistakes**

| Mistake | Correct approach |
|---|---|
| Skipping columns with vague names like `field_1` | Engine inspects type + context; review low-confidence results manually |
| Treating masked/hashed columns as non-PII | Engine will flag them — add note "hashed — confirm irreversibility" |
| Missing PII in nested JSON fields | Compile the model first; pass compiled SQL so nested expressions are visible |
| Classifying columns without seeing real values | Sample actual data with `mcp__opende__execute` to confirm (see Step 1b) |

**Step 1b: Confirm suspected PII with actual data samples**

After identifying candidate columns via `classify_pii` or `schema_inspect`, verify with live samples using `mcp__opende__execute`. Use fully-qualified table names — this tool runs raw SQL directly on Snowflake and does **not** resolve `{{ ref() }}` / Jinja.

```
mcp__opende__execute {
  "sql": "SELECT <col> FROM <database>.<schema>.<table> LIMIT 20"
}
```

Use this to confirm whether a flagged column actually contains sensitive values (e.g. real emails vs. a column named `email` that holds only NULLs or synthetic data). Do **not** use `altimate-dbt execute` here — that is for dbt-model-scoped queries that need ref() resolution.

### 2. Check Query PII Exposure (Deterministic)

For each dbt model, compile first so Jinja is resolved, then call `mcp__opende__check_query_pii` on the compiled SQL:

```bash
altimate-dbt compile --model <name>
# compiled SQL: target/compiled/<project>/<path>.sql
```

`mcp__opende__check_query_pii` flags columns matching PII categories appearing in SELECT, WHERE, or JOIN clauses and distinguishes exposure level.

For batch runs, use the project gate script:
```bash
{{GATE_INVOCATION}} \
  target/compiled/<project>/models/**/*.sql --fail-on warning
```

### 3. Audit dbt Models (Batch)

1. Find all models: `find models/ -name '*.sql'`
2. Compile each: `altimate-dbt compile --model <name>`
3. Call `mcp__opende__check_query_pii` on each compiled file
4. Call `mcp__opende__classify_pii` for schema-wide column classification
5. Claude aggregates results into a risk matrix

### 4. Present the Audit Report

```
PII Audit Report
================

Models audited: 12  |  Sources scanned: 4

PII Columns Found (mcp__opende__classify_pii — DETERMINISTIC):

HIGH RISK (direct identifiers):
  customers.email          -> EMAIL       [suggested masking: hash]
  customers.phone_number   -> PHONE       [suggested masking: tokenize]
  payments.card_number     -> CREDIT_CARD [suggested masking: vault]

MEDIUM RISK (quasi-identifiers):
  customers.date_of_birth  -> DOB
  events.ip_address        -> IP_ADDRESS

Model PII Exposure (mcp__opende__check_query_pii — DETERMINISTIC):

| Model | PII Columns Exposed | Risk | Action |
|-------|---------------------|------|--------|
| stg_customers | email, phone | HIGH | Mask or hash before mart layer |
| mart_user_profile | email | HIGH | Requires access control |
| int_order_summary | (none) | SAFE | No PII in output |
| mart_daily_revenue | ip_address | MEDIUM | Aggregation reduces risk |

Recommendations:
1. Hash SSN and credit_card in staging layer (never expose raw)
2. Add column-level masking policy for email and phone
3. Restrict mart_user_profile to authorized roles only
4. Document PII handling in schema.yml column descriptions
```

## Usage

- `/pii-audit` — Scan the full project schema for PII
- `/pii-audit models/marts/mart_customers.sql` — Check a specific model for PII exposure
- `/pii-audit --schema analytics.public` — Audit a specific database schema (uses `columns-source`)

## How this maps (Option A)

**Fully deterministic:** Schema-wide column classification uses `mcp__opende__classify_pii`, which auto-resolves the dbt schema from `target/catalog.json` and returns `columns[]`, `pii_count`, `risk_level`, and `suggested_masking` without any LLM reasoning. Per-query PII exposure detection uses `mcp__opende__check_query_pii` on compiled SQL. The project gate script handles batch runs. Schema discovery can be accelerated with `mcp__opende__schema_search` (offline keyword search) and `mcp__opende__schema_inspect` (live `information_schema` column fetch). Sampling actual column values to confirm PII uses `mcp__opende__execute` with a fully-qualified table name and a small LIMIT — raw SQL only, no Jinja/ref().

**Claude-reasoned:** Report synthesis, contextual remediation advice, and reviewing low-confidence classify_pii results where business context matters.

See [ALTIMATE_CLI.md](../ALTIMATE_CLI.md).
