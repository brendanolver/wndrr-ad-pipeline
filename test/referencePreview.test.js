// Reference Library previews: where a thumbnail comes from (YouTube / TikTok oEmbed / the page's og:image), that it only ever fetches public addresses, that the
// downloaded bytes must really be an image, and that every failure ends as "no preview" (never an exception that could stop a save).
const test = require('node:test');
const assert = require('node:assert/strict');
const rp = require('../src/lib/referencePreview');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 7)]);
const SMALL = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
const res = (body, extra = {}) => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.isBuffer(body) ? body : Buffer.from(body), url: 'https://x.test/', ...extra });
const fakeGet = (routes, log = []) => async (url) => { log.push(url); for (const [k, v] of routes) if (url.includes(k)) return typeof v === 'function' ? v(url) : v; throw new Error('no route ' + url); };

test('only public addresses are ever fetched', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '172.31.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(rp.isPrivateAddress(a), true, a);
  for (const a of ['8.8.8.8', '151.101.1.1', '172.32.0.1', '2606:4700::1111']) assert.equal(rp.isPrivateAddress(a), false, a);
  for (const u of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.5/', 'ftp://example.com/x', 'javascript:alert(1)', 'http://user:pw@example.com/', 'http://foo.internal/', 'not a url', 'http://[::1]/']) assert.equal(rp.publicUrl(u), null, u);
  assert.ok(rp.publicUrl('https://www.instagram.com/p/Cx123/'));
});

test('YouTube ids come from watch, shorts, embed and youtu.be links', () => {
  assert.equal(rp.youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(rp.youtubeId('https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(rp.youtubeId('https://youtu.be/dQw4w9WgXcQ?t=3'), 'dQw4w9WgXcQ');
  assert.equal(rp.youtubeId('https://www.youtube.com/shorts/abcdEFGhij1'), 'abcdEFGhij1');
  assert.equal(rp.youtubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
});

test('og:image / twitter:image are found in either attribute order, best first, and made absolute', () => {
  const html = `<head><meta name="twitter:image" content="/tw.jpg"><meta content="https://cdn.test/a.jpg?x=1&amp;y=2" property="og:image"><meta property="og:title" content="no"></head>`;
  assert.deepEqual(rp.imageUrlsFromHtml(html, 'https://site.test/p/1'), ['https://cdn.test/a.jpg?x=1&y=2', 'https://site.test/tw.jpg']);
  assert.deepEqual(rp.imageUrlsFromHtml('<p>nothing</p>', 'https://site.test/'), []);
});

test('YouTube: the big thumbnail when there is one, otherwise the standard one', async () => {
  const log = [];
  const r1 = await rp.fetchPreview('https://youtu.be/dQw4w9WgXcQ', { get: fakeGet([['maxresdefault', res(PNG)], ['hqdefault', res(PNG)]], log) });
  assert.equal(r1.source, 'youtube'); assert.equal(r1.type, 'image/png'); assert.match(log[0], /maxresdefault/);
  const r2 = await rp.fetchPreview('https://youtu.be/dQw4w9WgXcQ', { get: fakeGet([['maxresdefault', res(SMALL)], ['hqdefault', res(PNG)]]) });
  assert.equal(r2.buf.length, PNG.length, 'a tiny maxres placeholder is skipped');
});

test('TikTok: the oEmbed thumbnail; a refusal falls through to the page and then to nothing', async () => {
  const ok = await rp.fetchPreview('https://www.tiktok.com/@wndrr/video/123', { get: fakeGet([['tiktok.com/oembed', res(JSON.stringify({ thumbnail_url: 'https://p16.tiktokcdn.test/t.png' }), { headers: { 'content-type': 'application/json' } })], ['tiktokcdn', res(PNG)]]) });
  assert.equal(ok.source, 'tiktok');
  const blocked = await rp.fetchPreview('https://www.tiktok.com/@wndrr/video/123', { get: fakeGet([['tiktok.com', { status: 403, headers: {}, body: Buffer.from('no'), url: 'u' }]]) });
  assert.equal(blocked, null);
});

test('any other page: its og:image, only if the bytes really are an image', async () => {
  const page = res('<meta property="og:image" content="https://img.test/cover.png">');
  const hit = await rp.fetchPreview('https://www.instagram.com/p/Cx123/', { get: fakeGet([['instagram.com/p', page], ['img.test', res(PNG)]]) });
  assert.equal(hit.source, 'page'); assert.equal(hit.type, 'image/png');
  const fake = await rp.fetchPreview('https://blog.test/post', { get: fakeGet([['blog.test', page], ['img.test', res(Buffer.from('<html>not an image at all, just text</html>'))]]) });
  assert.equal(fake, null, 'html served as the "image" is refused');
  const nopage = await rp.fetchPreview('https://blog.test/post', { get: fakeGet([['blog.test', res('<html><head></head></html>')]]) });
  assert.equal(nopage, null);
  const login = await rp.fetchPreview('https://www.instagram.com/p/x/', { get: fakeGet([['instagram.com', { status: 302, headers: {}, body: Buffer.alloc(0), url: 'u' }]]) });
  assert.equal(login, null, 'a login wall is a miss, not an error');
});

test('failures never throw, and nothing private is requested', async () => {
  assert.equal(await rp.fetchPreview('https://down.test/x', { get: async () => { throw new Error('ECONNRESET'); } }), null);
  const log = [];
  assert.equal(await rp.fetchPreview('http://169.254.169.254/latest/meta-data', { get: fakeGet([['', res(PNG)]], log) }), null);
  assert.equal(await rp.fetchPreview('not a url', { get: fakeGet([]) }), null);
  assert.equal(log.length, 0, 'the private address was never requested');
});

test('cover uploads: png/jpg/gif/webp only, by the bytes, under 5 MB', () => {
  const b64 = (b) => b.toString('base64');
  assert.equal(rp.decodeCover(undefined).none, true);
  const ok = rp.decodeCover({ name: 'my shot.png', data: 'data:image/png;base64,' + b64(PNG) });
  assert.equal(ok.file.type, 'image/png'); assert.equal(ok.file.name, 'my shot.png');
  assert.ok(rp.decodeCover({ name: 'a.png', data: b64(Buffer.from('<script>alert(1)</script>....')) }).error);
  assert.ok(rp.decodeCover({ name: 'a.pdf', data: b64(Buffer.from('%PDF-1.4\n%fake body for the test\n')) }).error, 'a PDF is not a cover image');
  assert.ok(rp.decodeCover({ name: 'x.png', data: '***' }).error);
  assert.ok(rp.decodeCover({ name: 'big.png', data: b64(Buffer.concat([PNG, Buffer.alloc(rp.MAX_IMAGE_BYTES)])) }).error);
});
