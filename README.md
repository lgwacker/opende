# opende (Open Data Engineering)

> **A stripped extract of [altimate-code](https://github.com/AltimateAI/altimate-code) that lets
> you use altimate-code's deterministic SQL intelligence inside model-locked subscription harnesses
> — Claude Code, Cursor, Windsurf, etc. — where your company only allows the subscription model
> and running a second LLM agent is either forbidden or cost-prohibitive.**

The altimate LLM agent/SDK is **never invoked** (enforced by a hard `FORBIDDEN` guard in
`src/core.js`). Your harness's model stays the only model. What you get is the *deterministic*
half of altimate-code: the Rust-core engine, the signed PR-review verdict, the edit-time gate,
plus skills and agent personas — no extra API key, no network calls, no altimate subscription needed.

## Why this exists

[altimate-code](https://github.com/AltimateAI/altimate-code) ships with its own powerful LLM
agent. That's great when you're using altimate-code directly. But if your company standardises on
Claude Code, Cursor, or any other subscription harness, you can't (or don't want to) spin up a
second LLM agent. opende gives those harnesses the altimate-core deterministic layer —
lint, lineage, equivalence, PII, contract/grade, signed review verdict — as a standard MCP
server and Claude-Code skill set, with zero altimate agent involvement.

## What you get

- **MCP server** (`opende-mcp`) exposing **64 deterministic tools** (`mcp__opende__*`):
  transpile/lint/validate/check_semantics/evaluate, column_lineage/diff_lineage,
  classify_pii/check_query_pii, analyze_migration/diff_schemas, generate_tests,
  `check_equivalence` (optional `dialect` hint for Snowflake/BigQuery/etc. syntax; honors `decidable` flag), `dbt_pr_review` (signed APPROVE/COMMENT/REQUEST_CHANGES verdict),
  `schema_verify` (column-shape contract), `impact_analysis` (DAG blast radius), warehouse +
  finops tools (Snowflake), and more.
- **Edit-time gate** (`opende-gate`) — render-then-analyze; lints compiled SQL, skips
  raw Jinja, blocks genuine errors.
- **PR-review CLI** (`opende-review`) — the signed verdict over changed models.
- **Skills + agent personas + AGENTS.md doctrine** — scaffolded into your harness by the `init` CLI.

## Install (git)

```bash
npm i -D github:lgwacker/opende
# pulls @altimateai/altimate-core (prebuilt binary for your platform) automatically
```

## Set up in a project (Claude Code)

```bash
npx opende init --harness claude --project-dir .
#   [--dbt-cmd "./scripts/run_dbt.sh"]  [--signing-key "$ALTIMATE_REVIEW_SIGNING_KEY"]
```

This generates/merges (idempotently): `.mcp.json` (the MCP server), `.claude/skills/`,
`.claude/agents/`, an `AGENTS.md` doctrine section, the PostToolUse gate hook in
`.claude/settings.json`, and a sample `.altimate/review.yml`. Re-run after upgrading the package.

## Configuration

All paths resolve from flags → env → auto-detect (`dbt_project.yml` upward) → cwd:

| Env | Flag | Default |
|---|---|---|
| `ALTIMATE_DBT_PROJECT_DIR` | `--project-dir` | auto-detect |
| `DBT_RUNNER_CMD` | `--dbt-cmd` | `dbt` |
| `ALTIMATE_REVIEW_SIGNING_KEY` | `--signing-key` | unset → `sha256:` unkeyed digest |
| `ALTIMATE_CORE_PATH` | — | resolve `@altimateai/altimate-core` from node_modules |
| `ALTIMATE_CACHE_DIR` | — | `$XDG_CACHE_HOME/opende/<project-hash>` |

## Harness support

Claude Code today. The generator is adapter-based (`src/cli/adapters/`) — opencode/Cursor are a
thin future addition (MCP + AGENTS.md are already portable; only the skills/agents/gate wiring
differs).

## Development

```bash
npm test                  # all 228 tests (unit + integration)
npm run test:unit         # pure-JS tests only (~120 ms, no engine)
npm run test:integration  # real altimate-core calls + gate subprocess tests
```

Requires Node ≥ 18. Uses the built-in `node:test` runner — no extra dependencies.

## Attribution & license

MIT. Built on top of [altimate-code](https://github.com/AltimateAI/altimate-code) (MIT) and the
[`@altimateai/altimate-core`](https://www.npmjs.com/package/@altimateai/altimate-core) Rust/NAPI
engine. See `NOTICE` for full attribution. This project is not affiliated with or endorsed by
AltimateAI.
