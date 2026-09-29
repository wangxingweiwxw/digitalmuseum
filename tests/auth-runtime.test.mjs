import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('real Workers runtime and SQLite Durable Objects complete login and consume state exactly once', async () => {
  let exchanges = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'auth-test',
    modules: true, compatibilityDate: '2026-09-26',
    script: await readFile(new URL('../worker/auth.mjs', import.meta.url), 'utf8') + '\nexport default { fetch: (request, env) => handleAuth(request, env) };',
    bindings: { ZHIHU_OAUTH_APP_ID: '851', ZHIHU_OAUTH_APP_KEY: 'test-only', ZHIHU_OAUTH_REDIRECT_URI: 'https://museum.chipai.cc/zhihu-callback' },
    durableObjects: { AUTH_SESSIONS: { className: 'MuseumAuthSession', useSQLite: true } },
    outboundService: async request => {
      if (request.url === 'https://openapi.zhihu.com/access_token') {
        exchanges++;
        return Response.json({ access_token: 'test-only-token', expires_in: 3600 });
      }
      assert.equal(request.url, 'https://openapi.zhihu.com/user');
      return new Response('{"uid":969570047710216201,"fullname":"Runtime test"}', { headers: { 'Content-Type': 'application/json' } });
    }
  }] }));
  try {
    const origin = 'https://museum.chipai.cc';
    const start = await mf.dispatchFetch(origin + '/api/auth/zhihu/start', { method: 'POST', headers: { Origin: origin }, body: '{}' });
    assert.equal(start.status, 200);
    const state = new URL((await start.json()).authorizationUrl).searchParams.get('state');
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const callback = origin + '/zhihu-callback?authorization_code=test&state=' + state;
    const responses = await Promise.all([1, 2].map(() => mf.dispatchFetch(callback, { headers: { Cookie: cookie }, redirect: 'manual' })));
    const success = responses.find(response => response.headers.get('location') === origin + '/');
    assert.ok(success, JSON.stringify({ exchanges, responses: await Promise.all(responses.map(async response => ({ status: response.status, location: response.headers.get('location'), body: await response.clone().text() }))) }));
    assert.equal(responses.filter(response => response.headers.get('location').includes('state_invalid')).length, 1);
    assert.equal(exchanges, 1, 'provider code is exchanged once');
    const sessionCookie = success.headers.getSetCookie().find(value => value.startsWith('__Host-museum_session=')).split(';')[0];
    const result = await mf.dispatchFetch(origin + '/api/auth/session', { headers: { Cookie: sessionCookie } });
    assert.equal((await result.json()).user.id, '969570047710216201');
    await mf.dispatchFetch(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: sessionCookie, Origin: origin } });
    const after = await mf.dispatchFetch(origin + '/api/auth/session', { headers: { Cookie: sessionCookie } });
    assert.equal((await after.json()).authenticated, false);
  } finally { await mf.dispose(); }
});
