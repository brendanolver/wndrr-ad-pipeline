const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Provision a Postgres instance and set it (Railway does this automatically).');
}

const useSsl = process.env.PGSSL !== 'disable' && process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

async function runMigrations() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);

  if (process.env.SEED_EXAMPLE_DATA === 'true') {
    const seed = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
    await pool.query(seed);
  }
}

module.exports = { pool, runMigrations };
