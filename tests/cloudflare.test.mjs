import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, build } from '../scripts/build-cloudflare.mjs';

test('build excludes repository history, reports and exhibit images', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'museum-build-test-'));
  for (const folder of ['assets/css', 'assets/js', 'assets/images/exhibits/test', '.git/objects/pack', 'reports']) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'index.html'), '<html>museum</html>');
  await fs.writeFile(path.join(root, 'assets/css/style.css'), 'body{}');
  await fs.writeFile(path.join(root, 'assets/images/cover.png'), 'cover');
  await fs.writeFile(path.join(root, 'assets/images/exhibits/test/image.png'), 'exhibit');
  await fs.writeFile(path.join(root, 'assets/js/museum-data.js'), 'window.DATA = ' + JSON.stringify({ museums: [{ nodes: [{ image: 'assets/images/exhibits/test/image.png' }] }] }) + ';');
  const pack = await fs.open(path.join(root, '.git/objects/pack/history.pack'), 'w');
  await pack.truncate(208 * 1024 * 1024);
  await pack.close();
  await fs.writeFile(path.join(root, 'reports/private.txt'), 'not public');
  const result = await build(root);
  assert.equal(result.r2_images.length, 1);
  assert.equal(result.static_files.length, 4);
  for (const forbidden of ['.git', 'reports', 'assets/images/exhibits']) {
    await assert.rejects(fs.access(path.join(root, 'dist', forbidden)));
  }
  assert.deepEqual((await build(root)).r2_images, result.r2_images);
  await fs.unlink(path.join(root, 'assets/images/exhibits/test/image.png'));
  assert.deepEqual((await build(root)).r2_images, result.r2_images, 'GitHub can build using the R2 index without image binaries');
  await fs.writeFile(path.join(root, 'assets/js/museum-data.js'), 'window.DATA = {"museums":[{"nodes":[{"image":"missing.png"}]}]};');
  await assert.rejects(build(root), /Missing exhibit image/);
});

test('build refuses to remove an existing user directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'museum-preserve-test-'));
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist/keep.txt'), 'keep');
  await assert.rejects(build(root), /without the museum build marker/);
  assert.equal(await fs.readFile(path.join(root, 'dist/keep.txt'), 'utf8'), 'keep');
});

test('R2 image handler serves all 88 routes and handles HTTP errors and validation', async () => {
  const manifest = await build();
  const { default: worker } = await import('../worker/index.mjs');
  let reads = 0;
  let heads = 0;
  const objects = new Map();
  for (const item of manifest.r2_images) {
    const data = await fs.readFile(path.join(ROOT, item.source)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return Buffer.from(item.hash);
    });
    objects.set(item.key, data);
  }
  const metadata = data => ({ size: data.length, httpEtag: '"test-etag"', uploaded: new Date('2026-09-26T00:00:00Z'), writeHttpMetadata(headers) { headers.set('Content-Type', 'image/png'); } });
  const env = {
    ASSETS: { fetch: async () => new Response('static') },
    EXHIBITS: {
      async get(key) { reads++; const data = objects.get(key); return data ? { ...metadata(data), body: data } : null; },
      async head(key) { heads++; const data = objects.get(key); return data ? metadata(data) : null; }
    }
  };
  const fetch = (source, options = {}, bindings = env) => worker.fetch(new Request('https://museum.test/' + source, options), bindings, { waitUntil() {} });
  for (const item of manifest.r2_images) {
    const response = await fetch(item.source);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), objects.get(item.key));
  }
  assert.equal(reads, 88);
  const first = manifest.r2_images[0];
  const head = await fetch(first.source, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(objects.get(first.key).length));
  assert.equal(await head.text(), '');
  assert.equal(heads, 1);
  for (const headers of [{ 'If-None-Match': 'W/"test-etag"' }, { 'If-Modified-Since': 'Sat, 26 Sep 2026 00:00:00 GMT' }]) {
    const response = await fetch(first.source, { headers });
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
  }
  assert.equal((await fetch(first.source, { method: 'POST' })).status, 405);
  assert.equal((await fetch('assets/images/exhibits/unknown.png')).status, 404);
  assert.equal((await fetch(first.source, {}, { ASSETS: env.ASSETS })).status, 503);
  assert.equal(await (await fetch('index.html')).text(), 'static');
  objects.delete(first.key);
  const missing = await fetch(first.source);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
});
