# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
