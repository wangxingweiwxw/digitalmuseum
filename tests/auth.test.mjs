import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAuth, parseProviderJSON, publicProfile } from '../worker/auth.mjs';

const origin = 'https://museum.chipai.cc';
function fixture() {
  const entries = new Map();
  const calls = [];
  const store = {
    async put(key, value, expiresAt) { entries.set(key, { value, expiresAt }); },
    async get(key) { const item = entries.get(key); return item && item.expiresAt > Date.now() ? item.value : null; },
    async consume(key, hash) { const item = await this.get(key); if (item?.flowHash !== hash) return null; entries.delete(key); return item; },
    async delete(key) { entries.delete(key); }
  };
  const env = { ZHIHU_OAUTH_APP_ID: '851', ZHIHU_OAUTH_APP_KEY: 'test-app-key', ZHIHU_OAUTH_REDIRECT_URI: origin + '/zhihu-callback', AUTH_SESSIONS: {} };
  const deps = { store, async fetch(url, options) {
    calls.push({ url, options });
    if (url.endsWith('/access_token')) return Response.json({ code: 20000, data: { access_token: 'test-private-token', expires_in: 3600 } });
    return new Response('{"code":20000,"data":{"uid":969570047710216201,"fullname":"测试用户","avatar_path":"https://picx.zhimg.com/test.jpg","email":"name@example.com","phone_no":"13812345678"}}');
  } };
  const request = (route, options = {}) => handleAuth(new Request(origin + route, options), env, deps);
  const start = async (returnTo = '/#museum/shanghai') => {
    const response = await request('/api/auth/zhihu/start', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ returnTo }) });
    assert.equal(response.status, 200);
    const authorization = new URL((await response.json()).authorizationUrl);
    assert.equal(authorization.origin, 'https://openapi.zhihu.com');
    assert.equal(authorization.searchParams.get('app_id'), '851');
    assert.equal(authorization.searchParams.get('redirect_uri'), origin + '/zhihu-callback');
    assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
    return { state: authorization.searchParams.get('state'), cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const callback = (flow, extra = '') => request('/zhihu-callback?authorization_code=real-code&state=' + flow.state + extra, { headers: { Cookie: flow.cookie } });
  return { entries, calls, deps, env, request, start, callback };
}

test('OAuth code exchange, identity, masking, session and logout', async () => {
  const f = fixture(), flow = await f.start();
  const response = await f.callback(flow);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), origin + '/#museum/shanghai');
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('__Host-museum_session=')).split(';')[0];
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.body.get('code'), 'real-code');
  assert.equal(f.calls[0].options.body.get('app_key'), 'test-app-key');
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer test-private-token');
  const sessionResponse = await f.request('/api/auth/session', { headers: { Cookie: cookie } });
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.user.id, '969570047710216201');
  assert.equal(session.user.email, 'n***@example.com');
  assert.equal(session.user.phone, '138****5678');
  const exposed = JSON.stringify([...f.entries.values()]) + JSON.stringify(session) + JSON.stringify([...response.headers]);
  for (const sensitive of ['test-app-key', 'test-private-token', 'name@example.com', '13812345678']) assert.ok(!exposed.includes(sensitive));
  assert.equal(sessionResponse.headers.get('cache-control'), 'no-store');
  const logout = await f.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
  assert.equal(logout.status, 200);
  assert.equal((await (await f.request('/api/auth/session', { headers: { Cookie: cookie } })).json()).authenticated, false);
});

test('state, browser correlation, expiry and replay are checked before token exchange', async () => {
  const f = fixture(), flow = await f.start();
  for (const [url, cookie] of [
    ['/zhihu-callback?authorization_code=attacker', flow.cookie],
    ['/zhihu-callback?authorization_code=attacker&state=' + flow.state, ''],
    ['/zhihu-callback?authorization_code=attacker&state=' + 'a'.repeat(64), flow.cookie],
    ['/zhihu-callback?authorization_code=attacker&state=' + flow.state, '__Host-museum_oauth=' + 'b'.repeat(64)]
  ]) {
    const response = await f.request(url, { headers: { Cookie: cookie } });
    assert.match(response.headers.get('location'), /state_invalid/);
    assert.equal(f.calls.length, 0);
  }
  await f.callback(flow);
  assert.equal(f.calls.length, 2);
  assert.match((await f.callback(flow)).headers.get('location'), /state_invalid/);
  assert.equal(f.calls.length, 2);
  const expired = await f.start();
  for (const item of f.entries.values()) item.expiresAt = 1;
  assert.match((await f.callback(expired)).headers.get('location'), /state_invalid/);
});

test('rejects cross-origin actions, open redirects and unknown API routes', async () => {
  const f = fixture();
  for (const path of ['/api/auth/zhihu/start', '/api/auth/logout']) {
    assert.equal((await f.request(path, { method: 'POST', headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await f.request(path)).status, 405);
  }
  assert.equal((await f.request('/api/auth/unknown')).status, 404);
  const flow = await f.start('//evil.test');
  assert.equal((await f.callback(flow)).headers.get('location'), origin + '/');
});

test('provider denial, invalid profile, token failures and unavailable config never authenticate', async () => {
  const f = fixture();
  let flow = await f.start();
  assert.match((await f.callback(flow, '&error=access_denied')).headers.get('location'), /denied/);
  assert.equal(f.calls.length, 0);
  for (const result of [Response.json({ code: 404, data: "User don't exist" }), Response.json({ access_token: 'x', expires_in: -1 }), new Response('', { status: 401 })]) {
    flow = await f.start();
    f.deps.fetch = async () => result;
    assert.match((await f.callback(flow)).headers.get('location'), /provider_failed/);
  }
  flow = await f.start();
  f.deps.fetch = async url => url.endsWith('/access_token') ? Response.json({ access_token: 'x', expires_in: 30 }) : Response.json({ fullname: 'No identifier' });
  assert.match((await f.callback(flow)).headers.get('location'), /provider_failed/);
  assert.ok([...f.entries.keys()].every(key => !key.startsWith('session:')));
  delete f.env.ZHIHU_OAUTH_APP_KEY;
  assert.deepEqual(await (await f.request('/api/auth/session')).json(), { configured: false, authenticated: false });
});

test('expired sessions are cleared, profile output is constrained, IDs are lossless', async () => {
  const f = fixture(), flow = await f.start();
  const response = await f.callback(flow);
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('__Host-museum_session=')).split(';')[0];
  for (const item of f.entries.values()) item.expiresAt = 1;
  const session = await f.request('/api/auth/session', { headers: { Cookie: cookie } });
  assert.equal((await session.json()).authenticated, false);
  assert.match(session.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(parseProviderJSON('{"uid":969570047710216201}').uid, '969570047710216201');
  assert.equal(publicProfile({ hash_id: 'valid', avatar_path: 'https://evil.test/track' }).avatar, '');
  assert.throws(() => publicProfile({ uid: 9007199254740992 }));
});
