import {parse, parseFragment, serialize} from '../site/node_modules/parse5/dist/index.js';
import {createHash} from 'node:crypto';
import {loadingPresentation, fallbackLoadingArt} from '../site/src/runtime/loading-presentation.mjs';
import {toolTags, toolPendingStyle} from '../site/src/runtime/tool-startup.mjs';

const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
function set(node, name, value) {
  node.attrs ??= [];
  const previous = node.attrs.find(a => a.name === name);
  if (previous) previous.value = value;
  else node.attrs.push({name, value});
}
function remove(node, name) { node.attrs = node.attrs.filter(a => a.name !== name); }
function walk(node, fn) { fn(node); for (const child of node.childNodes ?? []) walk(child, fn); }
function append(parent, node) {node.parentNode = parent; parent.childNodes.push(node);}
const fragment = html => parseFragment(html).childNodes;
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');

export function redirectHtml(href, locale, {preserveLocation = false, storyDirectory = false} = {}) {
  const escaped = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const redirect = storyDirectory
    ? `const target=new URL(${safeJson(href)},location.href);const params=new URLSearchParams(location.search);const category=params.get('category');const section=['main','extra','viewpoint','friendship','event'].includes(category)?category:'main';target.pathname=target.pathname.replace(/\\/stories\\/main\\/$/,'/stories/'+(section==='event'?'events':section)+'/');params.delete('category');target.search=params.toString();target.hash=location.hash;location.replace(target.href);`
    : preserveLocation
    ? `const target=new URL(${safeJson(href)},location.href);target.search=location.search;target.hash=location.hash;location.replace(target.href);`
    : `location.replace(${safeJson(href)});`;
  return `<!doctype html><html lang="${locale}" data-prerendered="true"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escaped}"><title>OtoNote</title></head><body><a href="${escaped}">Continue / 继续</a><script>${redirect}</script></body></html>`;
}

