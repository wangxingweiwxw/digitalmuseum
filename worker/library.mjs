import catalog from './library-catalog.json' with { type: 'json' };
import { authOrigin, authenticatedUser } from './auth.mjs';

const pages = new Set(catalog);
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const empty = nodeId => ({ nodeId, favorite: false, note: '', noteVersion: 0, updatedAt: null });
const summary = item => ({ nodeId: item.nodeId, favorite: item.favorite, hasNote: Boolean(item.note), notePreview: item.note.slice(0, 100), updatedAt: item.updatedAt });
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

async function readBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return { error: 'json_required', status: 415 };
  const reader = request.body?.getReader();
  if (!reader) return { error: 'invalid_body', status: 400 };
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 16384) { await reader.cancel(); return { error: 'body_too_large', status: 413 }; }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch { return { error: 'invalid_body', status: 400 }; }
}

export async function handleLibrary(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/library' && !url.pathname.startsWith('/api/library/')) return null;
  try {
    const origin = authOrigin(env);
    if (!origin || !env.MUSEUM_LIBRARY) return json({ error: 'temporarily_unavailable' }, 503);
    if (url.origin !== origin || (request.headers.has('origin') && request.headers.get('origin') !== origin)) return json({ error: 'origin_mismatch' }, 403);
    if (!['GET', 'PATCH'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
    if (request.method === 'PATCH' && request.headers.get('origin') !== origin) return json({ error: 'origin_mismatch' }, 403);
    const user = await authenticatedUser(request, env);
    if (!user?.id) return json({ error: 'login_required' }, 401);
    const expectedUser = request.headers.get('x-museum-user');
    if (request.method === 'PATCH' && !expectedUser) return json({ error: 'identity_required' }, 400);
    if (expectedUser && expectedUser !== encodeURIComponent(String(user.id))) return json({ error: 'account_changed' }, 409);
    const nodeId = url.pathname === '/api/library' ? null : url.pathname.slice('/api/library/'.length);
    if (nodeId !== null && !pages.has(nodeId)) return json({ error: 'unknown_exhibit' }, 404);
    if (request.method === 'PATCH' && !nodeId) return json({ error: 'method_not_allowed' }, 405);
    let patch;
    if (request.method === 'PATCH') {
      const body = await readBody(request);
      if (body.error) return json({ error: body.error }, body.status);
      patch = body.value;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return json({ error: 'invalid_body' }, 400);
      const keys = Object.keys(patch).sort().join(',');
      if (keys === 'favorite') {
        if (typeof patch.favorite !== 'boolean') return json({ error: 'invalid_favorite' }, 400);
      } else if (keys === 'note,noteVersion') {
        if (typeof patch.note !== 'string' || patch.note.length > 2000 || !Number.isSafeInteger(patch.noteVersion) || patch.noteVersion < 0) return json({ error: 'invalid_note' }, 400);
      } else return json({ error: 'invalid_fields' }, 400);
    }
    // Only the authenticated server-side identity selects the private, persistent object.
    const stub = env.MUSEUM_LIBRARY.get(env.MUSEUM_LIBRARY.idFromName('zhihu:' + await hash(String(user.id))));
    return await stub.fetch('https://library.internal/' + (request.method === 'PATCH' ? 'update' : nodeId ? 'get' : 'list'), {
      method: 'POST', body: JSON.stringify({ nodeId, patch })
    });
  } catch { return json({ error: 'temporarily_unavailable' }, 503); }
}

// Separate namespace from expiring login sessions: no alarm or TTL deletes personal data.
export class MuseumLibrary {
  constructor(state) { this.storage = state.storage; }
  async fetch(request) {
    const op = new URL(request.url).pathname;
    const { nodeId, patch } = await request.json();
    if (op === '/list') {
      const records = await this.storage.list({ prefix: 'exhibit:' });
      return json({ items: [...records.values()].filter(x => x.favorite || x.note).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary) });
    }
    if (!pages.has(nodeId)) return json({ error: 'unknown_exhibit' }, 404);
    const key = 'exhibit:' + nodeId;
    if (op === '/get') return json(await this.storage.get(key) || empty(nodeId));
    if (op !== '/update') return json({ error: 'not_found' }, 404);
    return this.storage.transaction(async transaction => {
      const item = await transaction.get(key) || empty(nodeId);
      if (Object.hasOwn(patch, 'note')) {
        if (item.noteVersion !== patch.noteVersion) return json({ error: 'note_conflict' }, 409);
        item.note = patch.note;
        item.noteVersion++;
      } else item.favorite = patch.favorite;
      item.updatedAt = new Date().toISOString();
      // Keep empty-note versions so a stale tab cannot restore a deleted note silently.
      await transaction.put(key, item);
      return json(item);
    });
  }
}
