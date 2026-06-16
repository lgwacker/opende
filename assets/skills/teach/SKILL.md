---
name: teach
description: Teach Claude Code a reusable pattern by showing it an example file from your codebase — extracts structural patterns, confirms with you, then saves to persistent memory and/or AGENTS.md.
---

# Teach

See [REFERENCE.md](../REFERENCE.md) for CLI reference.

## How this maps (Option A)

The original skill used `training_save` to write to the altimate agent's training store. Here, Claude Code's **persistent memory** is the store:
- Each learned pattern is saved as a markdown file in the memory directory: `~/.claude/projects/<project>/memory/`
- The `MEMORY.md` index in that directory gets a one-line pointer added.
- Durable team conventions that belong in the project are also appended to `AGENTS.md`.

## Purpose

Learn a reusable pattern from an example file. The user shows a well-written artifact (model, query, config), and Claude extracts the patterns worth following — not the content.

## Workflow

### Step 1: Identify the file

The user provides a file reference (e.g., `@models/staging/stg_orders.sql`). Read it.

### Step 2: Analyze patterns

Extract the **structural patterns**, NOT the specific content. Focus on:
- File structure and organization (sections, ordering)
- Naming conventions (prefixes, suffixes, casing)
- SQL patterns (CTE vs subquery, join style, column ordering)
- dbt conventions (materialization, tests, config blocks)
- Common boilerplate (headers, comments, imports)
- Data type choices
- Error handling patterns

Good extraction: "Column order: keys first, then dimensions, then measures, then timestamps"
Bad extraction: "Good column ordering"

### Step 3: Present findings

Show the user the extracted patterns as a structured bullet list. Be specific and actionable.

### Step 4: Ask for confirmation

**Do not save anything until the user confirms.** Let them confirm, modify, or reject your findings. If they reject, do not save.

### Step 5: Save to memory

Once confirmed, create a memory file and update the index:

**Memory file** — `~/.claude/projects/<project>/memory/<kebab-slug>.md`:

```markdown
---
name: <kebab-slug>
description: <one-line description>
metadata:
  type: project
  source: <file path learned from>
---

# <Pattern Title>

<Extracted patterns as a concise, actionable checklist — max 10 bullets>
```

**Update the index** — append to `~/.claude/projects/<project>/memory/MEMORY.md`:

```
- [Pattern Title](<kebab-slug>.md) — <one-line hook>
```

**If the pattern is a team convention** (naming rules, required config blocks, mandatory tests), also append it to the project's `AGENTS.md` under an appropriate section so it applies to all future work.

## Important Guidelines

- Extract PATTERNS, not content. "`{{ source() }}` macro for all raw references" is a pattern. "Query the orders table" is content.
- Keep it concise — max 10 bullet points per pattern. If more are needed, split into multiple named patterns.
- Use the file's actual conventions — don't impose your own preferences.
- If the file doesn't have clear patterns worth learning, say so honestly.
- The slug should describe the file type and purpose: `staging-model`, `incremental-config`, `mart-model`.

## Usage Examples

```
/teach @models/staging/stg_orders.sql
/teach staging-model @models/staging/stg_customers.sql
/teach @dbt_project.yml
```

If the user provides a name before the @file, use it as the slug. Otherwise, infer from file type and purpose.
