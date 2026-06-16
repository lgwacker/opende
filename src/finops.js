// FinOps — curated Snowflake ACCOUNT_USAGE queries + cost-tier classification,
// the deterministic content behind altimate's finops_* tools. Queries run through
// the native executor (warehouse.query, read-only). Requires ACCOUNT_USAGE grants;
// errors surface gracefully if not granted.
import { query } from "./warehouse.js";

// Cost tiers (credits), matching altimate-code's classification.
export function costTier(credits) {
  const c = Number(credits) || 0;
  if (c < 0.01) return "Cheap";
  if (c <= 1) return "Moderate";
  if (c <= 100) return "Expensive";
  return "Dangerous";
}

const Q = {
  credits: (days) => `
    SELECT TO_DATE(start_time) AS usage_date, warehouse_name,
           SUM(credits_used) AS credits, SUM(credits_used_compute) AS credits_compute
    FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
    WHERE start_time >= DATEADD('day', -${days}, CURRENT_TIMESTAMP())
    GROUP BY 1, 2 ORDER BY credits DESC`,
  expensive: (days, limit) => `
    SELECT query_id, LEFT(query_text, 200) AS query_text, user_name, warehouse_name, query_type,
           bytes_scanned, total_elapsed_time, credits_used_cloud_services AS credits, start_time
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
    WHERE start_time >= DATEADD('day', -${days}, CURRENT_TIMESTAMP())
      AND execution_status = 'SUCCESS'
    ORDER BY bytes_scanned DESC NULLS LAST LIMIT ${limit}`,
  warehouseAdvice: (days) => `
    SELECT warehouse_name, COUNT(*) AS query_count,
           AVG(execution_time)/1000 AS avg_exec_s, AVG(queued_overload_time)/1000 AS avg_queued_s,
           SUM(bytes_scanned) AS total_bytes_scanned
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
    WHERE start_time >= DATEADD('day', -${days}, CURRENT_TIMESTAMP())
    GROUP BY 1 ORDER BY query_count DESC`,
  unusedTables: (days) => `
    SELECT table_catalog, table_schema, table_name, bytes, row_count, last_altered
    FROM SNOWFLAKE.ACCOUNT_USAGE.TABLES
    WHERE deleted IS NULL
      AND last_altered < DATEADD('day', -${days}, CURRENT_TIMESTAMP())
    ORDER BY bytes DESC NULLS LAST LIMIT 50`,
  queryHistory: (days, limit, user) => `
    SELECT query_id, LEFT(query_text, 200) AS query_text, user_name, warehouse_name, query_type,
           execution_status, total_elapsed_time, bytes_scanned, start_time
    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
    WHERE start_time >= DATEADD('day', -${days}, CURRENT_TIMESTAMP())
      ${user ? `AND user_name = '${String(user).replace(/'/g, "''")}'` : ""}
    ORDER BY start_time DESC LIMIT ${limit}`,
};

const run = async (sql, opts) => {
  const { columns, rows } = await query(sql, opts);
  return { columns, rows };
};

export const credits = (days = 30, opts) => run(Q.credits(days), opts);
export const expensiveQueries = (days = 7, limit = 20, opts) => run(Q.expensive(days, limit), opts);
export const warehouseAdvice = (days = 14, opts) => run(Q.warehouseAdvice(days), opts);
export const unusedResources = (days = 30, opts) => run(Q.unusedTables(days), opts);
export const queryHistory = (days = 7, limit = 100, user = null, opts) =>
  run(Q.queryHistory(days, limit, user), opts);

// ── RBAC / governance (ACCOUNT_USAGE grants + tags) ─────────────────────────
const esc = (s) => String(s).replace(/'/g, "''");
const R = {
  roleGrants: (role) => `
    SELECT grantee_name AS role, privilege, granted_on, name AS object_name, granted_by
    FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
    WHERE deleted_on IS NULL ${role ? `AND grantee_name = upper('${esc(role)}')` : ""}
    ORDER BY role, granted_on, privilege LIMIT 500`,
  roleHierarchy: () => `
    SELECT grantee_name AS role, name AS granted_role, granted_by
    FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_ROLES
    WHERE granted_on = 'ROLE' AND deleted_on IS NULL
    ORDER BY role LIMIT 500`,
  userRoles: (user) => `
    SELECT grantee_name AS user_name, role, granted_by
    FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS
    WHERE deleted_on IS NULL ${user ? `AND grantee_name = upper('${esc(user)}')` : ""}
    ORDER BY user_name, role LIMIT 500`,
  tags: (object) => `
    SELECT tag_database, tag_schema, tag_name, tag_value,
           object_database, object_schema, object_name, column_name, domain
    FROM SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES
    WHERE 1=1 ${object ? `AND upper(object_name) = upper('${esc(object)}')` : ""}
    ORDER BY object_name, tag_name LIMIT 500`,
  tagsList: () => `
    SELECT tag_database, tag_schema, tag_name, tag_comment
    FROM SNOWFLAKE.ACCOUNT_USAGE.TAGS
    WHERE deleted IS NULL ORDER BY tag_name LIMIT 500`,
};

export const roleGrants = (role = null, opts) => run(R.roleGrants(role), opts);
export const roleHierarchy = (opts) => run(R.roleHierarchy(), opts);
export const userRoles = (user = null, opts) => run(R.userRoles(user), opts);
export const schemaTags = (object = null, opts) => run(R.tags(object), opts);
export const schemaTagsList = (opts) => run(R.tagsList(), opts);
