// Update Requests: a shared board where anyone signed in can ask for an app change or report a UX issue (with optional screenshots / PDFs).
// Pure helpers only (validation, attachment decoding, who may change a request) so they can be unit tested without a database.

const PRIORITIES = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' };
const DEFAULT_PRIORITY = 'P3';
const MAX_BODY = 4000;
const MAX_FILES_PER_REQUEST = 6;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Only images and PDFs. The type is decided from the file's own first bytes, never from the name or the type the browser claims.
function sniffType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

function cleanPriority(v, fallback) {
  const p = String(v === undefined || v === null || v === '' ? (fallback || DEFAULT_PRIORITY) : v).trim().toUpperCase();
  return PRIORITIES[p] ? p : null;
}

function cleanBody(v) {
  const s = String(v === undefined || v === null ? '' : v).replace(/\r\n/g, '\n').trim();
  if (!s) return { error: 'Describe what you would like changed or fixed' };
  if (s.length > MAX_BODY) return { error: `Please keep the request under ${MAX_BODY} characters` };
  return { value: s };
}

function cleanFileName(name, type) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f"<>|:*?]/g, '').trim().slice(0, 120);
  const ext = EXT[type];
  if (!base) return `attachment.${ext}`;
  return /\.[A-Za-z0-9]{2,5}$/.test(base) ? base : `${base}.${ext}`;
}

// [{ name, data }] where data is base64 (a data: URL prefix is tolerated) -> [{ name, type, size, buf }] or { error }
function decodeAttachments(list, { existing = 0 } = {}) {
  if (list === undefined || list === null) return { files: [] };
  if (!Array.isArray(list)) return { error: 'attachments must be a list' };
  if (existing + list.length > MAX_FILES_PER_REQUEST) return { error: `A request can have at most ${MAX_FILES_PER_REQUEST} attachments` };
  const files = [];
  for (const a of list) {
    const raw = String((a && a.data) || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return { error: 'An attachment could not be read' };
    if (raw.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 8) return { error: `Each attachment must be under ${MAX_FILE_BYTES / 1024 / 1024} MB` };
    const buf = Buffer.from(raw, 'base64');
    if (buf.length > MAX_FILE_BYTES) return { error: `Each attachment must be under ${MAX_FILE_BYTES / 1024 / 1024} MB` };
    const type = sniffType(buf);
    if (!type) return { error: 'Only images (PNG, JPG, GIF, WebP) and PDFs can be attached' };
    files.push({ name: cleanFileName(a.name, type), type, size: buf.length, buf });
  }
  return { files };
}

// The person who raised a request, or an admin, may edit, resolve or delete it.
function canModify(user, row) {
  if (!user || !row) return false;
  return user.role === 'admin' || (row.created_by_user_id !== null && row.created_by_user_id === user.id);
}

module.exports = { PRIORITIES, DEFAULT_PRIORITY, MAX_BODY, MAX_FILES_PER_REQUEST, MAX_FILE_BYTES, sniffType, cleanPriority, cleanBody, cleanFileName, decodeAttachments, canModify };
