// Update Requests: validation, attachment decoding (type decided from the file's own bytes, size / count limits) and who may change a request.
const test = require('node:test');
const assert = require('node:assert/strict');
const ur = require('../src/lib/updateRequests');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const PDF = Buffer.from('%PDF-1.4\n%fake body for the test\n');
const b64 = (b) => b.toString('base64');

test('priorities P1-P4, Medium by default, anything else refused', () => {
  assert.deepEqual(Object.keys(ur.PRIORITIES), ['P1', 'P2', 'P3', 'P4']);
  assert.equal(ur.cleanPriority(undefined), 'P3');
  assert.equal(ur.cleanPriority('p2'), 'P2');
  assert.equal(ur.cleanPriority('P9'), null);
  assert.equal(ur.cleanPriority('high'), null);
});

test('the request text is required, trimmed and bounded', () => {
  assert.ok(ur.cleanBody('   ').error);
  assert.ok(ur.cleanBody(undefined).error);
  assert.equal(ur.cleanBody('  Fix the calendar \r\nplease ').value, 'Fix the calendar \nplease');
  assert.ok(ur.cleanBody('x'.repeat(ur.MAX_BODY + 1)).error);
  assert.equal(ur.cleanBody('x'.repeat(ur.MAX_BODY)).value.length, ur.MAX_BODY);
});

test('attachments: images and PDFs accepted, type taken from the bytes not the name', () => {
  const r = ur.decodeAttachments([{ name: 'shot.png', data: `data:image/png;base64,${b64(PNG)}` }, { name: 'brief', data: b64(PDF) }]);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.files.map((f) => [f.name, f.type]), [['shot.png', 'image/png'], ['brief.pdf', 'application/pdf']]);
  // a script renamed to .png is refused
  assert.ok(ur.decodeAttachments([{ name: 'evil.png', data: b64(Buffer.from('<script>alert(1)</script>....')) }]).error);
  // an html file claiming to be a pdf is refused
  assert.ok(ur.decodeAttachments([{ name: 'a.pdf', data: b64(Buffer.from('<html><body>hello world</body></html>')) }]).error);
  // a PNG called something else is still stored as a PNG with a fitting name
  assert.deepEqual(ur.decodeAttachments([{ name: '../../etc/passwd', data: b64(PNG) }]).files.map((f) => [f.name, f.type]), [['passwd.png', 'image/png']]);
});

test('attachments: count and size limits, junk input', () => {
  const six = Array.from({ length: ur.MAX_FILES_PER_REQUEST }, (_, i) => ({ name: `a${i}.png`, data: b64(PNG) }));
  assert.equal(ur.decodeAttachments(six).files.length, ur.MAX_FILES_PER_REQUEST);
  assert.ok(ur.decodeAttachments([...six, six[0]]).error);
  assert.ok(ur.decodeAttachments([six[0]], { existing: ur.MAX_FILES_PER_REQUEST }).error);
  const big = Buffer.concat([PNG, Buffer.alloc(ur.MAX_FILE_BYTES)]);
  assert.ok(ur.decodeAttachments([{ name: 'big.png', data: b64(big) }]).error);
  assert.ok(ur.decodeAttachments([{ name: 'x.png', data: '***not base64***' }]).error);
  assert.ok(ur.decodeAttachments('nope').error);
  assert.deepEqual(ur.decodeAttachments(undefined).files, []);
});

test('only the author or an admin may change a request', () => {
  const row = { created_by_user_id: 7 };
  assert.equal(ur.canModify({ id: 7, role: 'creative' }, row), true);
  assert.equal(ur.canModify({ id: 1, role: 'admin' }, row), true);
  assert.equal(ur.canModify({ id: 8, role: 'marketing' }, row), false);
  assert.equal(ur.canModify({ id: 8, role: 'creative' }, { created_by_user_id: null }), false);
  assert.equal(ur.canModify(null, row), false);
});
