## Altimate deterministic tooling & agent doctrine

Your harness's model is the **only model** here — deterministic SQL intelligence comes from the
local **opende MCP server** (`mcp__opende__*`, {{TOOLCOUNT}} tools, no LLM, no extra
API key) and the SQL gate. The altimate LLM agent/SDK is never invoked. **dbt execution stays on
`{{RUNNER}}`**; the MCP tools add the analysis/safety layer on top.

### Tool map
- **Quality / safety:** `mcp__opende__lint`, `validate`, `scan_sql`, `check_semantics`, `evaluate` (A–F) — or the gate: `{{GATE_INVOCATION}} <files>` (also runs automatically on `.sql` edits if wired as a hook). The gate is **render-then-analyze**: it lints fresh compiled SQL when present and silently skips parse-dependent checks on raw-Jinja models (advisory, never blocks) — compile or use `dbt_pr_review` to analyze the rendered SQL.
- **Lineage / impact:** `column_lineage`, `diff_lineage`, `impact_analysis`.
- **Transform:** `transpile`, `format_sql`, `rewrite`, `fix`, `correct`.
- **PII / governance:** `classify_pii`, `check_query_pii`; RBAC `finops_role_grants`/`role_hierarchy`/`user_roles`; tags `schema_tags`/`schema_tags_list`.
- **Live Snowflake (raw SQL):** `execute` (safety-gated, auto-LIMIT), `schema_inspect`, `data_diff`, `finops_*`. Use these for raw / fully-qualified SQL; use `{{RUNNER}} show/build` for anything referencing `{{ ref() }}`.
- **Tests:** `generate_tests` (seed) → finalize as dbt schema/unit tests.
- **PR review:** `dbt_pr_review` (signed APPROVE/COMMENT/REQUEST_CHANGES verdict), `impact_analysis` (downstream blast radius), `schema_verify` (column-shape contract), `review_structural_diff`, `review_lexical_scan`, `lint_diff`.

### Pre-Execution Protocol — before `mcp__opende__execute`
1. `lint` + `scan_sql`; fix HIGH-severity findings (SELECT *, cartesian joins, missing WHERE, full scans).
2. `validate` — catch syntax/schema errors before hitting the warehouse.
3. Execute (auto-LIMIT). Trivial probes (`SELECT 1`) may skip. `DROP DATABASE`/`DROP SCHEMA`/`TRUNCATE` are hard-blocked; non-SELECT requires `allow_write: true`. Every credit saved is trust earned.

### dbt Verification Workflow — after any model change
1. `{{RUNNER}} compile --select <model>` (resolve Jinja).
2. Analyze the **compiled** SQL with `mcp__opende__lint` + `check_semantics` (or the gate).
3. `mcp__opende__column_lineage` — confirm the intended columns/sources; no broken refs.
4. Seed tests with `mcp__opende__generate_tests`, finalize as schema/unit tests, then `{{RUNNER}} build --select <model>`.
5. **`mcp__opende__schema_verify({ model })` — a model isn't done until verdict is `match`, even if the build is green.** Equality/`AUTO_*` tests grade the column tuple `(name, type, position)`; a `mismatch` (extra/missing/reordered/wrong-type columns) means NOT done. Verify every model you touched. See the `dbt-schema-verify` skill.
6. Never stop at compile; leave your `--select` set green.

### Review verdict protocol — reviewing a change
Lead with `mcp__opende__dbt_pr_review` (or `{{REVIEW_INVOCATION}}`): a signed APPROVE/COMMENT/REQUEST_CHANGES verdict over the changed models, every blocking finding backed by a deterministic call (equivalence, lineage blast radius, PII, contract, grade). Reads `.altimate/review.yml` for the rubric/mode. **Safety invariant: an undecidable equivalence result is a warning, never a block — recommend a `data_diff` instead.** Present the verdict as returned; the `reviewer` agent drives this end-to-end.

### Cost advocacy
`LIMIT` for exploration; `APPROX_COUNT_DISTINCT` over exact; `data_diff algorithm:"profile"` (column stats, no row scan) before any row-level diff; be mindful of `ACCOUNT_USAGE` scans.

### Iron rules / pitfalls
- Never write SQL without reading the columns first (`mcp__opende__schema_inspect` or `{{RUNNER}} show`).
- Date spines from `MIN/MAX` of source data — never `current_date`.
- Check grain before joins (one-to-many → fan-out inflation).
- Preserve NULLs — no gratuitous `coalesce(_, 0)`.
- Verify column casing (Snowflake returns UPPER-case names).
- Fix ALL failures in your selection, including pre-existing ones.

### Agent modes (`.claude/agents/`)
**builder** (full read/write + the protocols above), **analyst** (read-only, SELECT-only exploration), **plan** (read-only planning), **reviewer** (adversarial diff review). Invoke via the Agent tool or `@analyst` / `@reviewer` etc.

### Trainable teammate
Corrections become durable institutional knowledge: `/teach` (learn a pattern from a file), `/train` (rules from a doc/style guide) → saved to memory and this file; `/training-status` to review.
