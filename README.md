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
- **Skills + agent personas** — scaffolded into your harness by the `init` CLI.

## Installation

```bash
# From git (package not yet published to npm)
npm install --save-dev github:lgwacker/opende
```

This pulls `@altimateai/altimate-core` (prebuilt Rust/NAPI binary for your platform) automatically.

## Setup — `opende init`

Run the interactive wizard from your dbt project root:

```bash
npx opende init
```

The wizard walks you through:

```
opende — interactive setup

  dbt project directory (.): 
  dbt command (dbt): ./scripts/run_dbt.sh
  PR review signing key (optional, Enter to skip): 

  Found 4 env var(s) referenced in profiles.yml.
  Provide values to inject into .mcp.json (the MCP server process
  does not inherit your shell env — it needs them explicitly).

  SNOWFLAKE_ACCOUNT: myaccount.us-east-1
  SNOWFLAKE_USER: myuser
  SNOWFLAKE_PASSWORD: ********
  SNOWFLAKE_DATABASE [env: MY_DB, Enter to use]: 

opende → claude | project: /path/to/dbt | dbt: ./scripts/run_dbt.sh
  ~ .mcp.json (server 'opende')
  + skill: dbt-develop/SKILL.md
  ...
  + agent: builder
  + agent: analyst
  + agent: plan
  + agent: reviewer
  ~ .claude/settings.json (gate hook + enabled 'opende')
  + .altimate/review.yml
Done. Restart Claude Code (or reload MCP/agents) to pick up the new config.

⚠  .mcp.json contains credentials — ensure it is in .gitignore.
```

**What it writes (all idempotent — safe to re-run after upgrading):**

| Path | What |
|---|---|
| `.mcp.json` | MCP server config with warehouse credentials |
| `.claude/skills/` | All skill files (dbt-develop, dbt-test, pii-audit, etc.) |
| `.claude/agents/` | Agent personas: `builder`, `analyst`, `plan`, `reviewer` |
| `.claude/settings.json` | PostToolUse gate hook + MCP server enabled |
| `.altimate/review.yml` | Sample review rubric (never overwritten on re-run) |

Re-running `opende init` is safe: skills and agents update to the latest version, existing
credentials in `.mcp.json` are preserved, the gate hook is de-duped, and `.altimate/review.yml`
is left untouched once customised.

### Non-interactive (CI / scripts)

Pass `--yes` to skip all prompts:

```bash
npx opende init --yes \
  --project-dir . \
  --dbt-cmd ./scripts/run_dbt.sh \
  --signing-key "$REVIEW_SIGNING_KEY"
```

Warehouse credentials are not injected in `--yes` mode — add them manually to `.mcp.json`
or ensure they are already present from a previous interactive run.

### Monorepo

If your dbt project lives in a subfolder (e.g. `services/transformation/dbt`), run the wizard
from that subfolder — it sets `ALTIMATE_DBT_PROJECT_DIR` correctly and writes `.claude/` where
Claude Code expects it:

```bash
cd services/transformation/dbt
npx opende init --dbt-cmd ./scripts/run_dbt.sh
```

Then move the Claude files up to the repo root if you open Claude Code from there:

```bash
mv .mcp.json ../../..
mv .claude ../../..
```

## Why warehouse credentials go in `.mcp.json`

The MCP server runs as a **separate process** spawned by Claude Code. It does not inherit your
shell environment or `.env` files — only the `env` block in `.mcp.json` is passed to it.

If your `profiles.yml` references env vars (e.g. `{{ env_var('SNOWFLAKE_PASSWORD') }}`), the
MCP server won't see them unless they are explicitly listed in `.mcp.json`.

**Security note:** `.mcp.json` with credentials should not be committed to git. Add it to
`.gitignore`:

```
.mcp.json
```

Alternatively, use key-pair authentication (a `.p8` file path via `SNOWFLAKE_PRIVATE_KEY_PATH`)
so there is no secret to leak.

## Configuration reference

| Env var in `.mcp.json` | `opende init` flag | Default |
|---|---|---|
| `ALTIMATE_DBT_PROJECT_DIR` | `--project-dir` | wizard prompt (`.`) |
| `DBT_RUNNER_CMD` | `--dbt-cmd` | wizard prompt (`dbt`) |
| `ALTIMATE_REVIEW_SIGNING_KEY` | `--signing-key` | unset → SHA-256 unkeyed digest |
| `ALTIMATE_CORE_PATH` | — | resolved from `node_modules` |
| `ALTIMATE_CACHE_DIR` | — | `$XDG_CACHE_HOME/opende/<project-hash>` |
| Any `env_var()` from `profiles.yml` | — | wizard prompt (auto-detected) |

## Agent personas

`opende init` writes four subagent definitions to `.claude/agents/`:

| Agent | Role | Invoke with |
|---|---|---|
| `opende-builder` | Create/modify models, SQL, YAML — full read/write | `@opende-builder` |
| `opende-analyst` | Read-only exploration, SELECT-only warehouse queries | `@opende-analyst` |
| `opende-plan` | Read-only planning — no edits, no execution | `@opende-plan` |
| `opende-reviewer` | Adversarial PR review — signed APPROVE/COMMENT/REQUEST_CHANGES | `@opende-reviewer` |

## Harness support

Claude Code today. The generator is adapter-based (`src/cli/adapters/`) — opencode/Cursor are a
thin future addition.

## Development

```bash
npm test                  # all 334 tests (unit + integration)
npm run test:unit         # pure-JS tests only (~120 ms, no engine)
npm run test:integration  # real altimate-core calls + gate subprocess tests
```

Requires Node ≥ 18. Uses the built-in `node:test` runner — no extra dependencies.

## Attribution & license

MIT. Built on top of [altimate-code](https://github.com/AltimateAI/altimate-code) (MIT) and the
[`@altimateai/altimate-core`](https://www.npmjs.com/package/@altimateai/altimate-core) Rust/NAPI
engine. See `NOTICE` for full attribution. This project is not affiliated with or endorsed by
AltimateAI.
