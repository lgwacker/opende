---
name: lineage-diff
description: Compare column-level lineage between two versions of a SQL model to show added, removed, and changed data flow edges. Now fully deterministic via `mcp__opende__diff_lineage`; `{{RUNNER}} ls --select` provides structural graph context.
---

# Lineage Diff

## Requirements
**Model:** Claude (presents findings, contextual impact assessment)
**CLI:** `{{RUNNER}} compile --select`, `{{RUNNER}} ls --select`, `{{RUNNER}} show`, `bash` (git)
**MCP:** `mcp__opende__diff_lineage`, `mcp__opende__column_lineage`

## Workflow

### 1. Get the Two SQL Versions

**Before (old) version** — get from git:
```bash
git show HEAD:models/<path/to/model.sql>
# or for a specific commit:
git show <sha>:models/<path/to/model.sql>
```

**After (new) version** — read the current file from disk.

If the user provides both versions directly in the conversation, skip the git step.

### 2. Compile Both Versions

Jinja references must be resolved for accurate column tracing. Compile the current version:

```bash
{{RUNNER}} compile --select <name>
# compiled SQL in target/compiled/<project>/<path>.sql
```

For the old version, if it differs structurally from HEAD, write it to a temp file and run:
```bash
{{RUNNER}} show --inline "$(cat /tmp/old_model.sql)" --output json
```

### 3. Get Structural Context

Fetch upstream and downstream models to understand scope of impact:

```bash
{{RUNNER}} ls --select +1<name> --output json
{{RUNNER}} ls --select <name>+1 --output json
{{RUNNER}} show --select <name> --limit 10 --output json
```

### 4. Compute Column-Level Lineage Diff (Deterministic)

Call `mcp__opende__diff_lineage` with both compiled SQL versions:

- `before_sql` — compiled SQL from `git show HEAD:<path>` (then compiled)
- `after_sql` — compiled SQL from the current file on disk

The engine returns:
- `added_columns` — new data flow edges in the after version
- `removed_columns` — edges present in before but gone in after
- `modified_columns` — edges that exist in both but with changed transformations
- `affected_downstream` — downstream consumers impacted by the changes

**Common Mistakes**

| Mistake | Correct approach |
|---|---|
| Passing raw Jinja SQL without compiling | Always compile first; `{{ ref() }}` changes table names and breaks lineage extraction |
| Passing the same compiled file for both versions | `before_sql` must come from the git-retrieved + compiled old version |
| Ignoring `SELECT *` expansions | Use `{{RUNNER}} show` to resolve `*` to actual column list before passing to diff_lineage |

For single-version lineage inspection (no diff needed), call `mcp__opende__column_lineage` with the compiled SQL to get the full lineage graph of one model.

### 5. Report the Diff

```
Lineage Diff: <model_name>
═══════════════════════════════════

+ ADDED (new data flow):
  + source_table.new_column → target_table.output_column

- REMOVED (broken data flow):
  - source_table.old_column → target_table.output_column

~ MODIFIED (transformation changed):
  ~ source_table.amount → target_table.revenue  [CAST(x AS INT) → ROUND(x, 2)]

  UNCHANGED: 5 edges

Downstream impact:
  Models referencing <model_name>: [list from {{RUNNER}} ls --select <model_name>+1]
  Affected downstream (from diff_lineage): [affected_downstream list]
  Check whether removed edges break any downstream consumers.

Impact: 1 new edge, 1 removed edge, 1 modified edge
```

## Usage

- `/lineage-diff models/marts/dim_customers.sql` — Compare current file against last git commit
- `/lineage-diff` — Compare staged changes in the current file

## How this maps (Option A)

**Fully deterministic:** Column-level edge extraction and diff computation use `mcp__opende__diff_lineage` (pass `before_sql`/`after_sql` as compiled SQL). The engine returns `added_columns`, `removed_columns`, `modified_columns`, and `affected_downstream` without any LLM reasoning. `{{RUNNER}} compile --select` resolves Jinja; `{{RUNNER}} ls --select` supplies structural graph context. For single-version lineage, `mcp__opende__column_lineage` is used instead.

**Claude-reasoned:** Presenting findings in readable prose and contextual impact assessment for the specific PR or deployment context.

See [REFERENCE.md](../REFERENCE.md).
