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

// Round 11: per-user module (sidebar tab) access -- see schema.sql's
// user_module_restrictions comment for the deny-list/safe-default
// reasoning. Matches index.html's tab-btn data-tab values 1:1.
const ALL_MODULE_KEYS = [
  'dashboard', 'planning', 'concept-dev', 'tuesday-review', 'shooting', 'editing',
  'final-approval', 'board', 'admin', 'reference-library', 'drops', 'promotions', 'settings',
];

async function getRestrictedModules(userId) {
  const result = await pool.query('SELECT module_key FROM user_module_restrictions WHERE user_id = $1', [userId]);
  return result.rows.map((r) => r.module_key);
}

async function canAccessModule(userId, moduleKey) {
  const result = await pool.query(
    'SELECT 1 FROM user_module_restrictions WHERE user_id = $1 AND module_key = $2',
    [userId, moduleKey]
  );
  return result.rows.length === 0;
}

// First real route-level guard for module access (see the Round 11 brief,
// item 12: "prefer also protecting the route/page itself rather than only
// hiding navigation"). Mounted alongside requireAuth on each module's API
// routes in server.js -- a restricted user hitting the API directly (not
// just the hidden sidebar link) gets a 403, not just a UI that never shows
// the button. This protects the module's OWN API routes; it does not (yet)
// audit every cross-module reference (e.g. a Promotion pulling in a Styles
// & Categories style_id) for the same restriction -- see the report's
// "remaining risks" for what a fuller pass would still need to cover.
function requireModuleAccess(moduleKey) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
      const allowed = await canAccessModule(req.user.id, moduleKey);
      if (!allowed) return res.status(403).json({ error: 'You do not have access to this module.' });
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

module.exports = { hasPermission, ALL_MODULE_KEYS, getRestrictedModules, canAccessModule, requireModuleAccess, requireAdmin };