export function prepareHtml(html, {app, codeRoot, contentRoot, base, pointer, bootstrap, navigationScript = '', loadingArt = fallbackLoadingArt(codeRoot), css, stylesheet, locale, route, derivedRoot}) {
  const doc = parse(html), all = [];
  walk(doc, node => all.push(node));
  const head = all.find(n => n.tagName === 'head');
  const body = all.find(n => n.tagName === 'body');
  if (!head || !body || !all.some(n => n.tagName === 'main')) throw Error('Missing document structure');
  const publicUrl = value => {
    value = value.replace('https://prerender.invalid', '');
    const resource = value.replace(/^\/(?:global|jp)\/(zh-CN|en)/, '');
    if (/^\/(vendor|brand|images)\//.test(resource) || resource === '/favicon.svg') return codeRoot + resource.slice(1);
    if (/^\/(media|gallery|live2d|auto-stage|growth|system-banners|mission-rewards)\//.test(resource) || /^\/immersive\/.*\.[a-z0-9]+$/i.test(resource)) return contentRoot + 'public' + resource;
    if (value.startsWith('/') && !/^\/(?:\/|global\/|jp\/|content\/|app\/|anontokyo\/)/.test(value)) return base + value.slice(1);
    return value;
  };
  let promoted = 0;
  for (const node of all) {
    for (const name of ['href','src','poster','data-src']) if (attr(node, name)) set(node, name, publicUrl(attr(node, name)));
    // Native lazy images remain useful without JavaScript; visible pictures no
    // longer wait for the module that used to reveal controlled images.
    if (node.tagName === 'img' && attr(node, 'data-src')) {
      set(node, 'src', attr(node, 'data-src'));
      if (attr(node, 'data-srcset')) set(node, 'srcset', attr(node, 'data-srcset'));
      if (attr(node, 'data-sizes')) set(node, 'sizes', attr(node, 'data-sizes'));
      set(node, 'loading', promoted++ < 8 ? 'eager' : 'lazy');
      remove(node, 'data-controlled-lazy');
    }
  }
  const payloads = [];
  const tool = (route.startsWith('tools/') || route === 'my-growth') && all.find(n => toolTags.includes(n.tagName));
  if (tool) {
    set(tool, 'inert', ''); set(tool, 'data-tool-pending', ''); set(tool, 'aria-busy', 'true');
    set(tool, 'hidden', '');
    append(head, fragment(`<style data-tool-visibility-style>${toolPendingStyle}</style>`)[0]);
    walk(tool, node => {
      if (node.tagName !== 'script' || attr(node, 'type') !== 'application/json') return;
      const bytes = Buffer.from(node.childNodes.map(n => n.value ?? '').join(''));
      JSON.parse(bytes);
      const hash = createHash('sha256').update(bytes).digest('hex');
      payloads.push({name:hash + '.json', bytes});
      node.childNodes = [];
      set(node, 'data-deferred-json', derivedRoot + 'payloads/' + hash + '.json');
      set(node, 'data-sha256', hash);
      // Match checkedJson's same-origin credentials/CORS fetch so the later
      // integrity-checked read consumes this response rather than downloading twice.
      append(head,fragment(`<link rel="preload" as="fetch" crossorigin="anonymous" href="${derivedRoot}payloads/${hash}.json" fetchpriority="high">`)[0]);
    });
    const en = locale === 'en';
    const scene = loadingPresentation('tool', locale);
    const gate = fragment(`<section data-tool-gate>
      <div class="loading-interlude" data-loading-interlude>
        <div class="loading-mini-stage" aria-hidden="true"><span class="loading-stage-orbit"></span><span class="loading-stage-star">✦</span><span class="loading-stage-note">♪</span><img class="loading-companion" src="${loadingArt[scene.art]}" width="128" height="128" alt=""><span class="loading-stage-shadow"></span></div>
        <div class="loading-interlude-copy"><span class="loading-cue">${en ? 'BEFORE THE SHOW' : '开演之前'}</span><p class="loading-caption">${scene.caption}</p><p role="status"><span class="loading-dot" aria-hidden="true"></span><span data-tool-status>${en ? 'Preparing your tool…' : '正在准备工具，马上就好…'}</span></p><button type="button" data-tool-retry hidden>${en ? 'Reload' : '重新加载'}</button></div>
        <div class="loading-beat" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
      </div>
    </section>`)[0];
    gate.parentNode = tool.parentNode;
    tool.parentNode.childNodes.splice(tool.parentNode.childNodes.indexOf(tool), 0, gate);
  }
  // Unavailable scoring tools have no workbench; do not download their dormant
  // calculation modules either. Preserve the visible availability explanation.
  if (tool || ['my-growth','tools/deck-builder','tools/optimizer','tools/song-calculator'].includes(route)) {
    const shared = new Set(Object.entries(app.scripts).filter(([key]) => /\/(BaseLayout|ArchiveImage|SiteAnalytics|TransitionPreview|UnifiedSearch|FilterDrawer)\.astro\?/.test(key)).map(([,value]) => codeRoot + value));
    for (const node of all) {
      if (node.tagName !== 'script' || attr(node, 'type') !== 'module' || !attr(node, 'src') || shared.has(attr(node, 'src'))) continue;
      set(node, 'data-deferred-module', attr(node, 'src')); remove(node, 'src'); set(node, 'type', 'application/x-ournotes-deferred');
    }
  }
  const preloaded=new Set();
  for(const node of all){
    if(node.tagName!=='script')continue;
    const src=attr(node,'data-deferred-module')??(attr(node,'type')==='module'?attr(node,'src'):null);
    if(!src?.startsWith(codeRoot)||attr(node,'data-deferred-module')&&!tool)continue;
    for(const path of app.modulePreloads?.[src.slice(codeRoot.length)]??[src.slice(codeRoot.length)]){
      if(preloaded.has(path))continue;preloaded.add(path);
      append(head,fragment(`<link rel="modulepreload" href="${codeRoot+path}">`)[0]);
    }
  }
  const config = {schemaVersion:1, pointer, codeRoot, loadingArt, app:{schemaVersion:app.schemaVersion, routes:app.routes, endpoints:app.endpoints, scripts:app.scripts,workspacePreloads:app.workspacePreloads??[]}};
  const initializer = fragment(`<script>globalThis[Symbol.for('ournotes.prerender.v1')]=${safeJson(config)};${bootstrap.replace(/<\/script/gi, '<\\/script')};${navigationScript.replace(/<\/script/gi, '<\\/script')}</script>`)[0];
  initializer.parentNode = head; head.childNodes.unshift(initializer);
  if (stylesheet !== undefined) {
    const normalized = stylesheet.replace(/url\(("[^"]*"|'[^']*'|[^)]*)\)/g, (original, raw) => {
      const url = raw.trim().replace(/^(["'])(.*)\1$/, '$2');
      if (!url || /^(?:[a-z]+:|\/|#)/i.test(url)) return original;
      const resolved = new URL(url, 'https://prerender.invalid' + codeRoot + css);
      return `url(${JSON.stringify(resolved.pathname + resolved.search + resolved.hash)})`;
    });
    append(head, fragment(`<style data-prerender-styles>${normalized.replace(/<\/style/gi, '<\\/style')}</style>`)[0]);
  } else if (css) append(head, fragment(`<link rel="stylesheet" href="${codeRoot + css}">`)[0]);
  const htmlNode = all.find(n => n.tagName === 'html');
  set(htmlNode, 'data-prerendered', 'true');
  return {html:serialize(doc), payloads, deferred:!!tool};
}
