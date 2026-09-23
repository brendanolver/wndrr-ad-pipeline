const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { hashPassword, verifyPassword } = require('./lib/passwordHash');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Provision a Postgres instance and set it (Railway does this automatically).');
}

const useSsl = process.env.PGSSL !== 'disable' && process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

// The real team accounts this app is seeded with (see schema.sql's Users &
// Auth comment for why this lives in JS, not schema.sql: hashing needs
// Node's crypto, not plain SQL). Runs on every boot, guarded to only ever
// insert a user once (by email) -- adding a real invite/admin flow is
// explicitly out of scope for V1, so this is the only way new accounts get
// created right now. Initial password is today's shared APP_PASSWORD, so
// nobody's access changes the moment this ships; anyone can be given a real
// distinct password later via a direct DB update (no reset flow yet).
// Round 11 added Angus/Jake/Tllestio/Ronit (the four named users who didn't
// already exist) with the roles/restrictions the brief's initial access
// matrix calls for; the five who already existed (Max/Steve/Sheridan/Mark/
// Lucy) have their role correction and Mark's module restrictions handled
// as one-time guarded migrations in schema.sql instead, since this array is
// only ever consulted for a brand-new insert, never to update an existing
// row -- these entries are kept in sync with that same target state purely
// so a from-scratch environment seeds correctly without relying on the
// schema.sql guard's "old role was creative" condition ever having applied.
// restrictedModules (optional): module_key values seeded into
// user_module_restrictions the moment this account is first created --
// never re-applied afterward (see the loop below), so an admin's later
// edit in Settings is never overwritten by a future redeploy.
// testPassword (Round 12, PR #216 test environment only): each named
// person's own individual login password, replacing the shared APP_PASSWORD
// everyone was seeded with up to Round 11. Applied by the self-guarding
// migration below -- it never touches an account whose password has already
// been changed away from the shared APP_PASSWORD (by an admin, or by this
// same migration on a prior boot), so it can never clobber a real password
// change. This branch (PR #216) never runs against the production database
// (production deploys from its own separate branch), so this cannot affect
// production credentials.
const SEED_USERS = [
  { name: 'Brendan', email: 'brendan@kohindustries.com', role: 'admin', testPassword: '1000' },
  { name: 'Max', email: 'max@kohindustries.com', role: 'admin', testPassword: '0000' },
  { name: 'Steve', email: 'steve@kohindustries.com', role: 'lead', testPassword: '1004' },
  { name: 'Sheridan', email: 'sheridan@kohindustries.com', role: 'lead', testPassword: '1003' },
  { name: 'Mark', email: 'mark@kohindustries.com', role: 'member', restrictedModules: ['planning', 'board', 'admin'], testPassword: '1005' },
  { name: 'Lucy', email: 'lucy@kohindustries.com', role: 'admin', testPassword: '1002' },
  { name: 'Angus', email: 'angus@kohindustries.com', role: 'lead', testPassword: '1008' },
  { name: 'Jake', email: 'jake@kohindustries.com', role: 'lead', testPassword: '1009' },
  { name: 'Tllestio', email: 'tllestio@kohindustries.com', role: 'member', restrictedModules: ['planning', 'board', 'admin'], testPassword: '1006' },
  { name: 'Ronit', email: 'ronit@kohindustries.com', role: 'member', restrictedModules: ['planning', 'board', 'admin'], testPassword: '1007' },
];

async function seedUsersAndBackfill() {
  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) return; // Nothing to seed an initial password from -- skip until it's set.

  for (const u of SEED_USERS) {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [u.email]);
    if (existing.rows.length) continue;
    const inserted = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [u.name, u.email, hashPassword(appPassword), u.role]
    );
    // Only reached for a row that didn't exist a moment ago -- safe to seed
    // unconditionally, this can never re-fire for this account again.
    for (const moduleKey of u.restrictedModules || []) {
      await pool.query(
        'INSERT INTO user_module_restrictions (user_id, module_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [inserted.rows[0].id, moduleKey]
      );
    }
  }

  // Round 12: give each named person their own individual password, but
  // only for an account that still has the original shared APP_PASSWORD --
  // verified by actually checking the hash, not a marker column, so this
  // can run on every boot and still never overwrite a password an admin (or
  // this same migration, on a previous boot) already set. See the
  // SEED_USERS comment above for why this is safe on this branch.
  for (const u of SEED_USERS) {
    if (!u.testPassword) continue;
    const existing = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [u.email]);
    if (!existing.rows.length) continue;
    const row = existing.rows[0];
    if (!verifyPassword(appPassword, row.password_hash)) continue; // already customized -- leave it alone
    await pool.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hashPassword(u.testPassword), row.id]);
  }

  // Link (or create) each seed user's content_creators row -- see
  // schema.sql's comment on content_creators.user_id. Never overwrites an
  // existing row's is_default/size defaults, only fills in the link.
  for (const u of SEED_USERS) {
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [u.email]);
    const userId = userResult.rows[0] && userResult.rows[0].id;
    if (!userId) continue;

    const ccResult = await pool.query(
      'SELECT id, user_id FROM content_creators WHERE user_id = $1 OR LOWER(name) = LOWER($2)',
      [userId, u.name]
    );
    if (ccResult.rows.length) {
      if (!ccResult.rows[0].user_id) {
        await pool.query('UPDATE content_creators SET user_id = $1 WHERE id = $2', [userId, ccResult.rows[0].id]);
      }
      continue;
    }
    await pool.query(
      'INSERT INTO content_creators (name, user_id) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [u.name, userId]
    );
  }

  // Best-effort backfill of created_by_user_id on historical shoot_plan_items
  // by matching their plain-text creator name to a user -- never overwrites
  // an already-linked row.
  await pool.query(`
    UPDATE shoot_plan_items spi SET created_by_user_id = u.id
    FROM users u WHERE spi.created_by_user_id IS NULL AND LOWER(spi.creator) = LOWER(u.name)
  `);
}

async function runMigrations() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  await seedUsersAndBackfill();

  if (process.env.SEED_EXAMPLE_DATA === 'true') {
    const seed = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
    await pool.query(seed);
  }
}

module.exports = { pool, runMigrations };
