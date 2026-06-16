// Native Snowflake executor (snowflake-sdk, pooled single connection) — the
// "executor" half of the hybrid design. Credentials come from the dbt profile
// (profiles.js). Every query passes the altimate-core safety gate; reads get an
// auto-LIMIT; results render as a clean ASCII table (mirrors altimate's output).
import { loadProfile, snowflakeConnectionOptions } from "./profiles.js";
import { gateSql } from "./safety.js";

// snowflake-sdk is an OPTIONAL dependency — the offline analysis tools (lint,
// lineage, equivalence, schema_verify, the gate, the PR-review engine) never
// need it. Load it lazily so the MCP server boots and lists all tools even when
// it's not installed; only the warehouse/finops/data_diff tools require it.
let _sf = null;
async function sdk() {
  if (_sf) return _sf;
  try {
    _sf = (await import("snowflake-sdk")).default;
  } catch {
    throw new Error(
      "snowflake-sdk is not installed. Install it (`npm i snowflake-sdk`) to use the " +
        "warehouse / finops / data_diff tools. The offline analysis tools work without it."
    );
  }
  try { _sf.configure({ logLevel: "ERROR" }); } catch { /* older sdk */ }
  return _sf;
}

let _connPromise = null;

async function connect(opts) {
  const snowflake = await sdk();
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(opts);
    conn.connect((err, c) => (err ? reject(err) : resolve(c)));
  });
}

async function getConnection({ projectDir, target } = {}) {
  if (_connPromise) return _connPromise;
  const { config, missingEnvVars, target: tgt } = loadProfile({ projectDir, target });
  if (missingEnvVars.length) {
    throw new Error(
      `Cannot connect to Snowflake — missing env var(s) for target '${tgt}': ${missingEnvVars.join(", ")}. ` +
        "Set them (the dbt profile reads them via env_var) and retry."
    );
  }
  _connPromise = connect(snowflakeConnectionOptions(config)).catch((e) => {
    _connPromise = null; // allow retry after a transient failure
    throw e;
  });
  return _connPromise;
}

function runStatement(conn, sqlText) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err, stmt, rows) => {
        if (err) return reject(err);
        const columns = stmt.getColumns().map((c) => c.getName());
        resolve({ columns, rows: rows || [] });
      },
    });
  });
}

const hasLimit = (sql) => /\blimit\s+\d+\s*;?\s*$/i.test(sql.trim());

/** Low-level: gate + run, return objects. No LIMIT injection (used by finops/data_diff). */
export async function query(sql, { allowWrite = false, projectDir, target } = {}) {
  await gateSql(sql, { allowWrite });
  const conn = await getConnection({ projectDir, target });
  return runStatement(conn, sql);
}

/** sql_execute: gate + auto-LIMIT + structured result with a truncation flag. */
export async function execute(sql, { limit = 100, allowWrite = false, projectDir, target } = {}) {
  const gate = await gateSql(sql, { allowWrite });
  const sqlText =
    gate.read && limit > 0 && !hasLimit(sql) ? `${sql.replace(/;\s*$/, "")} LIMIT ${limit}` : sql;
  const conn = await getConnection({ projectDir, target });
  const { columns, rows } = await runStatement(conn, sqlText);
  const truncated = gate.read && limit > 0 && rows.length === limit;
  return {
    columns,
    rows: rows.map((r) => columns.map((c) => r[c])),
    row_count: rows.length,
    truncated,
  };
}

/** Rows as nullable-string matrix — the shape altimate-core DataParitySession wants. */
export function rowsToStringMatrix(columns, rows) {
  return rows.map((r) =>
    columns.map((c) => {
      const v = r[c];
      return v === null || v === undefined ? null : String(v);
    })
  );
}

/** ASCII table rendering — mirrors altimate's formatResult. */
export function formatTable(result) {
  if (!result.row_count) return "(0 rows)";
  const { columns, rows } = result;
  const header = columns.join(" | ");
  const sep = columns.map((c) => "-".repeat(Math.max(c.length, 4))).join("-+-");
  const body = rows
    .map((r) => r.map((v) => (v === null || v === undefined ? "NULL" : String(v))).join(" | "))
    .join("\n");
  return `${header}\n${sep}\n${body}\n(${result.row_count} rows)${result.truncated ? " [truncated]" : ""}`;
}

/** Connectivity check for the active target (=warehouse_test). Never throws. */
export async function test({ projectDir, target } = {}) {
  const { loadProfile } = await import("./profiles.js");
  let info;
  try {
    info = loadProfile({ projectDir, target });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (info.missingEnvVars.length) {
    return { ok: false, target: info.target, missing_env_vars: info.missingEnvVars };
  }
  try {
    const r = await query("SELECT 1 AS ok", { projectDir, target });
    return { ok: r.rows.length === 1, target: info.target, profile: info.profileName };
  } catch (e) {
    return { ok: false, target: info.target, error: String(e?.message || e) };
  }
}

export async function close() {
  if (!_connPromise) return;
  try {
    const conn = await _connPromise;
    await new Promise((res) => conn.destroy(() => res()));
  } catch { /* ignore */ }
  _connPromise = null;
}
