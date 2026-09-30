const AUTHORIZE = 'https://openapi.zhihu.com/authorize';
const TOKEN = 'https://openapi.zhihu.com/access_token';
const USER = 'https://openapi.zhihu.com/user';
const FLOW_COOKIE = '__Host-museum_oauth';
const SESSION_COOKIE = '__Host-museum_session';
const FLOW_SECONDS = 600;
const securityHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const cookie = (name, value, seconds) => `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
function readCookie(request, name) {
  const values = (request.headers.get('cookie') || '').split(';').map(item => item.trim()).filter(item => item.startsWith(name + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function config(env) {
  try {
    const callback = new URL(env.ZHIHU_OAUTH_REDIRECT_URI);
    if (callback.protocol !== 'https:' || callback.pathname !== '/zhihu-callback' || callback.search || callback.hash || callback.username || callback.password) return null;
    if (!env.ZHIHU_OAUTH_APP_ID || !env.ZHIHU_OAUTH_APP_KEY || !env.AUTH_SESSIONS) return null;
    return { callback: callback.href, origin: callback.origin };
  } catch { return null; }
}

export function authOrigin(env) { return config(env)?.origin || null; }
export async function authenticatedUser(request, env) {
  const sid = readCookie(request, SESSION_COOKIE);
  if (!sid) return null;
  const session = await store(env).get('session:' + await digest(sid));
  return session?.user || null;
}

// Parsing uid directly from its JSON source avoids rounding 64-bit Zhihu identifiers.
export function parseProviderJSON(text) {
  return JSON.parse(text, (key, value, context) => {
    if (key !== 'uid' || typeof value !== 'number') return value;
    if (context?.source && /^\d+$/.test(context.source)) return context.source;
    if (Number.isSafeInteger(value)) return String(value);
    throw new Error('Unsafe user identifier');
  });
}
function payload(body) {
  if (!body || typeof body !== 'object' || body.error || body.success === false) throw new Error('Provider rejected request');
  if (body.code !== undefined && ![0, 200, 20000, '0', '200', '20000'].includes(body.code)) throw new Error('Provider rejected request');
  return body.data && typeof body.data === 'object' ? body.data : body;
}
export function publicProfile(raw) {
  const user = raw.user && typeof raw.user === 'object' ? raw.user : raw;
  const id = typeof user.hash_id === 'string' && user.hash_id ? user.hash_id : typeof user.uid === 'string' && /^\d+$/.test(user.uid) ? user.uid : null;
  if (!id) throw new Error('Missing user identity');
  let avatar = '';
  try {
    const url = new URL(user.avatar_path);
    if (url.protocol === 'https:' && (url.hostname === 'zhimg.com' || url.hostname.endsWith('.zhimg.com'))) avatar = url.href;
  } catch {}
  const email = typeof user.email === 'string' ? user.email : '';
  const phone = typeof user.phone_no === 'string' && user.phone_no ? user.phone_no : typeof user.phone === 'string' ? user.phone : '';
  return {
    id, name: String(user.fullname || '知乎用户').slice(0, 80), avatar,
    headline: typeof user.headline === 'string' ? user.headline.slice(0, 200) : '',
    email: /^[^@]+@[^@]+$/.test(email) ? email[0] + '***@' + email.split('@')[1] : '',
    phone: phone.length >= 7 ? phone.slice(0, 3) + '****' + phone.slice(-4) : ''
  };
}

// Each random flow/session has its own Durable Object. No token is sent to the browser.
function store(env) {
  async function call(key, operation, body = {}) {
    const stub = env.AUTH_SESSIONS.get(env.AUTH_SESSIONS.idFromName(key));
    const response = await stub.fetch('https://session.internal/' + operation, { method: 'POST', body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Session storage unavailable');
    return response.json();
  }
  return {
    put: (key, value, expiresAt) => call(key, 'put', { value, expiresAt }),
    get: key => call(key, 'get'),
    consume: (key, flowHash) => call(key, 'consume', { flowHash }),
    delete: key => call(key, 'delete')
  };
}

export class MuseumAuthSession {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const op = new URL(request.url).pathname;
    const body = await request.json();
    if (op === '/put') {
      await this.storage.put('record', body);
      await this.storage.setAlarm(body.expiresAt);
      return json(true);
    }
    if (op === '/delete') { await this.storage.deleteAll(); await this.storage.deleteAlarm(); return json(true); }
    const result = await this.storage.transaction(async transaction => {
      const record = await transaction.get('record');
      if (!record || record.expiresAt <= Date.now()) { await transaction.delete('record'); return null; }
      if (op === '/consume') {
        if (record.value.flowHash !== body.flowHash) return null;
        await transaction.delete('record');
      } else if (op !== '/get') return null;
      return record.value;
    });
    return json(result);
  }
  async alarm() { await this.storage.deleteAll(); }
}

export async function handleAuth(request, env, dependencies = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/auth/') && url.pathname !== '/zhihu-callback') return null;
  const cfg = config(env);
  const route = url.pathname;
  const expectedMethod = ['/api/auth/zhihu/start', '/api/auth/logout'].includes(route) ? 'POST' : 'GET';
  if (request.method !== expectedMethod) return json({ error: 'method_not_allowed' }, 405);
  if (!['/api/auth/session', '/api/auth/zhihu/start', '/api/auth/logout', '/zhihu-callback'].includes(route)) return json({ error: 'not_found' }, 404);
  if (!cfg) return route === '/api/auth/session' ? json({ configured: false, authenticated: false }) : json({ error: 'not_configured' }, 503);
  if (url.origin !== cfg.origin) return json({ error: 'wrong_origin' }, 403);
  if (request.method === 'POST' && request.headers.get('origin') !== cfg.origin) return json({ error: 'origin_mismatch' }, 403);
  const db = dependencies.store || store(env);
  const fetcher = dependencies.fetch || fetch;
  const redirect = (destination, cookies = []) => {
    const headers = new Headers({ ...securityHeaders, Location: cfg.origin + destination });
    cookies.forEach(item => headers.append('Set-Cookie', item));
    return new Response(null, { status: 303, headers });
  };
  try {
    if (route === '/api/auth/zhihu/start') {
      const body = await request.json().catch(() => ({}));
      const returnTo = typeof body.returnTo === 'string' && /^\/(?:#[^\r\n]*)?$/.test(body.returnTo) && body.returnTo.length < 1000 ? body.returnTo : '/';
      const state = random(), flow = random();
      await db.put('flow:' + await digest(state), { flowHash: await digest(flow), returnTo }, Date.now() + FLOW_SECONDS * 1000);
      const target = new URL(AUTHORIZE);
      target.search = new URLSearchParams({ app_id: String(env.ZHIHU_OAUTH_APP_ID), redirect_uri: cfg.callback, response_type: 'code', state }).toString();
      const response = json({ authorizationUrl: target.href });
      response.headers.append('Set-Cookie', cookie(FLOW_COOKIE, flow, FLOW_SECONDS));
      return response;
    }
    if (route === '/zhihu-callback') {
      const state = url.searchParams.get('state');
      const flow = readCookie(request, FLOW_COOKIE);
      const clearFlow = cookie(FLOW_COOKIE, '', 0);
      if (!state || !/^[a-f0-9]{64}$/.test(state) || !flow || url.searchParams.getAll('state').length !== 1) return redirect('/?auth_error=state_invalid', [clearFlow]);
      const pending = await db.consume('flow:' + await digest(state), await digest(flow));
      if (!pending) return redirect('/?auth_error=state_invalid', [clearFlow]);
      if (url.searchParams.has('error')) return redirect('/?auth_error=denied', [clearFlow]);
      const code = url.searchParams.get('authorization_code') || url.searchParams.get('code');
      if (!code || code.length > 4096 || url.searchParams.getAll('authorization_code').length > 1 || url.searchParams.getAll('code').length > 1) return redirect('/?auth_error=code_missing', [clearFlow]);
      let stage = 'token_request', upstreamStatus = null;
      try {
        const tokenResponse = await fetcher(TOKEN, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ app_id: String(env.ZHIHU_OAUTH_APP_ID), app_key: env.ZHIHU_OAUTH_APP_KEY, grant_type: 'authorization_code', redirect_uri: cfg.callback, code }) });
        upstreamStatus = tokenResponse.status;
        stage = 'token_response';
        if (!tokenResponse.ok) throw new Error('Token exchange failed');
        const token = payload(parseProviderJSON(await tokenResponse.text()));
        if (typeof token.access_token !== 'string' || !token.access_token || !Number.isFinite(Number(token.expires_in)) || Number(token.expires_in) <= 0) throw new Error('Invalid token response');
        const tokenExpiresAt = Date.now() + Number(token.expires_in) * 1000;
        stage = 'profile_request';
        upstreamStatus = null;
        const userResponse = await fetcher(USER, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { Authorization: 'Bearer ' + token.access_token, Accept: 'application/json' } });
        upstreamStatus = userResponse.status;
        stage = 'profile_response';
        if (!userResponse.ok) throw new Error('User request failed');
        const user = publicProfile(payload(parseProviderJSON(await userResponse.text())));
        const seconds = Math.min(Math.floor((tokenExpiresAt - Date.now()) / 1000), 86400);
        if (seconds < 1) throw new Error('Token expired during login');
        const sid = random();
        stage = 'session_store';
        // Login needs only a profile. Discard the provider token and raw email/phone after this request.
        await db.put('session:' + await digest(sid), { user }, Date.now() + seconds * 1000);
        const old = readCookie(request, SESSION_COOKIE);
        if (old) await db.delete('session:' + await digest(old));
        return redirect(pending.returnTo, [clearFlow, cookie(SESSION_COOKIE, sid, seconds)]);
      } catch {
        // Only fixed stage names and HTTP status: never log codes, tokens, headers or provider bodies.
        console.warn('zhihu_oauth_failed', { stage, upstreamStatus });
        return redirect('/?auth_error=provider_failed', [clearFlow]);
      }
    }
    const sid = readCookie(request, SESSION_COOKIE);
    const key = sid ? 'session:' + await digest(sid) : null;
    if (route === '/api/auth/logout') {
      if (key) await db.delete(key);
      const response = json({ authenticated: false });
      response.headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
      response.headers.append('Set-Cookie', cookie(FLOW_COOKIE, '', 0));
      return response;
    }
    const session = key ? await db.get(key) : null;
    const response = json({ configured: true, authenticated: Boolean(session), user: session?.user || null });
    if (sid && !session) response.headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
    return response;
  } catch {
    if (route === '/zhihu-callback') return redirect('/?auth_error=provider_failed', [cookie(FLOW_COOKIE, '', 0)]);
    return json({ error: 'temporarily_unavailable' }, 503);
  }
}
