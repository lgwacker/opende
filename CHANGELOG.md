## [0.1.4](https://github.com/lgwacker/opende/compare/v0.1.3...v0.1.4) (2026-07-26)


### Bug Fixes

* close two fail-open paths, review dbt YAML, resync with altimate-code ([#17](https://github.com/lgwacker/opende/issues/17)) ([0f36ec5](https://github.com/lgwacker/opende/commit/0f36ec5222e75a6137af35e708bfdcb935524348))

# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.1.3] — 2026-06-16

### Changed
- **Skill files no longer reference `altimate-dbt`** — all commands replaced with the
  standard `dbt` CLI (`{{RUNNER}}` token) which opende actually ships against:
  - `altimate-dbt execute` → `{{RUNNER}} show --inline` (dbt ≥ 1.5 Jinja-aware runner)
  - `altimate-dbt parents/children` → `{{RUNNER}} ls --select +1<m>` / `<m>+1`
  - `altimate-dbt columns-source` → `mcp__opende__schema_inspect`
  - `altimate-dbt doctor/info` → `{{RUNNER}} debug`
  - All build/compile/run/test/deps commands now use `{{RUNNER}}` with `--select`
- **`ALTIMATE_CLI.md` renamed to `OPENDE_CLI.md`** and rewritten; Surface 3 now
  documents the standard dbt CLI instead of the altimate-code-specific wrapper.
- **6 duplicate `altimate-dbt-commands.md` reference files eliminated** — each skill
  had an identical copy; all references now point to the single `OPENDE_CLI.md`.
- **`--output json` added** to all `{{RUNNER}} ls` and `{{RUNNER}} show` invocations
  in skill files (`dbt ls` returns JSONL with node metadata; `dbt show` returns rows
  in `data.preview`).
- **Wrong dbt flags fixed** in skill files: `--model` → `--select`; `show-source`
  (non-existent) → `mcp__opende__schema_inspect`.

### Added
- **`opende init` interactive wizard** — running without `--yes` now prompts for
  project directory, dbt command, signing key, and warehouse credentials. Reads
  `profiles.yml` (project root or `~/.dbt/`) to auto-detect `env_var()` references
  and prompts for each value; secrets (PASSWORD, TOKEN, etc.) use hidden input.
  Wizard output is injected into `.mcp.json` so the MCP server process gets the
  credentials it needs (it does not inherit the shell environment).
  Pass `--yes` for the original non-interactive behaviour.
- **Existing `.mcp.json` credentials preserved on re-run** — user-added env vars
  (e.g. warehouse credentials) survive subsequent `opende init` calls. Managed vars
  (`ALTIMATE_DBT_PROJECT_DIR`, `DBT_RUNNER_CMD`, `ALTIMATE_REVIEW_SIGNING_KEY`) are
  always updated to reflect current flags.

### Removed
- **Doctrine injection removed from `opende init`** — `opende init` no longer creates
  or modifies `AGENTS.md`. The user owns that file. Agent personas (`builder`,
  `analyst`, `reviewer`, `plan`) already contain the full protocols; security
  invariants are enforced in `src/safety.js` and `src/core.js`. `assets/doctrine/`
  directory deleted.

### Improved
- **MCP tool descriptions** in `src/mcp.js` — disambiguated overlapping tools and
  clarified semantics throughout:
  - `compare_queries` vs `check_equivalence`: structural AST diff vs semantic proof
  - `fix` vs `correct`: identifier fuzzy-match vs iterative logic correction
  - `prune_schema` / `optimize_for_query` / `optimize_context`: each now states its
    scope and cross-references the alternatives
  - `lint` / `validate` / `check_semantics` / `evaluate`: when to use each vs the gate
  - `is_safe` vs `scan_sql`: boolean gate vs detailed findings
  - `column_lineage`, `diff_lineage`, `track_lineage`: "compiled SQL only" note added
  - `explain`: clarified as static offline analysis (not a live warehouse EXPLAIN)
  - `execute`: notes it does not resolve Jinja/`{{ ref() }}`
  - `dbt_config_lint`: now describes what it actually checks
  - Internal alias tags (`=sql_execute`, `=warehouse_list`) and `DataParitySession`
    implementation detail removed from user-facing descriptions

---

## [0.1.2] — 2026-06-16

### Fixed
- **Branding in all user-facing output** — stale `altimate` strings replaced with `opende`
  in every message a user can actually see:
  - `gate.js`: blocked/advisory hook output, error-checking stderr, CLI summary line
  - `mcp.js`: tool error responses (`opende <tool> error: …`)
  - `review/format.js`: PR comment footer (`opende dbt-pr-review · verdict …`)
  - `profiles.js`: Snowflake `application` connection field (visible in
    `ACCOUNT_USAGE.QUERY_HISTORY`); unsupported-type error message
  - `cli/adapters/claude.js`: `init` log lines and the PostToolUse `statusMessage`
  - Comments referencing altimate-code/altimate-core as attribution are intentionally kept.
  - `.altimate/review.yml` path is intentional (config convention) and unchanged.

---

## [0.1.1] — 2026-06-16

### Changed
- **`@altimateai/altimate-core` upgraded 0.4.0 → 0.5.1** (mirrors altimate-code v0.8.7).
  The engine upgrade is purely additive — no breaking changes to existing call sites.

### Added
- **`check_equivalence` MCP tool** now accepts an optional `dialect` parameter
  (`"snowflake"`, `"bigquery"`, `"redshift"`, etc.). Dialect-specific syntax (e.g. Snowflake
  semi-structured `col:field`) now parses and compares correctly instead of aborting.
- **`decidable` flag** on `checkEquivalence` results. `equivalenceVerdict()` now gates on
  `r.decidable === false` — abstaining to `"unknown"` when the engine signals it cannot decide,
  instead of guessing. Undecidable results remain advisory (never block) as before.
- **`dialect` threaded into `equivalenceLane`** in the dbt PR reviewer (`review/run.js`),
  using the already-detected adapter dialect (`detectDialect(manifestAbs)`). Snowflake
  projects no longer fall through to the generic parser for equivalence checks.
- **Full test suite** — 228 tests via `node:test` (no extra dependencies):
  - 158 unit tests covering config, finding, verdict, rubric, format, impact, schemaverify,
    adapters (including `claudeAdapter.scaffold` idempotency).
  - 70 integration tests covering core/FORBIDDEN guard, safety/gateSql, resolveSchema,
    engine functions (lint/validate/equivalence/evaluate/etc.), and gate.js subprocess
    behavior in CLI + hook modes.
  - `npm test` / `npm run test:unit` / `npm run test:integration`.

---

## [0.1.0] — 2026-06-15

### Added
- Initial release of **opende** (Open Data Engineering).
- Port of altimate-code's deterministic SQL intelligence layer for model-locked subscription
  harnesses (Claude Code, Cursor, Windsurf, etc.) — no altimate LLM agent, no second API key.
- **MCP server** (`opende-mcp`) exposing **64 deterministic tools** (`mcp__opende__*`):
  transpile, lint, validate, check_semantics, evaluate, column_lineage, diff_lineage,
  classify_pii, check_query_pii, analyze_migration, diff_schemas, generate_tests,
  check_equivalence, dbt_pr_review, schema_verify, impact_analysis, and warehouse/finops
  tools (Snowflake).
- **Edit-time gate** (`opende-gate`) — render-then-analyze; uses fresh compiled SQL when
  available, skips raw Jinja with an advisory message, blocks only on deterministic errors.
- **PR-review CLI** (`opende-review`) — signed APPROVE/COMMENT/REQUEST_CHANGES verdict
  envelope (HMAC-SHA256 or unkeyed SHA-256 digest) over changed dbt models.
- **`init` CLI** (`opende`) — idempotent scaffold into Claude Code projects: `.mcp.json`,
  `.claude/skills/`, `.claude/agents/`, `AGENTS.md` doctrine block (sentinel markers),
  PostToolUse gate hook, `.altimate/review.yml` sample.
- **`FORBIDDEN` guard** in `src/core.js` — `initSdk`, `flushSdk`, `resetSdk`,
  `reviewAiParse`, `reviewAiSystemPrompt` are permanently blocked; the altimate LLM agent
  is never invoked.
- **Safety gate** (`src/safety.js`) — DROP DATABASE, DROP SCHEMA, and TRUNCATE are
  hard-blocked (unoverridable); non-read SQL requires explicit `allowWrite:true`.
- Adapter-based generator (`src/cli/adapters/`) for future harness support (opencode/Cursor).
- MIT license; full attribution to altimate-code and `@altimateai/altimate-core` in NOTICE.
