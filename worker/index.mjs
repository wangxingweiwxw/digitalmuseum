import exhibits from './exhibit-manifest.json' with { type: 'json' };

function notModified(request, headers) {
  const match = request.headers.get('if-none-match');
  if (match) return match.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === headers.get('etag'));
  const since = request.headers.get('if-modified-since');
  return Boolean(since && headers.has('last-modified') && Date.parse(headers.get('last-modified')) <= Date.parse(since));
}

function clientResponse(request, body, headers) {
  if (notModified(request, headers)) {
    headers.delete('content-length');
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return new Response('Invalid path', { status: 400 }); }
    if (!pathname.startsWith('/assets/images/exhibits/')) {
      return env.ASSETS.fetch(request);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const entry = exhibits[pathname];
    if (!entry) return new Response('Image not found', { status: 404 });
    if (!env.EXHIBITS) return new Response('Image storage is not configured', { status: 503 });
    // The cache key contains the file hash, so a new deployment cannot serve an old image.
    const cacheUrl = new URL(request.url);
    cacheUrl.pathname = '/__museum_image_cache/' + entry.hash;
    cacheUrl.search = '';
    const cacheKey = new Request(cacheUrl, { method: 'GET' });
    const cache = globalThis.caches?.default;
    const cached = cache ? await cache.match(cacheKey) : null;
    if (cached) return clientResponse(request, cached.body, new Headers(cached.headers));
    let object;
    try {
      object = request.method === 'HEAD' ? await env.EXHIBITS.head(entry.key) : await env.EXHIBITS.get(entry.key);
    } catch {
      return new Response('Image storage temporarily unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!object) return new Response('Image not uploaded', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Type', entry.type);
    headers.set('Content-Length', String(object.size));
    headers.set('ETag', object.httpEtag);
    headers.set('Last-Modified', object.uploaded.toUTCString());
    headers.set('Cache-Control', 'public, max-age=300, s-maxage=86400');
    headers.set('X-Content-Type-Options', 'nosniff');
    if (request.method === 'HEAD') return clientResponse(request, null, headers);
    const full = new Response(object.body, { headers });
    if (cache && ctx) ctx.waitUntil(cache.put(cacheKey, full.clone()).catch(() => {}));
    return clientResponse(request, full.body, new Headers(full.headers));
  }
};
