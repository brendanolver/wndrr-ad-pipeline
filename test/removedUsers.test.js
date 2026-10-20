'use strict';
// v1.6.8: Angus, Jake and Ronit are removed from the team by DEACTIVATING their accounts once (never deleting them), and are no longer seeded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dbjs = fs.readFileSync(path.join(root, 'src', 'db.js'), 'utf8');
const users = fs.readFileSync(path.join(root, 'src', 'routes', 'users.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'src', 'auth.js'), 'utf8');

test('the three accounts are deactivated once, by a guarded change; nothing is deleted and nobody else is touched', () => {
  const block = dbjs.slice(dbjs.indexOf('const ONE_TIME_CHANGES_SQL'), dbjs.indexOf('async function runMigrations'));
  assert.match(block, /UPDATE users SET active = false[\s\S]*WHERE email IN \('angus@kohindustries\.com', 'jake@kohindustries\.com', 'ronit@kohindustries\.com'\) AND active = true;/);
  assert.match(block, /IF NOT EXISTS \(SELECT 1 FROM app_one_time_changes WHERE change_key = 'deactivate-users-angus-jake-ronit'\)/, 'guarded: fires once');
  assert.match(block, /INSERT INTO app_one_time_changes \(change_key\) VALUES \('deactivate-users-angus-jake-ronit'\)/);
  assert.doesNotMatch(block, /DELETE FROM users|DELETE FROM user_module_restrictions|DROP /i, 'never deletes');
  assert.match(dbjs, /await seedUsersAndBackfill\(\);\n  await pool\.query\(ONE_TIME_CHANGES_SQL\);/, 'runs after the schema and the seed, on every boot, but changes data only once');
});

test('they are no longer seeded, and only active users can log in or appear in the user lists / Module Access', () => {
  const seed = dbjs.slice(dbjs.indexOf('const SEED_USERS = ['), dbjs.indexOf('];', dbjs.indexOf('const SEED_USERS = [')));
  assert.doesNotMatch(seed, /angus|jake|ronit/i); for (const n of ['brendan', 'max', 'steve', 'sheridan', 'mark', 'lucy', 'tllestio']) assert.match(seed, new RegExp(n, 'i'));
  assert.equal((users.match(/WHERE active = true/g) || []).length, 2, 'both user lists only return active users');
  assert.match(auth, /AND active = true/); assert.match(auth, /!user \|\| !user\.active/);
});
