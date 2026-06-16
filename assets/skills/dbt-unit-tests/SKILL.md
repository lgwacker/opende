---
name: dbt-unit-tests
description: Generate dbt unit tests for any model — seeds test scenarios via mcp__opende__generate_tests, assembles YAML with type-correct mock inputs, computes expected outputs via altimate-dbt execute, and writes complete YAML. Use when asked to "generate tests", "add unit tests", or "test this model".
---

# dbt Unit Test Generation

See [ALTIMATE_CLI.md](../ALTIMATE_CLI.md) for full CLI reference.

## When to Use This Skill

**Use when the user wants to:**
- Generate unit tests for a dbt model
- Add test coverage to an existing model
- Create mock data for testing
- Test-driven development (TDD) for dbt
- Verify CASE/WHEN logic, NULL handling, JOIN behavior, or aggregation correctness
- Test incremental model logic

**Do NOT use for:**
- Adding schema tests (not_null, unique, accepted_values) → use `dbt-test`
- Creating or modifying model SQL → use `dbt-develop`
- Writing descriptions → use `dbt-docs`
- Debugging build failures → use `dbt-troubleshoot`

## The Iron Rules

1. **Never guess expected outputs.** Compute them by running SQL against mock data when possible via `altimate-dbt execute`. If you cannot run SQL, clearly mark expected outputs as placeholders that need verification.
2. **Never skip upstream dependencies.** Every `ref()` and `source()` the model touches MUST have a mock input. Miss one and the test won't compile.
3. **Use sql format for ephemeral models.** Dict format fails silently for ephemeral upstreams.
4. **Never weaken a test to make it pass.** If the test fails, the model logic may be wrong. Investigate before changing expected values.
5. **Compile before committing.** Always run `altimate-dbt test --model <name>` to verify tests compile and execute.

## Core Workflow: Analyze → Generate → Refine → Validate → Write

### Phase 1: Analyze the Model

```bash
# 1. Compile to render Jinja and populate target/
altimate-dbt compile --model <name>

# 2. Read the model SQL (source + compiled)
# Source: models/<layer>/<name>.sql
# Compiled: target/compiled/<project>/models/<layer>/<name>.sql

# 3. Parse the manifest for dependencies
# Read target/manifest.json — look for nodes.<model_id>.depends_on.nodes
```

**What to look for:**
- Which upstream refs/sources does this model depend on?
- What SQL constructs need testing? (CASE/WHEN, JOINs, window functions, aggregations)
- What edge cases exist? (NULLs, empty strings, zero values, boundary dates)
- Is this an incremental model? (needs `is_incremental` override tests)
- Are any upstream models ephemeral? (need `format: sql`)

### Phase 2: Discover Columns for Mock Inputs

Claude reads `target/manifest.json` for `nodes.<id>.columns` to get type-correct column names. If columns are missing from the manifest, use the CLI:

```bash
# For model upstreams
{{RUNNER}} show --model <upstream_model_name>

# For source upstreams
{{RUNNER}} show-source --source <source_name> --table <table_name>
```

Use these real column names and types — never invent column names.

### Phase 3: Generate Tests (seeded by MCP, assembled by Claude)

1. **Seed with deterministic test ideas** using the compiled SQL:
   ```
   mcp__opende__generate_tests  { sql: "<compiled_sql>", dialect: "snowflake" }
   ```
   Returns `test_cases[]` — each with `name`, `category`, `description`, `inputs`, and `expected`. Use these as the authoritative seed for which scenarios to cover.

2. Claude assembles the dbt unit-test YAML from those `test_cases`, mapping each `inputs` → `given` rows and each `expected` → `expect` rows using the real column names discovered in Phase 2.

3. Scenarios are drawn from `generate_tests` output PLUS the standard categories below (happy path, NULLs, boundaries, edge cases, incremental). Do not invent scenarios that `generate_tests` marks as unsupported.

### Phase 4: Compute Expected Outputs

**Option A (preferred): Run SQL against mock CTEs in the warehouse**

```bash
# Build a CTE with mock data and run the model SQL against it
altimate-dbt execute --query "WITH mock_<upstream> AS (SELECT ...) <model_sql_body>" --limit 10
```

