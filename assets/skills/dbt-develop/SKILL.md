---
name: dbt-develop
description: Create and modify dbt models — staging, intermediate, marts, incremental, medallion architecture. Use when building new SQL models, extending existing ones, scaffolding YAML configs, or reorganizing project structure. Deterministic CLI only (no altimate agent).
---

# dbt Model Development

## Requirements
**Agent:** Claude Code (file write access required)
**Tools used:** bash (`altimate-dbt`, `git`), MCP (`mcp__opende__*`), Read, Glob, Write, Edit

See [ALTIMATE_CLI.md](../ALTIMATE_CLI.md) for the full CLI reference.

## When to Use This Skill

**Use when the user wants to:**
- Create a new dbt model (staging, intermediate, mart, OBT)
- Add or modify SQL logic in an existing model
- Generate sources.yml or schema.yml from warehouse metadata
- Reorganize models into layers (staging/intermediate/mart or bronze/silver/gold)
- Convert a model to incremental materialization
- Scaffold a new dbt project structure

**Do NOT use for:**
- Adding tests to models → use `dbt-test`
- Writing model/column descriptions → use `dbt-docs`
- Debugging build failures → use `dbt-troubleshoot`
- Analyzing change impact → use `dbt-analyze`

## Core Workflow: Plan → Discover → Write → Validate

### 1. Plan — Understand Before Writing

Before writing any SQL:
- Read the task requirements carefully
- Identify which layer this model belongs to (staging, intermediate, mart)
- Check existing models for naming conventions and patterns
- **Check dependencies:** If `packages.yml` exists, check for `dbt_packages/` or `package-lock.yml`. Only run `altimate-dbt deps` if packages are declared but not yet installed.

```bash
altimate-dbt info                           # project name, adapter type
altimate-dbt parents --model <upstream>     # understand what feeds this model
altimate-dbt children --model <downstream>  # understand what consumes it
```

**Check warehouse connection:** Read `profiles.yml` directly and run `altimate-dbt info` to discover the active profile, adapter type (Snowflake, BigQuery, Postgres, etc.), and target — essential for dialect-aware SQL.

### 2. Discover — Understand the Data Before Writing

**Never write SQL without deeply understanding your data first.** The #1 cause of wrong results is writing SQL blind — assuming grain, relationships, column names, or values without checking.

**Step 2a: Find relevant tables and columns**
- Read `sources.yml`, `schema.yml`, and any YAML files that describe the source/parent models
- These contain column descriptions, data types, tests, and business context
- Pay special attention to: primary keys, unique constraints, relationships between tables, and what each column represents
- Claude reasons over these YAML files to map the schema — no external index needed
- **Live warehouse alternatives:**
  - `mcp__opende__schema_search {query}` — keyword search across the indexed dbt schema to find tables or columns by name/description (offline, instant).
  - `mcp__opende__schema_inspect {table, schema_name?}` — fetch live column names and types from `information_schema` for any fully-qualified table (useful for raw source tables not yet in YAML).

**Step 2b: Understand the grain of each parent model/source**
- What does one row represent? (one customer? one event? one day per customer?)
- What are the primary/unique keys?
- This is critical for JOINs — joining on the wrong grain causes fan-out or missing rows

```bash
{{RUNNER}} show --model <name>                         # existing model columns
{{RUNNER}} show-source --source <src> --table <tbl>    # source table columns
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('model') }}" --limit 1   # resolves ref()/Jinja
altimate-dbt execute --query "SELECT * FROM {{ ref('model') }}" --limit 5
altimate-dbt column-values --model <name> --column <col>    # sample values for key columns
```

**Raw warehouse profiling** (use `mcp__opende__execute` for fully-qualified tables, `information_schema`, or when Jinja resolution is not needed — it does NOT resolve `{{ ref() }}`):
```
mcp__opende__execute {"sql": "SELECT * FROM <db>.<schema>.<table> LIMIT 5"}
mcp__opende__execute {"sql": "SELECT count(*), count(DISTINCT <pk>) FROM <db>.<schema>.<table>"}
mcp__opende__execute {"sql": "SELECT min(<col>), max(<col>) FROM <db>.<schema>.<table>"}
```

**Step 2c: Query the actual data to verify your understanding**
- Check row counts, NULLs, date ranges, cardinality of key columns
- Verify foreign key relationships actually hold
- Check for duplicates in what you think are unique keys

**Step 2d: Read existing models that your new model will reference**
- Read the actual SQL of parent models — understand their logic, filters, and transformations
- Read 2-3 existing models in the same directory to match patterns and conventions

```bash
# Find all model files, then read relevant ones
glob models/**/*.sql
```

### 3. Write — Follow Layer Patterns

See [references/layer-patterns.md](references/layer-patterns.md) for staging/intermediate/mart templates.
See [references/medallion-architecture.md](references/medallion-architecture.md) for bronze/silver/gold patterns.
See [references/incremental-strategies.md](references/incremental-strategies.md) for incremental materialization.
See [references/yaml-generation.md](references/yaml-generation.md) for sources.yml and schema.yml.

