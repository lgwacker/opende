// data_diff — drives altimate-core's DataParitySession (the DB-agnostic Rust diff
// state machine) and executes the SQL it emits via the native executor, looping
// start()/step() until Done. Same-Snowflake table/query diffs; cross-warehouse
// would require a second connection (deferred).
import { loadCore } from "./core.js";
import { query, rowsToStringMatrix } from "./warehouse.js";

const MAX_STEPS = 200;

// Default executor: run a SELECT via the native Snowflake executor, return string[][].
async function defaultExecutor(sql) {
  const { columns, rows } = await query(sql); // read-only; gate allows SELECT/WITH
  return rowsToStringMatrix(columns, rows);
}

function buildSpec(p) {
  return {
    table1: { table: p.source, database: p.source_database, schema: p.source_schema },
    table2: { table: p.target, database: p.target_database, schema: p.target_schema },
    dialect1: p.dialect || "snowflake",
    dialect2: p.dialect || "snowflake",
    config: {
      algorithm: p.algorithm || "auto",
      key_columns: p.key_columns || [],
      extra_columns: p.extra_columns ?? null,
      where_clause: p.where_clause ?? null,
      numeric_tolerance: p.numeric_tolerance ?? null,
      timestamp_tolerance_ms: p.timestamp_tolerance_ms ?? null,
    },
  };
}

/**
 * Run a data parity comparison.
 * @param params { source, target, key_columns, extra_columns?, algorithm?, where_clause?, ...db/schema }
 * @param opts.executor async (sql) => string[][]  (injectable for tests; defaults to Snowflake)
 */
export async function runDataDiff(params, { executor = defaultExecutor } = {}) {
  const Session = loadCore().DataParitySession;
  const session = new Session(JSON.stringify(buildSpec(params)));

  let actionJson = session.start();
  for (let step = 0; step < MAX_STEPS; step++) {
    const action = JSON.parse(actionJson);
    if (action.type === "Done") return { success: true, steps: step, outcome: action.outcome };
    if (action.type === "Error") return { success: false, steps: step, error: action.message ?? "engine error" };
    if (action.type !== "ExecuteSql") return { success: false, steps: step, error: `unexpected action: ${action.type}` };

    const responses = await Promise.all(
      (action.tasks || []).map(async (task) => {
        try {
          return { id: task.id, rows: await executor(task.sql, task.table_side) };
        } catch (e) {
          return { id: task.id, rows: [], error: String(e?.message || e) };
        }
      })
    );
    actionJson = session.step(JSON.stringify(responses));
  }
  return { success: false, error: `exceeded ${MAX_STEPS} steps` };
}

/** Format the diff outcome for display (keeps the ≤5 sample-row convention). */
export function formatDiff(res) {
  if (!res.success) return `data_diff failed: ${res.error}`;
  const o = res.outcome || {};
  const s = o.stats || {};
  const lines = [
    o.identical || s.exclusive_table1 === 0 && s.exclusive_table2 === 0 && (s.updated ?? 0) === 0
      ? "✓ Tables are IDENTICAL"
      : "✗ Tables DIFFER",
    `  rows: source=${s.rows_table1 ?? "?"} target=${s.rows_table2 ?? "?"}`,
    `  only-in-source=${s.exclusive_table1 ?? 0} only-in-target=${s.exclusive_table2 ?? 0} updated=${s.updated ?? 0}`,
  ];
  const sample = (o.diff_rows || []).slice(0, 5);
  if (sample.length) {
    lines.push(`  sample differences (first ${sample.length}) — NOTE: these row values are shown to the model:`);
    for (const d of sample) {
      const label = d.sign === "-" ? "source only" : "target only";
      lines.push(`    [${label}] ${(d.values || []).join(" | ") || "(no values)"}`);
    }
  }
  return lines.join("\n");
}
