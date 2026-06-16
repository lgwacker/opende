---
name: dbt-pr-review
description: Cloudflare-style deterministic review for dbt/SQL pull requests. Produces a signed APPROVE/COMMENT/REQUEST_CHANGES verdict where every blocking finding is backed by a deterministic engine call — column-lineage blast radius, query equivalence, PII classification, contract shape, and A–F grade. Use to review a dbt PR or the working-tree changes before merge.
---

# dbt PR Review

## Requirements
**Model:** Claude (presents the verdict; the verdict itself is computed deterministically).
**Agent:** `reviewer` (read-only) — also works from `analyst`/`builder`.
**MCP:** `mcp__opende__dbt_pr_review` (primary), `mcp__opende__impact_analysis`,
`mcp__opende__schema_verify`, `mcp__opende__check_equivalence`, the gate.

## When to Use This Skill

- Review a dbt pull request (changed models) before merge.
- Get a single verdict (APPROVE / COMMENT / REQUEST_CHANGES) with evidence.
- Understand the downstream blast radius of a model/column change.
- Check whether a "refactor" actually preserves results (query equivalence).
- Catch PII exposure, contract (column-shape) breaks, or cost anti-patterns pre-merge.

## What makes this different from a generic AI review

A generic reviewer reads the diff as text and guesses. This review is backed by
**altimate-core**: every blocking finding carries a deterministic proof — an
equivalence verdict, a downstream-model list, a PII classification, a
column-shape diff. The verdict is **mechanically derived from findings + the
rubric** (never from prose) and **signed** (HMAC) into a replayable envelope
keyed to the dbt manifest.

## Workflow

1. **Run the verdict engine.** Call `mcp__opende__dbt_pr_review` once:
   - `dbt_pr_review({})` reviews the working tree against `origin/main`.
   - `dbt_pr_review({ base: "origin/main", head: "HEAD", manifest_path: "target/manifest.json" })`
     for an explicit PR range.
   - It reads `.altimate/review.yml` for the per-repo rubric + `mode`.
   - Or from a shell: `{{REVIEW_INVOCATION}} [--base R --head R --mode gate]`.

2. **Read the signed envelope.** It carries the verdict, a risk tier
   (trivial / lite / full), and findings grouped by severity
   (critical / warning / suggestion), each with engine evidence and the source tool.

3. **Present the verdict** exactly as returned — group findings by severity, cite
   the evidence (rule code, removed columns + consumer count, equivalence result,
   schema_verify buckets). If the run is **degraded / lint-only** (no
   manifest/catalog), state plainly that lineage, equivalence, and contract were
   NOT verified — refresh with `dbt docs generate` for the full verdict.

4. **Respect the safety invariant.** An UNDECIDABLE equivalence result is a
   WARNING with `confidence: unknown` — it NEVER blocks and never accumulates into
   the ≥3-warning risk pattern. Never claim a refactor is unsafe when equivalence
   could not be decided; recommend `mcp__opende__data_diff` instead.

5. **No formal approval.** Even an APPROVE verdict is advisory — it is conveyed in
   the comment body, never as a branch-protection-satisfying sign-off. A human
   still merges.

## Verdict rubric (defaults; override in `.altimate/review.yml`)

- **REQUEST_CHANGES** — any blocking-category `critical` (broken lineage with
  downstream consumers, contract violation, PII exposure, proven non-equivalent
  rewrite, cartesian/fan-out), OR ≥3 confident warnings (risk pattern).
- **COMMENT** — only suggestions, or a single non-blocking/undecidable warning.
- **APPROVE** — no findings.

Default blocking categories: `lineage_breakage, contract_violation, pii_exposure,
semantic_change, join_risk, fanout, sql_correctness`. In `comment` mode (default),
REQUEST_CHANGES is softened to COMMENT (posted, not blocked). Switch to `gate`
per-repo once the false-positive rate is trusted.

## Configuration (`.altimate/review.yml`)

```yaml
mode: comment            # comment (never blocks) | gate (REQUEST_CHANGES → exit 1)
severityThreshold: suggestion
manifestPath: target/manifest.json
dialect: snowflake
exclude:
  - models/legacy/**
rubric:
  blockOn: [lineage_breakage, contract_violation, pii_exposure, semantic_change]
  warningPatternThreshold: 3
  thresholds:
    warehouseCostMinRows: 1000000
    lineageWarnConsumers: 1
    lineageCriticalConsumers: 1
```

## Lanes (what the engine runs per changed model)

- **gate composite** — `lint` + `scan_sql` + `check_query_pii` + `check_semantics` → sql_correctness / pii_exposure / join_risk / fanout.
- **grade regression** — `evaluate` base vs head → quality_regression on a letter drop.
- **equivalence** — `check_equivalence` base vs head → semantic_change critical when proven non-equivalent; unknown→warning.
- **lineage breakage** — removed output columns × `impact_analysis` downstream consumers → lineage_breakage (warn/critical by consumer count).
- **contract** — `schema_verify` → contract_violation on a column-shape mismatch.
- **structural / portability** — `review_structural_diff` (grain/DISTINCT/key) + `review_lexical_scan` (cross-dialect).

dbt models contain Jinja — the engine prefers **compiled** SQL (`target/compiled/...`)
and skips parse-dependent lanes when only raw Jinja is available (those findings
are marked unverified). Run `{{RUNNER}} compile --select <model>` to give it clean SQL.

See [OPENDE_CLI.md](../OPENDE_CLI.md) and the `reviewer` agent.
