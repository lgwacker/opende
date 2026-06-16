---
name: schema-migration
description: Analyze DDL migrations for data loss risks — type narrowing, missing defaults, dropped constraints, breaking column changes. Now fully deterministic via `mcp__opende__analyze_migration` and `mcp__opende__diff_schemas`; `{{RUNNER}} ls --select` maps downstream impact.
---

# Schema Migration Analysis

## Requirements
**Model:** Claude (presents findings, contextual remediation advice)
**CLI:** `{{RUNNER}} ls --select`, `{{RUNNER}} show`, `bash` (git)
**MCP:** `mcp__opende__analyze_migration`, `mcp__opende__diff_schemas`, `mcp__opende__import_ddl`

## When to Use This Skill

**Use when the user wants to:**
- Analyze a DDL migration for data loss risks before applying it
- Compare two schema versions to find breaking changes
- Review ALTER TABLE / CREATE TABLE changes in a PR
- Validate that a model refactoring doesn't break the column contract

**Do NOT use for:**
- Writing new models — use `dbt-develop`
- Optimizing queries — use `query-optimize`

## Iron Rules

1. Never mark a column drop as safe without calling out that existing non-NULL values will be lost.
2. Type narrowing (VARCHAR(200) → VARCHAR(50)) is ALWAYS flagged — even if current data fits.
3. NOT NULL column additions without DEFAULT always fail on existing rows in SQL databases.
4. Cross-reference downstream models via `{{RUNNER}} ls --select <name>+` before declaring any breaking change safe.

## Workflow

### 1. Get the Schema Versions

**DDL migrations** (ALTER TABLE / CREATE TABLE files):
- Read the migration file from disk
- The "old" schema is the current state; the "new" schema is the state after applying the migration

**dbt model changes** — get the old version from git:
```bash
git show HEAD:models/<path/to/model.sql>
```
The new version is the current file on disk.

**Schema YAML changes:**
```bash
git show HEAD:models/<path/to/schema.yml>
```
Read both versions (old from git, new from disk).

### 2. Analyze Migration Safety (Deterministic)

Call `mcp__opende__analyze_migration` with the migration DDL/SQL. The engine returns:

- `overall_risk` — one of `safe` | `caution` | `dangerous` | `destructive`
- `findings[]` — each finding with category, severity, and description
- `rollback_sql` — generated rollback DDL for the migration

This replaces all manual Claude risk categorization. The risk table below is provided for reference and to interpret findings:

| Risk Category | Examples | Severity |
|---|---|---|
| **Dropped column** | `DROP COLUMN foo` | BREAKING — data loss |
| **Type narrowing** | VARCHAR(200) → VARCHAR(50), DECIMAL(18,2) → DECIMAL(10,2) | BREAKING — truncation |
| **NOT NULL without DEFAULT** | `ADD COLUMN x INT NOT NULL` | BREAKING — fails on existing rows |
| **Type incompatibility** | INT → VARCHAR | BREAKING — irreversible in practice |
| **Dropped constraint** | Remove UNIQUE / CHECK | WARNING — integrity risk |
| **Dropped index** | `DROP INDEX` | WARNING — performance regression |
| **Column rename** | Old name gone, similar new name | WARNING — check Levenshtein distance |
| **Type widening** | VARCHAR(50) → VARCHAR(200), DECIMAL(10) → DECIMAL(18) | SAFE |
| **New nullable column** | `ADD COLUMN x INT` | SAFE |
| **New column with DEFAULT** | `ADD COLUMN x INT DEFAULT 0` | SAFE |

### 3. Diff Two Schema Versions for Breaking Changes (Deterministic)

When comparing two DDL files or schema YAMLs, use `mcp__opende__diff_schemas` to get a structured list of breaking changes between old and new.

To convert a raw DDL file into a schema representation for `diff_schemas`, first call `mcp__opende__import_ddl` on the DDL content. This produces a normalized schema object that can be passed as input to `diff_schemas`.

### 4. Check Downstream Impact

```bash
{{RUNNER}} ls --select <name>+1 --output json
```

For each downstream model that exists, verify it doesn't reference a dropped or renamed column. Cross-reference with the `affected_downstream` output from `mcp__opende__diff_lineage` if a lineage diff was also run (see `lineage-diff` skill).

### 5. Present the Analysis

```
Schema Migration Analysis
=========================

Migration: alter_orders_table.sql
Dialect: snowflake
Overall Risk: DANGEROUS  (from mcp__opende__analyze_migration)

BREAKING CHANGES (2):
  [DATA LOSS] Dropped column: orders.discount_amount
    -> Column has non-NULL values. Data will be permanently lost.

  [TRUNCATION] Type narrowed: orders.customer_name VARCHAR(200) -> VARCHAR(50)
    -> Rows exceeding 50 chars will be truncated.

WARNINGS (1):
  [CONSTRAINT] Dropped unique constraint on orders.external_id
    -> Duplicates may be inserted after migration.

SAFE CHANGES (3):
  [ADD] New column: orders.updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  [ADD] New column: orders.version INTEGER DEFAULT 1
  [WIDEN] Type widened: orders.amount DECIMAL(10,2) -> DECIMAL(18,2)

Rollback SQL: [from analyze_migration.rollback_sql]

Downstream models affected: [list from {{RUNNER}} ls --select <name>+1]

Recommendation: DO NOT apply without addressing BREAKING changes.
  1. Back up discount_amount data before dropping
  2. Verify no values exceed 50 chars, or widen the target type
  3. Confirm external_id uniqueness is no longer required
```

## Usage

- `/schema-migration migrations/V003__alter_orders.sql` — Analyze a DDL migration file
- `/schema-migration models/staging/stg_orders.sql` — Compare current file against last commit
- `/schema-migration --old schema_v1.yml --new schema_v2.yml` — Compare two schema files

## How this maps (Option A)

**Fully deterministic:** `mcp__opende__analyze_migration` performs all data-loss risk categorization, type-narrowing detection, constraint analysis, and column-rename detection — returning `overall_risk` (safe/caution/dangerous/destructive), `findings[]`, and `rollback_sql`. `mcp__opende__diff_schemas` identifies breaking changes between two schema versions; `mcp__opende__import_ddl` converts raw DDL into a schema object for use with `diff_schemas`. `{{RUNNER}} ls --select <name>+1` maps downstream consumers of a changed model.

**Claude-reasoned:** Presenting findings in readable prose and contextual remediation advice tailored to the specific migration and deployment context.

See [OPENDE_CLI.md](../OPENDE_CLI.md).
