---
name: training-status
description: Show what Claude Code has learned — patterns, rules, glossary, and standards stored in persistent memory. Lists all memory files grouped by type and suggests next actions.
---

# Training Status

See [ALTIMATE_CLI.md](../ALTIMATE_CLI.md) for CLI reference.

## How this maps (Option A)

The original skill used `training_list` to query the altimate agent's training store. Here, Claude Code reads the **persistent memory directory** directly:
- Index: `~/.claude/projects/<project>/memory/MEMORY.md`
- Memory files: same directory, one `.md` per learned item
- Team conventions: `AGENTS.md` in the project root

## Workflow

### Step 1: Read the index

Read `~/.claude/projects/<project>/memory/MEMORY.md` to get the list of all learned items.

### Step 2: List and group the memory files

```bash
ls -lt ~/.claude/projects/<project>/memory/*.md
```

Read the frontmatter of each file to get `name`, `description`, and `metadata.type`. Group by type:
- `project` — patterns learned via `/teach` (structural conventions from example files)
- `reference` — standards loaded via `/train` (style guides, rules, glossary)
- `feedback` — corrections and overrides from past conversations

### Step 3: Present the status report

Format as a clean dashboard:

```
Training Status
───────────────────────────────────────────────
Patterns (project):   X  (staging-model, incremental-config, ...)
References:           X  (sql-style-guide, naming-rules, ...)
Glossary/Feedback:    X  (arr-definition, no-float-rule, ...)

Memory files:
  - <name>  [type]  <description>
    Source: <source field from frontmatter>
  ...

AGENTS.md conventions: (summarize any training-derived sections)
───────────────────────────────────────────────
```

If no memory files exist beyond the index itself, say: "No patterns or standards have been learned yet."

### Step 4: Offer next actions

After showing status, suggest:
- `/teach @<file>` to learn a new pattern from an example file
- `/train @<doc>` or `/train <url>` to load standards from a document
- "To remove an outdated entry, delete the `.md` file and remove its line from `MEMORY.md`"
- "To update an entry, edit the relevant `.md` file directly"

## Usage

```
/training-status
```

## Notes

- Memory files are plain markdown — they can be read, edited, or deleted directly.
- The `MEMORY.md` index is the authoritative list; if a `.md` file exists but has no entry in `MEMORY.md`, it won't be surfaced automatically.
- Patterns saved to `AGENTS.md` take effect immediately for all future sessions in this project.
