---
name: train
description: Train Claude Code on team standards from a document, style guide, URL, or inline text — extracts actionable rules, confirms with you, then saves to persistent memory files and/or AGENTS.md.
---

# Train

See [ALTIMATE_CLI.md](../ALTIMATE_CLI.md) for CLI reference.

## How this maps (Option A)

The original skill used `training_save` to write rules/standards/glossary to the altimate agent's training store. Here, Claude Code's **persistent memory** is the store:
- Each rule group / standard / glossary block is saved as a markdown file in: `~/.claude/projects/<project>/memory/`
- The `MEMORY.md` index gets a one-line pointer appended.
- Conventions that should govern all future dbt work also get appended to `AGENTS.md`.

## Purpose

Learn team standards and conventions from a document (style guide, review checklist, coding standards, etc.). Extracts actionable rules and saves them as persistent reference.

## Workflow

### Step 1: Get the document

The user provides one of:
- A file reference: `@docs/sql-style-guide.md` — read the file
- A URL: fetch its content
- Inline text: pasted directly in the chat — use as-is

### Step 2: Parse and extract

Read the document and extract:
- Specific, enforceable rules (naming, formatting, prohibited patterns)
- Review criteria and checklists
- Glossary terms and definitions
- Architectural standards and decision criteria

**Only extract ACTIONABLE items.** Skip vague guidance like "write clean code."

### Step 3: Categorize

Group findings by type:
- `rule` — Specific do/don't rules (e.g., "Never use SELECT *", "Always cast numeric IDs to VARCHAR")
- `standard` — Broader conventions (e.g., "SQL style guide compliance", "Kimball dimensional modeling")
- `glossary` — Term definitions (e.g., "ARR = Annual Recurring Revenue", "active_user = user with event in last 30 days")

Consolidate related rules into logical groups (e.g., "sql-naming-rules" with 5 rules, rather than 5 separate memory files).

### Step 4: Present summary and confirm

Show the user:
- Number of rules, standards, and glossary terms found
- A preview of each item / group
- Ask for confirmation before saving

**Do not save anything until the user confirms.**

### Step 5: Save to memory

For each confirmed group, create a memory file and update the index:

**Memory file** — `~/.claude/projects/<project>/memory/<kebab-slug>.md`:

```markdown
---
name: <kebab-slug>
description: <one-line description>
metadata:
  type: reference
  source: <document path or URL>
---

# <Standard/Rule Group Title>

<Actionable rules as a numbered or bulleted list — preserve original wording when specific and clear>
```

Use `type: reference` for style guides / external docs. Use `type: project` for internal team decisions.

**Update the index** — append to `~/.claude/projects/<project>/memory/MEMORY.md`:

```
- [Standard Title](<kebab-slug>.md) — <one-line hook>
```

**If the standards should govern all future project work** (e.g., a SQL naming convention, a required test coverage rule), also append them to `AGENTS.md` so they apply automatically.

## Important Guidelines

- Only extract ACTIONABLE items. "Never use SELECT *" is actionable. "Be thoughtful about query design" is not.
- Consolidate related rules — prefer 3 well-grouped files over 15 micro-files.
- Preserve the original wording when it's specific and clear.
- If the document is too large, focus on the highest-impact rules first.
- Use `type: reference` for external documents, `type: project` for internal decisions.
- Do NOT make any extra reasoning steps — analysis happens in the normal conversation flow.

## Usage Examples

```
/train @docs/sql-style-guide.md
/train https://wiki.company.com/data-team/review-checklist
/train   (then paste content inline)
```
