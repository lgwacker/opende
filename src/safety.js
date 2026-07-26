// Execution-layer safety gate — mirrors altimate-code's native sql_execute rules,
// implemented with altimate-core's deterministic statement classifier.
//   - DROP DATABASE / DROP SCHEMA / TRUNCATE are HARD-blocked (unoverridable).
//   - Non-read statements require allowWrite:true (default deny — like Analyst mode).
//
// Defence in depth, because neither layer is sufficient alone:
//   1. TEXTUAL  — comment-stripped, per-statement pattern match. Survives a
//      parser failure, and is what makes the hard-deny genuinely unoverridable.
//   2. CLASSIFIER — altimate-core's statement types/categories. Catches forms
//      the patterns don't anticipate, but only when the SQL actually parses.
// The engine throws on plenty of real DDL (`DROP DATABASE IF EXISTS x CASCADE`
// is a parse error today), so layer 1 must never depend on layer 2 succeeding.
import { call } from "./core.js";

// Applied to the start of each individual statement, after comments are stripped.
const HARD_DENY_RE = [
  /^\s*DROP\s+DATABASE\b/i,
  /^\s*DROP\s+SCHEMA\b/i,
  /^\s*TRUNCATE(\s+TABLE)?\b/i,
];

// Applied ANYWHERE in the statement, for forms that hide the DDL away from the
// start (dynamic SQL, procedural blocks). Deliberately stricter than the
// start-anchored set: each requires a real object name to follow, so MySQL's
// `TRUNCATE(x)` numeric function and a `drop_database` identifier don't match.
const HARD_DENY_ANYWHERE_RE = [
  /\bDROP\s+DATABASE\s+(IF\s+EXISTS\s+)?["'`[\w]/i,
  /\bDROP\s+SCHEMA\s+(IF\s+EXISTS\s+)?["'`[\w]/i,
  /\bTRUNCATE\s+(TABLE\s+)?(IF\s+EXISTS\s+)?["'`[\w]/i,
];

// Statement forms that execute a string as SQL — the one place where a string
// literal is not inert, so hard-deny patterns are matched against the raw text.
const DYNAMIC_SQL_RE = /\bEXECUTE\s+IMMEDIATE\b|\bEXEC(UTE)?\s*\(/i;

const HARD_DENY_TYPES = new Set(["DROP DATABASE", "DROP SCHEMA", "TRUNCATE", "TRUNCATE TABLE"]);
const HARD_DENY_MSG =
  "DROP DATABASE, DROP SCHEMA, and TRUNCATE are blocked for safety. This cannot be overridden.";

const READ_START_RE = /^\s*(SELECT|WITH|SHOW|EXPLAIN|DESCRIBE|DESC)\b/i;

/**
 * Single pass over the SQL, tracking quoting so comments inside string literals
 * are preserved and `;` inside literals doesn't split a statement. Returns the
 * comment-free text, the same text with string literals blanked (for pattern
 * scans that must not trip over quoted keywords), and the statement split.
 *
 * Handles '…' and "…" (with '' / "" escaping), $$…$$ dollar-quoting, `--` and
 * `#` line comments, and `/* … *\/` block comments.
 */
export function normalizeSql(sql) {
  const text = String(sql ?? "");
  let stripped = "";  // comments removed, literals intact
  let blanked = "";   // comments removed, literal CONTENTS replaced with spaces
  const ends = [];    // offsets (into `stripped`) of statement-separating `;`

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      stripped += "\n"; blanked += "\n";
      continue;
    }
    if (ch === "#" && (stripped === "" || /\s/.test(stripped.at(-1) ?? " "))) {
      while (i < text.length && text[i] !== "\n") i++;
      stripped += "\n"; blanked += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // land on the '/', loop's i++ steps past it
      stripped += " "; blanked += " ";
      continue;
    }
    if (ch === "$" && next === "$") {
      const close = text.indexOf("$$", i + 2);
      const end = close === -1 ? text.length : close + 2;
      const body = text.slice(i, end);
      stripped += body;
      blanked += "$$" + " ".repeat(Math.max(0, body.length - 4)) + "$$";
      i = end - 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let body = "";
      while (j < text.length) {
        if (text[j] === "\\" && (ch === "'" || ch === '"')) { body += text.slice(j, j + 2); j += 2; continue; }
        if (text[j] === ch) {
          if (text[j + 1] === ch) { body += ch + ch; j += 2; continue; } // '' escape
          break;
        }
        body += text[j]; j++;
      }
      stripped += ch + body + (j < text.length ? ch : "");
      blanked += ch + " ".repeat(body.length) + (j < text.length ? ch : "");
      i = j;
      continue;
    }
    if (ch === ";") ends.push(stripped.length);
    stripped += ch;
    blanked += ch;
  }

  const statements = [];
  let from = 0;
  for (const at of [...ends, stripped.length]) {
    const raw = stripped.slice(from, at);
    if (raw.trim()) statements.push({ stripped: raw, blanked: blanked.slice(from, at) });
    from = at + 1;
  }
  return { stripped, blanked, statements };
}

/** True when this statement is a hard-denied destructive operation. */
function isHardDenied({ stripped, blanked }) {
  if (HARD_DENY_RE.some((re) => re.test(stripped))) return true;
  // Literals are blanked here so `SELECT 'DROP DATABASE x'` stays a read…
  if (HARD_DENY_ANYWHERE_RE.some((re) => re.test(blanked))) return true;
  // …except under EXECUTE IMMEDIATE, where the literal IS the statement.
  if (DYNAMIC_SQL_RE.test(blanked) && HARD_DENY_ANYWHERE_RE.some((re) => re.test(stripped))) return true;
  return false;
}

/**
 * Gate a SQL string before execution. Throws on hard-denied or (unless allowWrite)
 * non-read statements. Returns { read, types, parsed }.
 *
 * `parsed: false` means the engine could not classify the SQL. The textual layer
 * still ran, but read-detection then falls back to a pattern that only trusts a
 * SINGLE statement — otherwise `SELECT 1; DROP TABLE t` would read as a query and
 * slip past the default-deny.
 */
export async function gateSql(sql, { allowWrite = false } = {}) {
  const { statements } = normalizeSql(sql);
  for (const stmt of statements) {
    if (isHardDenied(stmt)) throw new Error(HARD_DENY_MSG);
  }

  let types = [];
  let categories = [];
  let parsed = true;
  try {
    const r = await call("getStatementTypes", [sql, "snowflake"]);
    types = r.types || [];
    categories = r.categories || [];
  } catch {
    parsed = false; // engine can't parse it — textual layer above is the guarantee
  }
  if (types.some((t) => HARD_DENY_TYPES.has(String(t).toUpperCase()))) {
    throw new Error(HARD_DENY_MSG);
  }

  // Read iff every statement is a query (categories from the engine). Without a
  // parse, only a lone unambiguously-read statement qualifies.
  const read =
    categories.length > 0
      ? categories.every((c) => String(c).toLowerCase() === "query")
      : statements.length === 1 && READ_START_RE.test(statements[0].stripped);

  if (!read && !allowWrite) {
    throw new Error(
      "Non-SELECT statement blocked. Pass allow_write:true to run write/DDL " +
        "(DROP DATABASE/SCHEMA and TRUNCATE stay hard-blocked)."
    );
  }
  return { read, types, parsed };
}
