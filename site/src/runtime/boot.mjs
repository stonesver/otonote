import {currentServerContext, GAME_SERVERS} from '../lib/game-servers.mjs';
import {restoreServerLabels} from '../lib/server-label.mjs';
import { pageContext } from './content.mjs';
import { renderToString, renderContext } from './astro.mjs';
import { localizeHtmlWithStats } from '../lib/html-localizer.ts';
import { routeParams } from './routes.mjs';
import { startPageInputs } from './startup.mjs';
import { stageClientTools } from './tool-startup.mjs';

export { routeParams, renderToString, renderContext };

export async function renderPageResource(input, app, context, options = {}) {
  options.signal?.throwIfAborted();
  const url = new URL(input, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith(context.base)) throw new Error('Unsupported page resource');
  const logical = url.pathname.slice(context.base.length).replace(/\/$/, '');
  const endpoint = app.endpoints[logical];
  if (endpoint) return (await import(new URL(endpoint.module, app.root).href)).GET();
  const route = app.routes.find(r => r.pattern === 'database/details/[...record]');
  const params = routeParams(route.pattern, logical);
  if (!params) throw new Error('Unknown page resource');
  const page = await import(new URL(route.module, app.root).href);
  const paths = await page.getStaticPaths({});
  const entry = paths.find(p => p.params.record === params.record);
  if (!entry) return new Response('', {status:404});
  let html = await renderToString(renderContext(url, params, app),page.default,entry.props,{},false);
  if (context.locale === 'en') html = localizeHtmlWithStats(html,'en').html;
  options.signal?.throwIfAborted();
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
}

async function start() {
  currentServerContext(); // Reject mismatched explicit server links before loading data.
  const context = pageContext();
  if (!/^\/(global|jp)\//.test(location.pathname)) { location.replace(context.base); return; }
  globalThis.__OURNOTES_BASE__ = context.base;
  const root = new URL('./', import.meta.url);
  globalThis[Symbol.for('ournotes.code-root.v1')] = root.href;
  const {content, route: {app, page, params, stylesheet}} = await startPageInputs(
    globalThis[Symbol.for('ournotes.code-manifest.v1')], root.href);
  globalThis[Symbol.for('ournotes.content-root.v1')] = content.root;
  globalThis[Symbol.for('ournotes.page-resource.v1')] = (url, options) => renderPageResource(url, app, context, options);
  let props = {};
  if (page.getStaticPaths) {
    const entries = await page.getStaticPaths({});
    const entry = entries.find(item => Object.entries(params).every(([key, value]) => String(item.params?.[key]) === value));
    if (!entry) throw new Error('内容不存在 / Content not found');
    props = entry.props ?? {};
  }
  let html = await renderToString(renderContext(new URL(location.href), params, app), page.default, props, {}, true);
  if (html instanceof Response) { location.replace(html.headers.get('location')); return; }
  if (context.locale === 'en') html = localizeHtmlWithStats(html, 'en').html;
  const documentNext = new DOMParser().parseFromString(html, 'text/html');
  const revealTools = stageClientTools(documentNext, context.locale);
  restoreServerLabels(documentNext, GAME_SERVERS);
  for (const element of documentNext.querySelectorAll('[href],[src],[poster],[data-src]')) {
    for (const name of ['href','src','poster','data-src']) {
      const value = element.getAttribute(name);
      const resource = value?.replace(/^\/(?:global|jp)\/(zh-CN|en)/, '');
      if (/^\/(vendor|brand|images)\//.test(resource ?? '') || resource === '/favicon.svg') {
        element.setAttribute(name, new URL(resource.slice(1), root).href);
        continue;
      }
      if (/^\/(media|gallery|live2d|auto-stage|growth|system-banners|mission-rewards)\//.test(resource ?? '') || /^\/immersive\/.*\.[a-z0-9]+$/i.test(resource ?? '')) {
        element.setAttribute(name, content.root + 'public' + resource);
        continue;
      }
      if (value?.startsWith('/') && !/^\/(?:\/|global\/|jp\/|content\/|app\/|anontokyo\/)/.test(value)) element.setAttribute(name, context.base + value.slice(1));
    }
  }
  // Download independent interaction modules together, preserving execution order.
  const preloads = [];
  for (const script of documentNext.querySelectorAll('script[type="module"][src]')) {
    const preload = document.createElement('link');
    preload.rel = 'modulepreload'; preload.href = script.src;
    document.head.append(preload);
    preloads.push(preload);
  }
  document.dispatchEvent(new Event('ournotes:shell-dispose'));
  for (const attr of [...document.documentElement.attributes]) document.documentElement.removeAttribute(attr.name);
  for (const attr of documentNext.documentElement.attributes) document.documentElement.setAttribute(attr.name, attr.value);
  // Keep the loaded link attached while replacing the other head nodes.
  for (const node of [...document.head.childNodes]) if (node !== stylesheet && !preloads.includes(node)) node.remove();
  document.head.prepend(...documentNext.head.childNodes);
  document.body.replaceChildren(...documentNext.body.childNodes);
  // Scripts produced by template rendering are inert until explicitly attached.
  for (const previous of [...document.querySelectorAll('script')]) {
    if (previous.type && !['module','text/javascript','application/javascript'].includes(previous.type)) continue;
    const script = document.createElement('script');
    for (const attr of previous.attributes) script.setAttribute(attr.name, attr.value);
    script.textContent = previous.textContent;
    const loaded = script.src || script.type === 'module' ? new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; }) : Promise.resolve();
    previous.replaceWith(script);
    await loaded;
  }
  document.dispatchEvent(new Event('astro:page-load'));
  revealTools();
  document.documentElement.dataset.contentReady = 'true';
}
if (typeof document !== 'undefined') start().catch(error => {
  console.error(error);
  const toolGate = document.querySelector('[data-tool-gate]');
  if (toolGate) {
    const en = document.documentElement.lang === 'en';
    toolGate.textContent = en ? 'Could not prepare this tool. ' : '工具准备失败，';
    const retry = document.createElement('a');
    retry.href = location.href;
    retry.textContent = en ? 'Reload to try again' : '重新加载后重试';
    toolGate.append(retry);
    return;
  }
  const showLoadingError = globalThis[Symbol.for('ournotes.loading-error.v1')];
  if (showLoadingError) { showLoadingError(); return; }
  let target = document.querySelector('[data-content-status]');
  if (!target) { target = document.createElement('p'); document.body.prepend(target); }
  target.textContent = error.message || '内容暂时无法加载，请刷新重试。';
  target.setAttribute('role', 'alert');
  const retry = document.createElement('a');
  retry.href = location.href;
  retry.textContent = document.documentElement.lang === 'en' ? ' Try again' : ' 重新加载';
  target.append(retry);
});
