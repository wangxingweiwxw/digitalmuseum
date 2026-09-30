import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('private library isolates users, persists beyond sessions/restarts, and prevents lost note updates', async () => {
  const origin = 'https://museum.chipai.cc';
  const root = fileURLToPath(new URL('..', import.meta.url));
  const catalog = JSON.parse(await readFile(new URL('../worker/library-catalog.json', import.meta.url), 'utf8'));
  const node = catalog[0];
  const bundle = await build({ entryPoints: [path.join(root, 'worker/index.mjs')], bundle: true, format: 'esm', platform: 'neutral', write: false });
  const persistence = await mkdtemp(path.join(os.tmpdir(), 'museum-library-'));
  let identity = 'user-a';
  const options = convertV4MiniflareOptions({ workers: [{
    name: 'library-test', modules: true, compatibilityDate: '2026-09-26', script: bundle.outputFiles[0].text,
    bindings: { ZHIHU_OAUTH_APP_ID: '851', ZHIHU_OAUTH_APP_KEY: 'test-only', ZHIHU_OAUTH_REDIRECT_URI: origin + '/zhihu-callback' },
    durableObjects: { AUTH_SESSIONS: { className: 'MuseumAuthSession', useSQLite: true }, MUSEUM_LIBRARY: { className: 'MuseumLibrary', useSQLite: true } },
    outboundService: async request => request.url.endsWith('/access_token') ? Response.json({ access_token: 'test', expires_in: 3600 }) : Response.json({ hash_id: identity, fullname: identity }),
  }] });
  options.resourcePersistencePath = persistence;
  options.isolatedResourcePersistencePath = persistence;
  let mf = new Miniflare(options);
  const accounts = new Map();
  const request = (cookie, route = '', patch, extra = {}) => mf.dispatchFetch(origin + '/api/library' + route, {
    method: patch === undefined ? 'GET' : 'PATCH', headers: { Cookie: cookie || '', Origin: origin, 'Content-Type': 'application/json', 'X-Museum-User': accounts.get(cookie) || '', ...extra },
    body: patch === undefined ? undefined : JSON.stringify(patch)
  });
  async function login(who) {
    identity = who;
    const start = await mf.dispatchFetch(origin + '/api/auth/zhihu/start', { method: 'POST', headers: { Origin: origin }, body: '{}' });
    const state = new URL((await start.json()).authorizationUrl).searchParams.get('state');
    const flow = start.headers.get('set-cookie').split(';')[0];
    const response = await mf.dispatchFetch(origin + '/zhihu-callback?authorization_code=test&state=' + state, { headers: { Cookie: flow }, redirect: 'manual' });
    assert.equal(response.headers.get('location'), origin + '/');
    const cookie = response.headers.getSetCookie().find(c => c.startsWith('__Host-museum_session=')).split(';')[0];
    accounts.set(cookie, encodeURIComponent(who));
    return cookie;
  }
  try {
    assert.equal((await request('', '/' + node)).status, 401);
    const a = await login('user-a'), b = await login('user-b');
    assert.deepEqual((await (await request(a)).json()).items, []);
    const favorite = await request(a, '/' + node, { favorite: true });
    assert.equal(favorite.status, 200);
    assert.match(favorite.headers.get('cache-control'), /no-store/);
    assert.equal(favorite.headers.get('vary'), 'Cookie');
    const note = '<script>alert("private")</script> 我的笔记\n第二行';
    assert.equal((await request(a, '/' + node, { note, noteVersion: 0 })).status, 200);
    const stored = await (await request(a, '/' + node)).json();
    assert.equal(stored.note, note); assert.equal(stored.favorite, true);
    assert.equal((await (await request(b, '/' + node)).json()).note, '');
    assert.deepEqual((await (await request(b)).json()).items, []);
    const wrongAccount = await request(b, '/' + node, { note: 'A draft', noteVersion: 0 }, { 'X-Museum-User': 'user-a' });
    assert.equal(wrongAccount.status, 409);
    assert.equal((await wrongAccount.json()).error, 'account_changed');
    assert.equal((await request(a, '/' + node, { favorite: false }, { 'X-Museum-User': '' })).status, 400);
    assert.deepEqual((await (await request(b)).json()).items, []);
    assert.equal((await request(b, '/' + node, { userId: 'user-a', favorite: false })).status, 400);
    assert.equal((await request(a, '/' + node, { favorite: false }, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await request(a, '/' + node, { favorite: false }, { Origin: '' })).status, 403);
    assert.equal((await request(a, '/invented-node', { favorite: true })).status, 404);
    assert.equal((await request(a, '/' + node, { note: 'x'.repeat(2001), noteVersion: 1 })).status, 400);
    assert.equal((await request(a, '/' + node, { note: 'x'.repeat(17000), noteVersion: 1 })).status, 413);
    assert.equal((await request(a, '/' + node, { favorite: 'yes' })).status, 400);
    const races = await Promise.all(['device one', 'device two'].map(value => request(a, '/' + node, { note: value, noteVersion: 1 })));
    assert.deepEqual(races.map(r => r.status).sort(), [200, 409]);
    const updated = await (await request(a, '/' + node)).json();
    assert.equal(updated.noteVersion, 2);
    await request(a, '/' + node, { favorite: false });
    assert.equal((await (await request(a, '/' + node)).json()).note, updated.note, 'unfavorite keeps note');
    await mf.dispatchFetch(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: a, Origin: origin } });
    assert.equal((await request(a)).status, 401);
    const newSession = await login('user-a');
    assert.equal((await (await request(newSession, '/' + node)).json()).note, updated.note, 'same account survives logout');
    // Restart the runtime against the same disk-backed SQLite storage.
    await mf.dispose(); mf = new Miniflare(options);
    assert.equal((await (await request(newSession, '/' + node)).json()).note, updated.note, 'survives object/runtime restart');
    await request(newSession, '/' + node, { favorite: true });
    assert.equal((await request(newSession, '/' + node, { note: '', noteVersion: 2 })).status, 200);
    const deleted = await (await request(newSession, '/' + node)).json();
    assert.equal(deleted.note, ''); assert.equal(deleted.favorite, true);
    assert.equal((await request(newSession, '/' + node, { note: 'stale restore', noteVersion: 2 })).status, 409);
    await request(newSession, '/' + node, { favorite: false });
    assert.deepEqual((await (await request(newSession)).json()).items, []);
  } finally {
    await mf.dispose();
    assert.equal(path.dirname(path.resolve(persistence)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(persistence).startsWith('museum-library-'));
    await rm(persistence, { recursive: true, force: true });
  }
});
