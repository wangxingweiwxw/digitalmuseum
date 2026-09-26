import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const origin = process.argv[2] || 'http://127.0.0.1:8789';
const manifest = JSON.parse(await readFile('.cloudflare/build-manifest.json', 'utf8'));
const request = (pathname, options) => fetch(new URL(pathname, origin), options);
let checked = 0;
for (const file of manifest.static_files) {
  const response = await request(file.path);
  assert.equal(response.status, 200, file.path);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile('dist/' + file.path), file.path);
}
for (const item of manifest.r2_images) {
  const response = await request(item.source);
  assert.equal(response.status, 200, item.source);
  assert.equal(response.headers.get('content-type'), item.type, item.source);
  assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), item.hash, item.source);
  checked++;
}
const first = manifest.r2_images[0];
const head = await request(first.source, { method: 'HEAD' });
assert.equal(head.status, 200);
assert.equal(Number(head.headers.get('content-length')), first.bytes);
assert.equal(await head.text(), '');
assert.equal((await request(first.source, { headers: { 'If-None-Match': head.headers.get('etag') } })).status, 304);
for (const pathname of ['/.git/objects/pack/history.pack', '/reports/exhibit-compression.json', '/.museum-build', '/assets/images/exhibits/missing.png']) {
  assert.equal((await request(pathname)).status, 404, pathname);
}
const report = { origin, checked_at: new Date().toISOString(), static_files: manifest.static_files.length, r2_images: checked, image_hashes_verified: true, head_and_conditional_get: true, non_public_paths_return_404: true };
await writeFile('reports/cloudflare-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
