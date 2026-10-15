// Read-only Google Sheets client for the WNDRR copy library. Server side only: the credentials never reach the browser.
//
// Configuration (environment variables, nothing is stored in the repository):
//   GOOGLE_SERVICE_ACCOUNT_JSON   the service-account key JSON (raw JSON, or the same JSON base64-encoded)
//   WNDRR_COPY_SHEET_ID           the spreadsheet id (defaults to the WNDRR copy library)
// The spreadsheet must be shared (Viewer is enough) with the service account's client_email. Only the read-only Sheets scope is requested,
// so this code cannot modify the source spreadsheet even by mistake.
//
// GOOGLE_TOKEN_URL / GOOGLE_SHEETS_API_BASE exist only so tests can point at a local mock; production leaves them unset.

const crypto = require('crypto');

const DEFAULT_SHEET_ID = '1XfXE2nvgFgVkiys21v20jDPCdVbz7zPO7wmgRkilkIo';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

class SheetsError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status || null; }
}

function sheetId(env = process.env) { return (env.WNDRR_COPY_SHEET_ID || DEFAULT_SHEET_ID).trim(); }

// → { configured, reason, credentials?: { client_email, private_key } }
function readCredentials(env = process.env) {
  const raw = (env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return { configured: false, reason: 'GOOGLE_SERVICE_ACCOUNT_JSON is not set. Create a Google service account, share the spreadsheet with its email (Viewer) and set this variable to its JSON key.' };
  let text = raw;
  if (!raw.startsWith('{')) {
    try { text = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { return { configured: false, reason: 'GOOGLE_SERVICE_ACCOUNT_JSON is neither JSON nor base64-encoded JSON.' }; }
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { return { configured: false, reason: 'GOOGLE_SERVICE_ACCOUNT_JSON could not be parsed as JSON.' }; }
  if (!json.client_email || !json.private_key) return { configured: false, reason: 'GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.' };
  return { configured: true, reason: null, credentials: { client_email: json.client_email, private_key: String(json.private_key).replace(/\\n/g, '\n') } };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

function signJwt(credentials, now = Math.floor(Date.now() / 1000), env = process.env) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: credentials.client_email, scope: SCOPE, aud: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  return `${header}.${claim}.${b64url(signer.sign(credentials.private_key))}`;
}

let tokenCache = { token: null, exp: 0, key: null };

async function accessToken({ fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  const cfg = readCredentials(env);
  if (!cfg.configured) throw new SheetsError('not_configured', cfg.reason);
  if (tokenCache.token && tokenCache.key === cfg.credentials.client_email && tokenCache.exp - 60000 > now) return tokenCache.token;
  let res;
  try {
    res = await fetchImpl(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(cfg.credentials, Math.floor(now / 1000), env) }).toString(),
    });
  } catch (e) { throw new SheetsError('network', `Could not reach Google to sign in: ${e.message}`); }
  if (!res.ok) throw new SheetsError('auth_failed', 'Google rejected the service-account credentials. Check GOOGLE_SERVICE_ACCOUNT_JSON.', res.status);
  const json = await res.json();
  tokenCache = { token: json.access_token, exp: now + (Number(json.expires_in) || 3600) * 1000, key: cfg.credentials.client_email };
  return json.access_token;
}

async function sheetsGet(path, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const token = await accessToken(opts);
  const base = env.GOOGLE_SHEETS_API_BASE || 'https://sheets.googleapis.com/v4';
  let res;
  try { res = await fetchImpl(`${base}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }); } catch (e) { throw new SheetsError('network', `Could not reach Google Sheets: ${e.message}`); }
  if (res.ok) return res.json();
  const email = (readCredentials(env).credentials || {}).client_email;
  if (res.status === 403) throw new SheetsError('forbidden', `Google denied access to the spreadsheet. Share it (Viewer) with ${email || 'the service account'}.`, 403);
  if (res.status === 404) throw new SheetsError('not_found', 'The spreadsheet was not found. Check WNDRR_COPY_SHEET_ID.', 404);
  if (res.status === 401) { tokenCache = { token: null, exp: 0, key: null }; throw new SheetsError('auth_failed', 'Google rejected the access token; try again.', 401); }
  if (res.status === 429) throw new SheetsError('rate_limited', 'Google Sheets is rate limiting requests. Try again in a minute.', 429);
  throw new SheetsError('api_error', `Google Sheets returned an error (${res.status}).`, res.status);
}

// [{ title, rows, columns }]
async function listTabs(opts = {}) {
  const id = sheetId(opts.env);
  const meta = await sheetsGet(`/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties(title,sheetId,gridProperties)`, opts);
  return (meta.sheets || []).map((s) => ({ title: s.properties.title, rows: s.properties.gridProperties && s.properties.gridProperties.rowCount, columns: s.properties.gridProperties && s.properties.gridProperties.columnCount }));
}

// → string[][] (formatted values, exactly as displayed). Read only.
async function readTab(title, opts = {}) {
  const id = sheetId(opts.env);
  const range = encodeURIComponent(`'${String(title).replace(/'/g, "''")}'`);
  const out = await sheetsGet(`/spreadsheets/${encodeURIComponent(id)}/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`, opts);
  return out.values || [];
}

function resetTokenCache() { tokenCache = { token: null, exp: 0, key: null }; }

module.exports = { readCredentials, signJwt, accessToken, listTabs, readTab, sheetId, resetTokenCache, SheetsError, SCOPE, DEFAULT_SHEET_ID };
