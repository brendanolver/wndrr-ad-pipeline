// App version + history. The version is shown in the sidebar ("VER. 1.0.0") and every change gets a new entry in version-history.json (newest first), so anyone can see
// when something changed and what it was.
//
// NUMBERING (the team's rule, not semver): three digits, each 0 to 9, counting up like an odometer.
//   1.0.0 -> 1.0.1 -> ... -> 1.0.9 -> 1.1.0 -> ... -> 1.9.9 -> 2.0.0
// A change always bumps the LAST digit; a digit that would pass 9 resets to 0 and carries into the one before it.
// Entries are added with `npm run bump -- "short title" "what changed" "what else changed"` (scripts/bump-version.js), which also keeps package.json in step.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'version-history.json');
const VERSION_RE = /^(\d+)\.([0-9])\.([0-9])$/;

function parse(v) {
  const m = VERSION_RE.exec(String(v || ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// 1.0.9 -> 1.1.0, 1.9.9 -> 2.0.0, 1.2.3 -> 1.2.4
function nextVersion(v) {
  const p = parse(v);
  if (!p) throw new Error(`"${v}" is not a version like 1.0.0 (major, then minor and patch digits 0-9)`);
  let [a, b, c] = p;
  c += 1;
  if (c > 9) { c = 0; b += 1; }
  if (b > 9) { b = 0; a += 1; }
  return `${a}.${b}.${c}`;
}

function load(file = FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return { scheme: raw.scheme || '', entries };
}

function current(file = FILE) {
  const { entries } = load(file);
  return entries.length ? entries[0].version : null;
}

module.exports = { FILE, parse, nextVersion, load, current };
