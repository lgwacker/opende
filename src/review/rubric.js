// The review rubric — rubric-as-data, NOT prompt text (faithful port of
// altimate-code's `review/rubric.ts`). Encoding both halves declaratively —
// `blockOn` (what blocks) and `exclusions` (what to NEVER flag) — keeps the
// verdict deterministic, versionable, and signable. Per-repo overrides come from
// `.altimate/review.yml`.
import fs from "node:fs";
import path from "node:path";
import { load as yamlLoad } from "js-yaml";

export const DEFAULT_RUBRIC = {
  version: "1",
  // Categories where a `critical` finding forces REQUEST_CHANGES.
  blockOn: [
    "lineage_breakage",
    "contract_violation",
    "pii_exposure",
    "semantic_change",
    "join_risk",
    "fanout",
    "sql_correctness",
  ],
  // >= this many confident `warning` findings is treated as a risk pattern → block.
  warningPatternThreshold: 3,
  thresholds: {
    warehouseCostMinRows: 1_000_000,
    lineageWarnConsumers: 1,
    lineageCriticalConsumers: 1,
    gradeRegressionLetters: 1,
  },
  exclusions: {
    allowSelectStarInStaging: true,
    skipMissingContractWhenNotEnforced: true,
    skipNonProdModels: true,
    excludeGlobs: [],
  },
};

export function blockingCategories(rubric = DEFAULT_RUBRIC) {
  return new Set(rubric.blockOn);
}

/**
 * The load-bearing safety rule (faithful port of upstream rubric.ts). A finding
 * the engine isn't sure about must NOT block: an unknown/low-confidence critical
 * is downgraded to a warning. Every lane routes its severity through this.
 */
export function clampSeverity(category, proposed, confidence) {
  if (confidence === "unknown" && proposed === "critical") return "warning";
  if (confidence === "low" && proposed === "critical") return "warning";
  return proposed;
}

/**
 * Apply the rubric's exclusion predicates. Returns the reason a finding should be
 * dropped, or null to keep it. Centralizing this in code (vs prompt text) is what
 * keeps the false-positive rate down deterministically.
 */
export function exclusionReason(finding, rubric = DEFAULT_RUBRIC) {
  const ex = rubric.exclusions;
  const file = finding.file || "";
  const isStaging = /(^|\/)stg_|(^|\/)staging\//.test(file) || (finding.model || "").startsWith("stg_");
  const isDev = /(^|\/)(dev|sandbox|scratch)\//.test(file);

  if (ex?.skipNonProdModels && isDev) return "non-prod model (dev/sandbox/scratch)";

  if (
    ex?.allowSelectStarInStaging &&
    finding.category === "warehouse_cost" &&
    isStaging &&
    /select\s*\*/i.test((finding.title || "") + " " + (finding.body || ""))
  ) {
    return "SELECT * in staging is an accepted convention";
  }

  for (const g of ex?.excludeGlobs || []) {
    const suffix = g.replace(/^\*+/, "");
    if (suffix && file.endsWith(suffix)) return `excluded by glob ${g}`;
  }
  return null;
}

/** Load `.altimate/review.yml` (per-repo config). Never throws. */
export function loadReviewConfig(cwd) {
  const config = { mode: "comment", manifestPath: "target/manifest.json", dialect: null, exclude: [], rubric: {} };
  try {
    const cfgPath = path.join(cwd, ".altimate", "review.yml");
    if (fs.existsSync(cfgPath)) {
      const raw = yamlLoad(fs.readFileSync(cfgPath, "utf8")) || {};
      return { ...config, ...raw };
    }
  } catch {
    /* fall through to defaults */
  }
  return config;
}

/** Merge config overrides onto DEFAULT_RUBRIC. */
export function resolveRubric(config = {}) {
  const r = JSON.parse(JSON.stringify(DEFAULT_RUBRIC));
  const rb = config.rubric || {};
  if (Array.isArray(rb.blockOn)) r.blockOn = rb.blockOn;
  if (Number.isInteger(rb.warningPatternThreshold)) r.warningPatternThreshold = rb.warningPatternThreshold;
  if (rb.thresholds && typeof rb.thresholds === "object") Object.assign(r.thresholds, rb.thresholds);
  // Concatenate (don't overwrite) glob sources, like upstream resolveRubric.
  r.exclusions.excludeGlobs = [
    ...r.exclusions.excludeGlobs,
    ...(Array.isArray(rb.exclusions?.excludeGlobs) ? rb.exclusions.excludeGlobs : []),
    ...(Array.isArray(config.exclude) ? config.exclude : []),
  ];
  return r;
}
