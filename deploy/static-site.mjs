// All configured production routes are static. On misses, nginx supplies the
// existing SPA entry, legacy redirects and retained immutable releases.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin === env.SITE_ORIGIN) return fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 });
    }
    // Version URLs need public content to exercise the hydrated pages.
    if (url.pathname.startsWith('/content/') || url.pathname === '/site-notices.json' ||
        /^\/api\/v1\/(?:player-rankings|arena-rankings)$/.test(url.pathname)) {
      const origin = new URL(env.SITE_ORIGIN);
      origin.pathname = url.pathname;
      origin.search = url.search;
      const response = await fetch(origin, { method: request.method, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) return new Response(null, { status: 404 });
      return new Response(response.body, { status: response.status, headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex'
      } });
    }
    if (/^\/(global|jp)\/(zh-CN|en)(\/[^.]*)?$/.test(url.pathname)) {
      return env.ASSETS.fetch(new URL('/__entry/', url));
    }
    return new Response(null, { status: 404 });
  }
};
