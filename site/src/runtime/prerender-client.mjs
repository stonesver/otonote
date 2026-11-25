import {pinSnapshot} from './pin-snapshot.mjs';
import {checkedJson, pageContext} from './content.mjs';
import {prepareTool,whenDocumentParsed} from './tool-startup.mjs';

const config = globalThis[Symbol.for('ournotes.prerender.v1')];
const context = pageContext();
const app = {...config.app, root:new URL(config.codeRoot, location.href).href};
globalThis.__OURNOTES_BASE__ = context.base;
globalThis[Symbol.for('ournotes.code-root.v1')] = app.root;
pinSnapshot(config.pointer);
let fullAppPromise = null;
async function loadFullApp() {
  if (app.routes && app.endpoints && app.scripts) return app;
  fullAppPromise ??= fetch(new URL('manifest.json', app.root).href, {
    cache: 'force-cache',
    credentials: 'same-origin'
  }).then(async response => {
    if (!response.ok) throw new Error(`App manifest unavailable (${response.status})`);
    const manifest = await response.json();
    return {
      ...manifest,
      ...app,
      routes: manifest.routes,
      endpoints: manifest.endpoints,
      scripts: manifest.scripts,
      root: app.root
    };
  }).catch(error => {
    fullAppPromise = null;
    throw error;
  });
  return fullAppPromise;
}
globalThis[Symbol.for('ournotes.page-resource.v1')] = async (url, options) => {
  const [module, resolvedApp] = await Promise.all([
    import(new URL('prerender/resource.js', app.root).href),
    loadFullApp()
  ]);
  return module.renderPageResource(url, resolvedApp, context, options);
};

whenDocumentParsed(document,() => {
  const retry = document.querySelector('[data-tool-retry]');
  retry?.addEventListener('click', () => location.reload());
  void prepareTool({document, locale:context.locale,
    readJson:(url, hash) => checkedJson(url, hash, undefined, {timeoutMs:30000}),
    importModule:url => import(new URL(url, location.href).href),
    onReady:() => document.dispatchEvent(new Event('astro:page-load'))
  });
});
function ready() {
  document.documentElement.dataset.contentReady = 'true';
  document.dispatchEvent(new Event('astro:page-load'));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once:true});
else ready();