### 4. Validate — Build, Verify, Check Impact

Never stop at writing the SQL. Always validate:

**Build it:**
```bash
altimate-dbt compile --model <name>    # catch Jinja errors; writes compiled SQL to target/
altimate-dbt build --model <name>      # materialize + run tests
```

**Run SQL quality checks on the compiled output** (`target/compiled/.../models/<name>.sql`):

Gate the compiled file first, then call the MCP tools:
```bash
{{GATE_INVOCATION}} target/compiled/.../models/<name>.sql
```
```
mcp__opende__lint          compiled SQL   # style, naming, anti-patterns
mcp__opende__validate      compiled SQL   # structural correctness, column references
mcp__opende__check_semantics compiled SQL # wrong joins, cartesian products, NULL comparisons
```
Claude interprets findings from all three tools and decides what to fix — description authoring and fix decisions remain Claude's job.

**Verify the output:**
```bash
{{RUNNER}} show --model <name>    # confirm expected columns exist
altimate-dbt execute --query "SELECT count(*) FROM {{ ref('<name>') }}" --limit 1
altimate-dbt execute --query "SELECT * FROM {{ ref('<name>') }}" --limit 10
```
- Do the columns match what schema.yml or the task expects?
- Does the row count make sense? (no fan-out from bad joins, no missing rows)
- Are values correct? (spot-check NULLs, aggregations, date ranges)

**Trace column flow** (complex JOINs or multi-CTE models):
```
mcp__opende__column_lineage  compiled SQL   # DETERMINISTIC — returns per-column source/transform map
```
Pass the compiled SQL (from `target/compiled/.../models/<name>.sql`). Use `altimate-dbt parents/children/columns` for model-graph structure; `mcp__opende__column_lineage` for column-level flow.

**Check downstream impact** (when modifying an existing model):
```bash
altimate-dbt children --model <name>                    # who depends on this?
altimate-dbt build --model <name> --downstream          # rebuild downstream to catch breakage
```

## How this maps (Option A)

| What stays deterministic (CLI / MCP) | What Claude reasons |
|--------------------------------------|---------------------|
| `altimate-dbt compile/build/run/test/execute/columns/column-values/parents/children/info/deps` | Layer selection, SQL authoring, naming conventions |
| `mcp__opende__lint` + `validate` + `check_semantics` on compiled SQL | Interpreting findings, deciding fixes |
| `mcp__opende__column_lineage` on compiled SQL | — (DETERMINISTIC, not Claude-derived) |
| `mcp__opende__schema_search` — offline keyword search over indexed dbt schema | — |
| `mcp__opende__schema_inspect` — live `information_schema` column fetch | — |
| `mcp__opende__execute` — raw SQL on Snowflake (no Jinja/ref; use `altimate-dbt execute` when ref() is needed) | Interprets profiling results |
| Reading `profiles.yml`, `target/manifest.json`, `*.yml` | Schema search / natural-language table discovery |
| `git diff --name-only` | — |

Gate compiled files with `{{GATE_INVOCATION}} <files...>` before MCP calls. No `altimate run`, no TUI, no agent invocations.

## Iron Rules

1. **Never write SQL without reading the source columns first.** Use `{{RUNNER}} show` or `{{RUNNER}} show-source`.
2. **Never stop at compile.** Always `altimate-dbt build` to catch runtime errors.
3. **Match existing patterns.** Read 2-3 existing models in the same directory before writing.
4. **One model, one purpose.** A staging model should not contain business logic. An intermediate model should not be materialized as a table unless it has consumers.
5. **Fix ALL errors, not just yours.** After creating/modifying models, run a full `altimate-dbt build`. If ANY model fails — even pre-existing ones you didn't touch — fix them. Leave the project in a fully working state.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Writing SQL without checking column names | Run `{{RUNNER}} show` or `{{RUNNER}} show-source` first |
| Stopping at `compile` — "it compiled, ship it" | Always `altimate-dbt build` to materialize and run tests |
| Hardcoding table references instead of `{{ ref() }}` | Always use `{{ ref('model') }}` or `{{ source('src', 'table') }}` |
| Creating a staging model with JOINs | Staging = 1:1 with source. JOINs belong in intermediate or mart |
| Not checking existing naming conventions | Read existing models in the same directory first |
| Using `SELECT *` in final models | Explicitly list columns for clarity and contract stability |
| Running MCP tools on raw `.sql` with Jinja | Always compile first — MCP tools need plain SQL (no Jinja) |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [ALTIMATE_CLI.md](../ALTIMATE_CLI.md) | Full CLI reference for `altimate-dbt` and MCP tools |
| [references/layer-patterns.md](references/layer-patterns.md) | Creating staging, intermediate, or mart models |
| [references/medallion-architecture.md](references/medallion-architecture.md) | Organizing into bronze/silver/gold layers |
| [references/incremental-strategies.md](references/incremental-strategies.md) | Converting to incremental materialization |
| [references/yaml-generation.md](references/yaml-generation.md) | Generating sources.yml or schema.yml |
| [references/common-mistakes.md](references/common-mistakes.md) | Extended anti-patterns catalog |
