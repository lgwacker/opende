---
name: dbt-test
description: Add schema tests, unit tests, and data quality checks to dbt models. Use when validating data integrity, adding test definitions to schema.yml, writing unit tests, or practicing test-driven development in dbt. Deterministic CLI only (no altimate agent).
---

# dbt Testing

## Requirements
**Agent:** Claude Code (file write access required)
**Tools used:** bash (`dbt`), MCP (`mcp__opende__generate_tests`, `mcp__opende__validate`, `mcp__opende__lint`), Read, Glob, Write, Edit

See [REFERENCE.md](../REFERENCE.md) for the full CLI reference.

## When to Use This Skill

**Use when the user wants to:**
- Add tests to a model's schema.yml (unique, not_null, relationships, accepted_values)
- Write dbt unit tests (mock inputs → expected outputs)
- Create custom generic or singular tests
- Debug why a test is failing
- Practice test-driven development in dbt

**Do NOT use for:**
- Creating or modifying model SQL → use `dbt-develop`
- Writing model descriptions → use `dbt-docs`
- Debugging build/compilation errors → use `dbt-troubleshoot`

## The Iron Rule

**Never modify a test to make it pass without understanding why it's failing.**

A failing test is information. It means either:
1. The data has a real quality issue (fix the data or the model)
2. The test expectation is wrong (update the test with justification)
3. The model logic is wrong (fix the model)

Option 2 requires explicit user confirmation. Do not silently weaken tests.

## Schema Test Workflow

### 1. Discover Columns

```bash
{{RUNNER}} show --select <name> --limit 10 --output json
{{RUNNER}} show --inline "SELECT DISTINCT <col>, count(*) FROM {{ ref('<name>') }} GROUP BY 1 ORDER BY 2 DESC" --limit 20 --output json
```

### 2. Read Existing Tests

```bash
glob models/**/*schema*.yml models/**/*_models.yml
# then Read <yaml_file>
```

### 3. Generate Tests

1. Compile the model to get plain SQL:
   ```bash
   {{RUNNER}} compile --select <name>
   # compiled SQL lands in target/compiled/.../models/<name>.sql
   ```
2. Read the compiled SQL and the column list (`{{RUNNER}} show --select`).

3. **Gate check** — Run the gate before invoking MCP tools on any file:
   ```bash
   {{GATE_INVOCATION}} target/compiled/.../models/<name>.sql
   ```

4. **Seed test ideas** (DETERMINISTIC):
   ```
   mcp__opende__generate_tests  { sql: "<compiled_sql>", dialect: "snowflake" }
   ```
   Returns `test_cases[]` with `name`, `category`, `description`, `inputs`, and `expected`. Use these as the authoritative list of schema-test candidates.

5. Claude maps `test_cases[]` to dbt schema tests:
   - Column names and types → `not_null`, `unique`
   - `{{RUNNER}} show --inline` distinct values output → `accepted_values`
   - FK references visible in the SQL → `relationships`
   - Business rules stated in the task or existing YAML descriptions

Review the proposed tests — keep what makes sense, discard trivial ones. Apply test rules based on column patterns — see [references/schema-test-patterns.md](references/schema-test-patterns.md).

### 4. Write YAML

Merge into existing schema.yml (don't duplicate). Use Edit for existing files, Write for new ones.

### 5. Validate Compiled SQL

Before running, check the compiled SQL for syntax and schema errors (DETERMINISTIC):
```
mcp__opende__validate  { sql: "<compiled_sql>", dialect: "snowflake" }
mcp__opende__lint      { sql: "<compiled_sql>", dialect: "snowflake" }
```
Claude reads the findings and addresses any errors or warnings that affect test correctness.

### 6. Run Tests

```bash
{{RUNNER}} test --select <name>     # run tests for this model
{{RUNNER}} build --select <name>    # build + test together
```

## Unit Test Workflow

**For automated unit test generation, use the `dbt-unit-tests` skill instead.** It analyzes model SQL, generates type-correct mock data, and assembles complete YAML automatically.

See [references/unit-test-guide.md](references/unit-test-guide.md) for the full unit test framework.

### Quick Pattern

```yaml
unit_tests:
  - name: test_order_total_calculation
    model: fct_orders
    given:
      - input: ref('stg_orders')
        rows:
          - { order_id: 1, quantity: 3, unit_price: 10.00 }
          - { order_id: 2, quantity: 1, unit_price: 25.00 }
    expect:
      rows:
        - { order_id: 1, order_total: 30.00 }
        - { order_id: 2, order_total: 25.00 }
```

## How this maps (Option A)

| What stays deterministic (CLI / MCP) | What Claude reasons |
|--------------------------------------|---------------------|
| `{{RUNNER}} compile/test/build/show` | — |
| `mcp__opende__generate_tests` on compiled SQL | Maps `test_cases[]` to dbt schema-test YAML |
| `mcp__opende__validate` + `mcp__opende__lint` on compiled SQL | Selects which findings suggest missing tests |
| `{{RUNNER}} test --select <name>` (fail output) | Diagnosing root cause of test failures |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Testing every column with `not_null` | Only test columns that should never be null. Think about what NULL means. |
| Missing `unique` test on primary keys | Every primary key needs `unique` + `not_null` |
| `accepted_values` with incomplete list | Use `{{RUNNER}} show --inline` to discover real values first |
| Modifying a test to make it pass | Understand WHY it fails first. The test might be right. |
| No `relationships` test on foreign keys | Add `relationships: {to: ref('parent'), field: parent_id}` |
| Unit testing trivial logic | Don't unit test `SELECT a, b FROM source`. Test calculations and business logic. |
| Running MCP tools on raw `.sql` with Jinja | Always compile first — MCP tools need plain SQL |

## Reference Guides

| Guide | Use When |
|-------|----------|
| [REFERENCE.md](../REFERENCE.md) | Full CLI reference for `dbt` and MCP tools |
| [REFERENCE.md](../REFERENCE.md) | dbt CLI command reference |
| [references/schema-test-patterns.md](references/schema-test-patterns.md) | Adding schema.yml tests by column pattern |
| [references/unit-test-guide.md](references/unit-test-guide.md) | Writing dbt unit tests |
| [references/custom-tests.md](references/custom-tests.md) | Creating generic or singular tests |
