// Impact analysis — DAG-aware downstream blast radius for a model/column change.
// Faithful reconstruction of altimate-code's `impact-analysis.ts` orchestrator,
// but driven entirely off the dbt manifest (offline, no warehouse). Used by the
// `impact_analysis` MCP tool and by the review lineage lane (run.js).
import fs from "node:fs";
import path from "node:path";

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function findModelId(nodes, base) {
  return Object.keys(nodes).find(
    (id) => nodes[id]?.resource_type === "model" && (nodes[id].name === base || id.endsWith(`.${base}`)),
  );
}

/**
 * Analyze the downstream impact of a model/column change across the dbt DAG.
 * Returns { direct_downstream, transitive_downstream, downstream_count,
 *           affected_tests, severity } or an error/degraded result.
 */
export function impactAnalysis({ model, column = null, changeType = "modify", manifestPath, projectDir, dialect: _dialect = "snowflake" }) {
  manifestPath = manifestPath || path.join(projectDir || process.cwd(), "target", "manifest.json");
  const man = loadManifest(manifestPath);
  if (!man) {
    return {
      model,
      success: false,
      degraded: true,
      severity: "UNKNOWN",
      message: `No manifest at ${manifestPath}. Run \`dbt compile\` / \`dbt docs generate\` first.`,
    };
  }
  const nodes = man.nodes || {};
  const targetId = findModelId(nodes, model);
  if (!targetId) {
    const available = Object.values(nodes)
      .filter((n) => n?.resource_type === "model")
      .slice(0, 10)
      .map((n) => n.name)
      .join(", ");
    return { model, success: false, severity: "UNKNOWN", message: `Model '${model}' not found in manifest. e.g. ${available}` };
  }

  // BFS downstream over the manifest child_map (unique_id → [child unique_ids]).
  // MODEL-ONLY, faithful to upstream findDownstream (which iterates manifest.models):
  // snapshots/exposures/tests are NOT counted as downstream and are not traversed
  // through — counting them would inflate downstream_count and the severity tier.
  const childMap = man.child_map || {};
  const downstream = []; // { name, depth }
  const seen = new Set([targetId]);
  let frontier = [{ id: targetId, depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const { id, depth } of frontier) {
      for (const childId of childMap[id] || []) {
        if (seen.has(childId)) continue;
        const node = nodes[childId];
        if (node?.resource_type !== "model") continue; // models only
        seen.add(childId);
        downstream.push({ name: node.name || childId, depth: depth + 1 });
        next.push({ id: childId, depth: depth + 1 });
      }
    }
    frontier = next;
  }

  const direct = downstream.filter((d) => d.depth === 1);
  const transitive = downstream.filter((d) => d.depth > 1);

  // Tests that reference the target or any downstream model.
  const affectedIds = new Set([targetId, ...seen]);
  const affectedTests = Object.values(nodes).filter(
    (n) => n?.resource_type === "test" && (n.depends_on?.nodes || []).some((dep) => affectedIds.has(dep)),
  );

  const total = downstream.length;
  const severity = total === 0 ? "SAFE" : total <= 3 ? "LOW" : total <= 10 ? "MEDIUM" : "HIGH";

  return {
    model,
    column: column || null,
    change_type: changeType,
    success: true,
    direct_downstream: direct.map((d) => d.name),
    transitive_downstream: transitive.map((d) => d.name),
    downstream_count: total,
    affected_tests: affectedTests.length,
    severity,
  };
}
