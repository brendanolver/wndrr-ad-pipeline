const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { hashPassword } = require('./lib/passwordHash');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Provision a Postgres instance and set it (Railway does this automatically).');
}

const useSsl = process.env.PGSSL !== 'disable' && process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

// The six real team accounts this app is seeded with (see schema.sql's
// Users & Auth comment for why this lives in JS, not schema.sql: hashing
// needs Node's crypto, not plain SQL). Runs on every boot, guarded to only
// ever insert a user once (by email) -- adding a real invite/admin flow is
// explicitly out of scope for V1, so this is the only way new accounts get
// created right now. Initial password is today's shared APP_PASSWORD, so
// nobody's access changes the moment this ships; anyone can be given a real
// distinct password later via a direct DB update (no reset flow yet).
const SEED_USERS = [
  { name: 'Brendan', email: 'brendan@kohindustries.com', role: 'admin' },
  { name: 'Max', email: 'max@kohindustries.com', role: 'creative' },
  { name: 'Steve', email: 'steve@kohindustries.com', role: 'creative' },
  { name: 'Sheridan', email: 'sheridan@kohindustries.com', role: 'creative' },
  { name: 'Mark', email: 'mark@kohindustries.com', role: 'creative' },
  { name: 'Lucy', email: 'lucy@kohindustries.com', role: 'creative' },
];

async function seedUsersAndBackfill() {
  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) return; // Nothing to seed an initial password from -- skip until it's set.

  for (const u of SEED_USERS) {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [u.email]);
    if (existing.rows.length) continue;
    await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [u.name, u.email, hashPassword(appPassword), u.role]
    );
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
