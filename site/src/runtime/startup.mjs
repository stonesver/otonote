import {artifact, artifactGlob, pageContext, snapshot} from './content.mjs';
import {loadPageInputs, loadStylesheet} from './page-readiness.mjs';
import {routeParams} from './routes.mjs';

const startupKey = Symbol.for('ournotes.page-startup.v1');

/** Shell and boot share one task, including the original rejection on failure. */
export function startPageInputs(manifest, root, {importPage = url => import(url), document = globalThis.document} = {}) {
  const previous = globalThis[startupKey];
  if (previous) return previous;
  const context = pageContext();
  globalThis.__OURNOTES_BASE__ = context.base;
  globalThis[Symbol.for('ournotes.code-root.v1')] = root;
  if (manifest?.schemaVersion !== 1 || manifest.contentSchemaVersion !== 1) throw new Error('网站与内容版本不兼容');
  const path = context.route.replace(/^\/|\/$/g, '');
  let selected, params;
  for (const route of manifest.routes) {
    const match = routeParams(route.pattern, path);
    if (match) { selected = route; params = match; break; }
  }
  if (!selected) throw new Error('页面不存在 / Page not found');
  const profile = manifest.dataProfiles?.[selected.dataProfile];
  const task = loadPageInputs(async () => {
    const content = await snapshot();
    // Start this page's static inputs together before bundled top-level awaits
    // serialize them. The content loader shares promises with template imports.
    const files = profile?.files ?? ['projection/catalog.json', 'projection/release-index.json', 'projection/media-index.json'];
    await Promise.all([
      ...files.map(name => artifact(name, {optional:true})),
      ...(profile?.groups ?? []).map(pattern => artifactGlob(pattern))
    ]);
    return content;
  }, async () => {
    const app = {...manifest, root};
    const [page, sharedStylesheet, stylesheet] = await Promise.all([
      importPage(new URL(selected.module, root).href),
      manifest.sharedCss ? loadStylesheet(new URL(manifest.sharedCss, root).href, document) : null,
      selected.css ? loadStylesheet(new URL(selected.css, root).href, document) : null
    ]);
    return {app, page, params, sharedStylesheet, stylesheet};
  });
  globalThis[startupKey] = task;
  // The inline starter runs before boot can attach its error UI. Mark the
  // rejection handled without converting the shared task into a success.
  task.catch(() => {});
  return task;
}