Use the actual output rows as your expected values.

**Option B: Manual computation**

Read the compiled SQL and trace through each logical branch with the mock inputs. Show your reasoning — do not silently guess.

**Option C: Use test run to discover actuals**

```bash
altimate-dbt test --model <name>
# Assertion errors show actual vs expected — use actual as expected if logic is correct
```

### Phase 5: Validate

```bash
# Run the unit tests
altimate-dbt test --model <name>

# If tests fail:
#   Compilation error? → Missing ref, wrong column name, type mismatch
#   Assertion error?   → Expected output doesn't match actual; trace logic again
# Fix and retry — max 3 iterations before stopping to investigate model SQL
```

### Phase 6: Write to File

```bash
# Check project convention first
find models -name "*unit_test*.yml" -o -name "*schema*.yml" | head -20
```

Place unit tests in:
- `models/<layer>/_unit_tests.yml` (dedicated file, preferred if convention exists)
- `models/<layer>/schema.yml` (append to existing, if that's the convention)

## Test Case Categories

| Category | When to Generate | Key Technique |
|----------|-----------------|---------------|
| Happy path | Always | 2+ rows, exercise main logic path |
| NULL handling | Any nullable column | Set nullable cols to NULL in last row; verify COALESCE/NVL behavior |
| Boundary values | Numeric/date logic | Zero amounts, empty strings, epoch dates, MAX values |
| Non-matching JOIN | LEFT JOIN present | Include unmatched rows, verify NULLs on right side |
| Duplicate key | Aggregations | Feed 2 rows with same key, verify dedup/aggregate |
| Incremental | Incremental model | Use `overrides.macros.is_incremental: true` |

## YAML Format Reference

```yaml
unit_tests:
  - name: test_<model>_<scenario>
    description: "What this test verifies"
    model: <model_name>
    overrides:                    # optional
      macros:
        is_incremental: true      # for incremental models
      vars:
        run_date: "2024-01-15"    # for date-dependent logic
    given:
      - input: ref('upstream_model')
        rows:
          - { col1: value1, col2: value2 }
      - input: source('source_name', 'table_name')
        rows:
          - { col1: value1 }
      - input: ref('ephemeral_model')
        format: sql
        rows: |
          SELECT 1 AS id, 'test' AS name
          UNION ALL
          SELECT 2 AS id, 'other' AS name
    expect:
      rows:
        - { output_col1: expected1, output_col2: expected2 }
```

Full YAML spec: [references/unit-test-yaml-spec.md](references/unit-test-yaml-spec.md)

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Missing a ref() in given | Parse `target/manifest.json` for ALL `depends_on.nodes` |
| Wrong column names in mock data | Use manifest columns or `{{RUNNER}} show` — never guess |
| Wrong data types | Use schema catalog types from manifest |
| Expected output is just mock input | Actually compute the transformation via `altimate-dbt execute` |
| Dict format for ephemeral model | Use `format: sql` with raw SQL |
| Not testing NULL path in COALESCE | Add null_handling test case explicitly |
| Hardcoded dates with current_timestamp | Use `overrides.macros` to mock timestamps |
| Testing trivial pass-through | Skip models with no logic (pure renames/selects) |

## How this maps (Option A)

| Step | Deterministic (CLI / MCP) | Claude reasons |
|------|--------------------------|----------------|
| Compile model | `altimate-dbt compile --model <m>` | — |
| Parse dependencies | Read `target/manifest.json` | Identifies all refs/sources |
| Discover columns | `{{RUNNER}} show` / `columns-source` | — |
| Test seed | `mcp__opende__generate_tests` on compiled SQL (deterministic) | — |
| Assemble YAML | — | Maps `test_cases[]` to dbt unit-test YAML |
| Compute expected outputs | `altimate-dbt execute` (mock CTEs) | Refines expected values from actual output |
| Validation | `altimate-dbt test --model <m>` | Interprets failures |

Reference guides:
- [unit-test-yaml-spec.md](references/unit-test-yaml-spec.md)
- [edge-case-patterns.md](references/edge-case-patterns.md)
- [incremental-testing.md](references/incremental-testing.md)
