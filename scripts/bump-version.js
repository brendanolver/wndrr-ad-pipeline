#!/usr/bin/env node
// Records a change: adds the next version to version-history.json (newest first) and keeps package.json's version the same.
//   npm run bump -- "Short title" "What changed" "Another thing that changed"
// The first argument is the title, any others are bullet points. Nothing is deployed or pushed by this script.
const fs = require('fs');
const path = require('path');
const v = require('../src/lib/version');

const [title, ...changes] = process.argv.slice(2);
if (!title) {
  console.error('Usage: npm run bump -- "Short title" ["What changed" ...]');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(v.FILE, 'utf8'));
const prev = data.entries.length ? data.entries[0].version : null;
const version = prev ? v.nextVersion(prev) : '1.0.0';
// the date is the team's date: Sydney
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
data.entries.unshift({ version, date, title, changes });
fs.writeFileSync(v.FILE, `${JSON.stringify(data, null, 2)}\n`);

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`${prev || '(none)'} -> ${version}  ${title}`);
