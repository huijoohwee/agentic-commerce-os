const PREFIX = '/agentic-design-system';
const FORWARDED_HEADERS = ['accept', 'if-modified-since', 'if-none-match', 'if-range', 'range'];

function errorResponse(status, message, extra = {}) {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  return new Response(message, { status, headers });
}

function originUrl(value) {
  if (typeof value !== 'string' || value.length > 253) return null;
  try {
    const url = new URL(`https://${value}`);
    const allowedPagesHost = url.hostname === 'agentic-design-system.pages.dev'
      || /^[a-z0-9-]+\.agentic-design-system\.pages\.dev$/u.test(url.hostname);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.pathname !== '/' || url.search || url.hash || !allowedPagesHost) return null;
    return url;
  } catch {
    return null;
  }
}

function isExcludedPath(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  const relativePath = decodedPath.slice(PREFIX.length);
  return relativePath === '/registry' || relativePath.startsWith('/registry/')
    || relativePath === '/review-inventory.json'
    || relativePath === '/vendor/agentic-base-browser-data-view.manifest.json';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
      return errorResponse(404, 'Not found');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'Method not allowed', { allow: 'GET, HEAD' });
    }
    if (isExcludedPath(pathname)) return errorResponse(404, 'Not found');
    if (pathname === PREFIX) {
      url.pathname = `${PREFIX}/`;
      return new Response(null, {
        status: 308,
        headers: {
          location: url.toString(),
          'cache-control': 'public, max-age=300',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    const origin = originUrl(env.PAGES_ORIGIN);
    if (!origin || !/^[0-9a-f]{40}$/u.test(env.RELEASE_CANDIDATE_SHA ?? '')
      || !/^[0-9a-f]{64}$/u.test(env.RELEASE_CANDIDATE_DIGEST ?? '')
      || !/^[0-9a-f]{40}$/u.test(env.DESIGN_SYSTEM_SOURCE_REVISION ?? '')) {
      return errorResponse(503, 'Release configuration unavailable');
    }

    const upstreamUrl = new URL(origin);
    upstreamUrl.pathname = pathname.slice(PREFIX.length) || '/';
    upstreamUrl.search = url.search;
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, { method: request.method, headers, redirect: 'manual' });
    } catch {
      return errorResponse(502, 'Static origin unavailable');
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      return errorResponse(502, 'Static origin redirect refused');
    }

    const responseHeaders = new Headers();
    for (const name of [
      'accept-ranges', 'cache-control', 'content-encoding', 'content-length', 'content-range',
      'content-type', 'etag', 'last-modified', 'vary',
    ]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('referrer-policy', 'strict-origin-when-cross-origin');
    responseHeaders.set('x-content-type-options', 'nosniff');
    responseHeaders.set('x-design-system-source', env.DESIGN_SYSTEM_SOURCE_REVISION);
    responseHeaders.set('x-design-system-release', env.RELEASE_CANDIDATE_SHA);
    responseHeaders.set('x-design-system-payload', env.RELEASE_CANDIDATE_DIGEST);
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  },
};
