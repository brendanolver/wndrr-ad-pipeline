const { pool } = require('../db');

// Feature/action-level permission check, backed by role_permissions (see
// schema.sql). Not called from any existing route yet -- per the brief,
// this is the foundation a future route can drop in as a guard, e.g.
// `if (!(await hasPermission(req.user, 'concepts.edit'))) return res.status(403).json(...)`,
// without any schema or service-layer work left to do first.
async function hasPermission(user, permissionKey) {
  if (!user || !user.role) return false;
  const result = await pool.query(
    'SELECT 1 FROM role_permissions WHERE role = $1 AND permission_key = $2',
    [user.role, permissionKey]
  );
  return result.rows.length > 0;
}

module.exports = { hasPermission };
