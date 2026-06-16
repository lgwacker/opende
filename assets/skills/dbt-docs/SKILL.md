---
name: dbt-docs
description: Document dbt models and columns in schema.yml with business context — model descriptions, column definitions, and doc blocks. Use when adding or improving documentation for discoverability. Deterministic CLI only (no altimate agent).
---

# dbt Documentation

## Requirements
**Agent:** Claude Code (file write access required)
**Tools used:** bash (`dbt`), MCP (`mcp__opende__*`), Read, Glob, Write, Edit

See [REFERENCE.md](../REFERENCE.md) for the full CLI reference.

## When to Use This Skill

**Use when the user wants to:**
- Add or improve model descriptions in schema.yml
- Write column-level descriptions with business context
- Create shared doc blocks for reusable definitions
- Improve dbt docs site content

**Do NOT use for:**
- Adding tests → use `dbt-test`
- Creating new models → use `dbt-develop`
- Generating sources.yml from scratch → use `dbt-develop`

## Workflow

### 1. Understand the Model

```bash
{{RUNNER}} show --select <name> --limit 10 --output json     # what columns exist
{{RUNNER}} ls --select +1<name> --output json                # what feeds this model
{{RUNNER}} ls --select <name>+1 --output json               # who consumes it
{{RUNNER}} compile --select <name>            # render the SQL (resolves Jinja)
```

After compiling, gate the file and call MCP tools to extract structural metadata:
```bash
{{GATE_INVOCATION}} target/compiled/.../models/<name>.sql
```
```
mcp__opende__extract_metadata  compiled SQL   # DETERMINISTIC — tables, columns, joins, CTEs
mcp__opende__column_lineage    compiled SQL   # DETERMINISTIC — per-column source/transform map
```
These replace manual SQL reading for derivation understanding. Claude still authors all descriptions (see Step 3).

### 2. Read Existing Documentation

Check what's already documented:
```bash
glob models/**/*schema*.yml models/**/*_models.yml
# then Read <yaml_file>
```

### 3. Write Documentation

See [references/documentation-standards.md](references/documentation-standards.md) for quality guidelines.

Claude authors all descriptions by reasoning over the `mcp__opende__extract_metadata` and `mcp__opende__column_lineage` output, column metadata, parent/child relationships, and any existing YAML context. Description authoring is Claude's job — no LLM agent call needed.

#### Model-Level Description
Cover: **What** (business entity), **Why** (use case), **How** (key transforms), **When** (materialization).

```yaml
- name: fct_daily_revenue
  description: >
    Daily revenue aggregation by product category. Joins staged orders with
    product dimensions and calculates gross/net revenue. Materialized as
    incremental with unique key on (date_day, category_id). Used by the
    finance team for daily P&L reporting.
```

#### Column-Level Description
Describe business meaning, derivation formula, and caveats:

```yaml
columns:
  - name: net_revenue
    description: >
      Total revenue minus refunds and discounts for the day.
      Formula: gross_revenue - refund_amount - discount_amount.
      Can be negative if refunds exceed sales.
```

### 4. Validate

```bash
{{RUNNER}} compile --select <name>    # ensure YAML is syntactically valid
```

No SQL quality checks are required for docs-only changes (no SQL is modified). If you want to confirm column names in the YAML match the compiled output, compare `{{RUNNER}} show --select <name> --limit 10` against your YAML.

## How this maps (Option A)

| What stays deterministic (CLI / MCP) | What Claude reasons |
|--------------------------------------|---------------------|
| `{{RUNNER}} compile/show/ls` | Authoring model and column descriptions |
| `mcp__opende__extract_metadata` on compiled SQL | — (DETERMINISTIC structural extraction) |
| `mcp__opende__column_lineage` on compiled SQL | — (DETERMINISTIC derivation map) |

Gate compiled files with `{{GATE_INVOCATION}} <files...>` before MCP calls. Description authoring remains Claude's job throughout.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Restating the column name as the description | `"order_id: The order ID"` → describe business meaning |
| Empty descriptions | Every column should have a description. If unsure, describe the source. |
| Not reading the SQL before documenting | Compile and read the model to understand derivation logic |
| Duplicating descriptions across models | Use doc blocks for shared definitions |
| Writing implementation details instead of business context | Describe what it means to the business, not how it's computed |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [REFERENCE.md](../REFERENCE.md) | Full CLI reference for `dbt` and MCP tools |
| [REFERENCE.md](../REFERENCE.md) | dbt CLI command reference |
| [references/documentation-standards.md](references/documentation-standards.md) | Writing high-quality descriptions |
