// Minimal RFC 4180 CSV/TSV parser for the copy-library import (a Google Sheets tab downloaded as CSV). Handles quoted fields, doubled quotes and
// line breaks inside quotes. The delimiter is detected from the first line (comma, tab or semicolon). Returns string[][]; never throws on malformed
// quotes (an unterminated quote simply runs to the end of the text).
function detectDelimiter(text) {
  const first = String(text).split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let inQ = false;
  for (const ch of first) { if (ch === '"') inQ = !inQ; else if (!inQ && ch in counts) counts[ch] += 1; }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

function parseCsv(input, delimiter) {
  const text = String(input || '').replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else inQ = false; } else field += ch;
    } else if (ch === '"' && field === '') inQ = true;
    else if (ch === d) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

module.exports = { parseCsv, detectDelimiter };
