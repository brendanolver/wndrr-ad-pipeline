'use strict';
// Settings: Meta Performance (default), Meta Sync and Meta Mapping are ONE "Meta" section with toggles between the three views; each view is still its own panel with its own loader.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('one Meta tab replaces Meta Mapping, Meta Sync and Meta Performance in the section tabs', () => {
  const nav = html.slice(html.indexOf('<div class="settings-subnav">'), html.indexOf('<!-- One "Meta" section'));
  assert.match(nav, /id="settings-meta-tab-btn" data-settings-panel="meta">Meta<\/button>/);
  for (const gone of ['data-settings-panel="meta-mapping"', 'data-settings-panel="meta-sync"', 'data-settings-panel="meta-benchmarks"']) assert.ok(!nav.includes(gone), `${gone} is no longer a section tab`);
  const labels = [...nav.matchAll(/data-settings-panel="[^"]+"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Planning', 'Shoot Prep', 'Creative Playbook', 'Meta', 'Users', 'Creative Classification', 'Copy Library']);
});

test('the three toggles, admin-only ones hidden until the role check shows them; the panels and ids are unchanged', () => {
  const toggle = html.slice(html.indexOf('id="settings-meta-toggle"'), html.indexOf('</div>', html.indexOf('id="settings-meta-toggle"')));
  assert.match(toggle, /data-meta-sub="meta-benchmarks" style="display:none;">Meta Performance[\s\S]*data-meta-sub="meta-sync" style="display:none;">Meta Sync[\s\S]*data-meta-sub="meta-mapping">Meta Mapping/, 'Meta Performance first (the default), Meta Sync, Meta Mapping');
  for (const id of ['settings-panel-meta-benchmarks', 'settings-panel-meta-sync', 'settings-panel-meta-mapping']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(app, /getElementById\('settings-meta-sync-tab-btn'\)[\s\S]*role === 'admin'/); assert.match(app, /getElementById\('settings-meta-benchmarks-tab-btn'\)[\s\S]*role === 'admin'/);
});

test('switching: Meta opens on Meta Performance for an admin (Meta Mapping otherwise), remembers the last view, and every old entry point still works', () => {
  const sw = app.slice(app.indexOf('const SETTINGS_META_VIEWS'), app.indexOf("  // Round 11: admin-only User Access panel"));
  assert.match(sw, /admin \? 'meta-benchmarks' : 'meta-mapping'/); assert.match(sw, /state\.settingsMetaView = name/); assert.match(sw, /name === 'meta'\) name = settingsMetaDefaultView\(\)/);
  assert.match(sw, /b\.dataset\.settingsPanel === \(inMeta \? 'meta' : name\)/, 'the Meta tab stays highlighted for any of its views');
  assert.match(app, /if \(name === 'meta-sync'\) loadMetaSyncPanel\(\);/); assert.match(app, /if \(name === 'meta-benchmarks'\) loadMetaBenchmarksPanel\(\);/);
  assert.match(app, /switchSettingsPanel\('meta-benchmarks'\)/, 'the "open benchmark settings" link from Meta Performance still lands on the right view');
  assert.match(app, /#settings-meta-toggle \[data-meta-sub\]/);
});
