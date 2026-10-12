// App version + history: the odometer numbering rule (1.0.9 -> 1.1.0, 1.9.9 -> 2.0.0), a well-formed history, and package.json / the history staying in step.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@localhost:5432/unused';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const v = require('../src/lib/version');

test('numbering counts up like an odometer: the last digit bumps, a digit past 9 resets and carries', () => {
  assert.equal(v.nextVersion('1.0.0'), '1.0.1');
  assert.equal(v.nextVersion('1.0.8'), '1.0.9');
  assert.equal(v.nextVersion('1.0.9'), '1.1.0');
  assert.equal(v.nextVersion('1.2.9'), '1.3.0');
  assert.equal(v.nextVersion('1.9.9'), '2.0.0');
  assert.equal(v.nextVersion('9.9.9'), '10.0.0');
});

test('anything that is not a version is refused, never guessed at', () => {
  ['', null, '1.0', '1.0.10', '1.10.0', 'a.b.c', '1.0.0.0', '01.x.0'].forEach((bad) => assert.throws(() => v.nextVersion(bad), /not a version/, String(bad)));
  assert.equal(v.parse('1.0.10'), null, 'a patch digit is 0-9');
  assert.deepEqual(v.parse('12.3.4'), [12, 3, 4], 'the first number can be any size');
});

test('version-history.json: newest first, every entry complete, each version is the next one after the entry below it, no duplicates', () => {
  const { entries } = v.load();
  assert.ok(entries.length >= 1, 'there is at least the starting version');
  entries.forEach((e) => {
    assert.ok(v.parse(e.version), `${e.version} is a valid version`);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/, `${e.version} has a date`);
    assert.ok(e.title && e.title.length > 2, `${e.version} has a title`);
    assert.ok(Array.isArray(e.changes), `${e.version} lists its changes`);
  });
  for (let i = 0; i < entries.length - 1; i += 1) {
    assert.equal(v.nextVersion(entries[i + 1].version), entries[i].version, `${entries[i].version} follows ${entries[i + 1].version}`);
    assert.ok(entries[i].date >= entries[i + 1].date, 'dates never go backwards');
  }
  assert.equal(entries[entries.length - 1].version, '1.0.0', 'numbering starts at 1.0.0');
});

test('package.json carries the same version as the newest history entry (npm run bump keeps them together)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.version, v.current(), 'run `npm run bump -- "title" "change"` to record a change instead of editing either by hand');
  assert.equal(pkg.scripts.bump, 'node scripts/bump-version.js');
});

test('the sidebar shows the version, opens the history, and the API is behind sign-in', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="sidebar-version"[^>]*>VER\. <span id="sidebar-version-num">/);
  assert.match(html, /id="version-modal"/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /app\.use\('\/api\/version', requireAuth, versionRoutes\)/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /api\('\/version'\)/);
});
