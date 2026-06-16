// Execution-layer safety gate — mirrors altimate-code's native sql_execute rules,
// implemented with altimate-core's deterministic statement classifier.
//   - DROP DATABASE / DROP SCHEMA / TRUNCATE are HARD-blocked (unoverridable).
//   - Non-read statements require allowWrite:true (default deny — like Analyst mode).
import { call } from "./core.js";

const HARD_DENY_RE = [
  /^\s*DROP\s+DATABASE\b/i,
  /^\s*DROP\s+SCHEMA\b/i,
  /^\s*TRUNCATE(\s+TABLE)?\b/i,
];
const HARD_DENY_TYPES = new Set(["DROP DATABASE", "DROP SCHEMA", "TRUNCATE", "TRUNCATE TABLE"]);
const HARD_DENY_MSG =
  "DROP DATABASE, DROP SCHEMA, and TRUNCATE are blocked for safety. This cannot be overridden.";

/**
 * Gate a SQL string before execution. Throws on hard-denied or (unless allowWrite)
 * non-read statements. Returns { read, types }.
 */
export async function gateSql(sql, { allowWrite = false } = {}) {
  for (const re of HARD_DENY_RE) {
    if (re.test(sql)) throw new Error(HARD_DENY_MSG);
  }
  let types = [];
  let categories = [];
  try {
    const r = await call("getStatementTypes", [sql, "snowflake"]);
    types = r.types || [];
    categories = r.categories || [];
  } catch {
    // parser unavailable — fall back to regex-only read detection below
  }
  if (types.some((t) => HARD_DENY_TYPES.has(String(t).toUpperCase()))) {
    throw new Error(HARD_DENY_MSG);
  }
  // Read iff every statement is a query (categories from the engine), with a
  // regex fallback when the parser returned nothing.
  const read =
    categories.length > 0
      ? categories.every((c) => String(c).toLowerCase() === "query")
      : /^\s*(SELECT|WITH|SHOW|EXPLAIN|DESCRIBE|DESC)\b/i.test(sql);
  if (!read && !allowWrite) {
    throw new Error(
      "Non-SELECT statement blocked. Pass allow_write:true to run write/DDL " +
        "(DROP DATABASE/SCHEMA and TRUNCATE stay hard-blocked)."
    );
  }
  return { read, types };
}
