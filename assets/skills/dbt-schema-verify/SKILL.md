---
name: dbt-schema-verify
description: REQUIRED after building or modifying ANY dbt model whose columns are declared in schema.yml / _models.yml. Diff a model's ACTUAL produced columns against the spec and treat any `mismatch` as "not done." Catches the "build is green but tests still fail" bug where the data values are right but the column SHAPE (extra/missing/reordered/wrong-type columns) is wrong.
---

# dbt schema-verify

## Why this exists

The most common reason "the build is green but the tests still fail" is that the
model produces the right *data values* in the wrong *column shape* — extra
columns, missing columns, wrong order, or wrong types. Many dbt equality tests
grade the column tuple `(name, type, position)` exactly, and the natural bias is
to add "helpful" extras (rank breakdowns, name-resolved variants, lineage
metadata) or reorder columns "more logically." Both break the contract. This
skill enforces the mechanical check that catches those bugs **before** declaring
a model done.

## Requirements
**MCP:** `mcp__opende__schema_verify` (primary).
**CLI fallback:** `{{RUNNER}} show --select <name> --limit 0`.

## When to invoke — every time, before declaring these complete

- Creating a new model that has (or will have) a `schema.yml` entry.
- Modifying an existing model whose `schema.yml` declares columns.
- Refactoring a CTE into its own intermediate model.
- Renaming columns or changing their order.
- Changing materialization config in a way that re-creates the table.
- Any task that says "match the schema", "produce columns X, Y, Z", or references a `_models.yml`.
- Any model with `AUTO_*_equality` / `AUTO_*_existence` tests.

If the task touched N models, verify **all N**, not just the last one. A `build`
is not a verify.

## How to run it

```
mcp__opende__schema_verify({ model: "<name>" })
```

It diffs **expected** columns (from `schema.yml`, via `target/manifest.json`,
order preserved) against **actual** columns (from `target/catalog.json` — the real
warehouse columns; falls back to `{{RUNNER}} show --select <name> --limit 0`).
Returns:

```json
{
  "model": "int_asana__project_user_agg",
  "verdict": "mismatch",
  "expected_columns": ["project_id", "users", "number_of_users_involved"],
  "actual_columns":   ["project_id", "users"],
  "columns_extra": [],
  "columns_missing": ["number_of_users_involved"],
  "columns_reordered": [],
  "type_mismatches": []
}
```

If actual columns can't be read, refresh the catalog with
`{{RUNNER}} docs generate` (or build the model) and re-run.

## How to read the verdict

| verdict | meaning | what to do |
|---|---|---|
| `match` | actual columns match the spec exactly (case-insensitive names) | DONE — proceed |
| `mismatch` | one or more of `columns_extra` / `columns_missing` / `columns_reordered` / `type_mismatches` is non-empty | NOT DONE — read the diff, fix the model SQL, rebuild, re-run |
| `no-spec` | the model declares no columns in schema.yml | DONE for shape — no contract to verify against |

## How to act on a `mismatch` (mechanical)

| Field | Means | Fix in the model SQL |
|---|---|---|
| `columns_extra` | in your model, not in spec | REMOVE from the `SELECT` |
| `columns_missing` | in spec, not in your model | ADD to the `SELECT` (compute it, or rename a synonym) |
| `columns_reordered` | present in both, wrong position | REORDER the `SELECT` to match spec order |
| `type_mismatches` | declared `data_type` ≠ warehouse type | CAST in the `SELECT` (or fix the upstream source) |

Then `{{RUNNER}} build --select <name>`, refresh the catalog, and
re-run `schema_verify` until verdict is `match`.

## Iron Rules

1. **The verdict is the source of truth, not your inspection.** Reading the
   columns and concluding "looks right" does not count — run the tool.
2. **A `mismatch` is "not done", even if the build is green.** Build only proves
   the SQL compiled and ran; equality tests grade shape AND values.
3. **Do not reinterpret the spec to make the model right.** The spec is the
   contract. Fix the model, not the argument.
4. **Verify every model touched, not just the last.** The classic "almost-pass"
   is N-1 passing and the Nth silently failing on shape. Walk the list.
5. **Skip only on `no-spec`.** Not because a model is "small" or "obvious."

## What this does NOT cover

- **Value correctness** — shape ≠ values. Verify values with `{{RUNNER}} test`
  + the `dbt-unit-tests` skill.
- **Row count** — a refactor that drops rows passes schema-verify but fails
  equality tests. Check row counts separately.
- **Custom tests** — `check_*` / non-AUTO tests assert business rules, not shape.

See [REFERENCE.md](../REFERENCE.md) and AGENTS.md §11 (dbt Verification Workflow).
