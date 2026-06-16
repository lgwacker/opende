// Render a verdict envelope for humans (markdown PR summary). Faithful port of
// altimate-code's `review/format.ts`, kept separate from the engine.
import { SEVERITY_ORDER } from "./finding.js";

export const REVIEW_MARKER = "<!-- altimate-code-review -->";

const SEVERITY_EMOJI = { critical: "🛑", warning: "⚠️", suggestion: "💡" };
const VERDICT_LABEL = {
  APPROVE: "✅ Approved",
  COMMENT: "💬 Reviewed with comments",
  REQUEST_CHANGES: "🛑 Changes requested",
};

/** One-line headline used at the top of the summary and as the check title. */
export function verdictHeadline(env) {
  const { critical, warning, suggestion } = env.summary;
  const counts =
    [critical && `${critical} critical`, warning && `${warning} warning`, suggestion && `${suggestion} suggestion`]
      .filter(Boolean)
      .join(", ") || "no findings";
  return `${VERDICT_LABEL[env.verdict]} — ${counts} (${env.tier} tier)`;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const oneLine = (s) => String(s || "").replace(/\s*\n\s*/g, " ").trim();

function groupBySeverity(findings) {
  const out = { critical: [], warning: [], suggestion: [] };
  for (const f of findings) out[f.severity].push(f);
  return out;
}

/** Full PR/MR summary comment body (markdown), prefixed with the dedup marker. */
export function renderSummary(env) {
  const lines = [REVIEW_MARKER, "", `## ${verdictHeadline(env)}`, ""];

  if (env.summary.degraded) {
    lines.push(
      "> ⚙️ **Lint-only run** — no dbt manifest/catalog was available, so lineage, equivalence and",
      "> data-impact checks were skipped or unverified. Run `dbt docs generate` (or set `manifest_path`)",
      "> for the full verdict.",
      "",
    );
  }

  if (!env.findings.length) {
    lines.push("No issues found in the changed dbt models. 🎉", "");
  } else {
    const grouped = groupBySeverity(env.findings);
    for (const sev of ["critical", "warning", "suggestion"]) {
      const items = grouped[sev];
      if (!items.length) continue;
      lines.push(`### ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} (${items.length})`, "");
      for (const f of items) {
        const loc = f.file + (f.startLine ? `:${f.startLine}` : "");
        const unverified = f.degraded || f.confidence === "unknown" ? " · _unverified_" : "";
        lines.push(`- **${f.title}**  \n  ${oneLine(f.body)}  \n  \`${loc}\`${unverified} · ${f.category}`);
      }
      lines.push("");
    }
  }

  lines.push(
    "---",
    `opende dbt-pr-review · verdict \`${env.verdict}\`` +
      (env.idealVerdict !== env.verdict ? ` (ideal \`${env.idealVerdict}\`, softened by ${env.mode} mode)` : "") +
      (env.signature ? ` · signed \`${env.signature.slice(0, 18)}…\`` : "") +
      (env.manifestHash ? ` · manifest \`${env.manifestHash.slice(0, 10)}\`` : ""),
  );
  return lines.join("\n");
}
