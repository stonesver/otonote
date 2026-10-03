/** Run from a sealed code bundle, against a read-only local content store. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {prepareHtml, redirectHtml} from './prerender_html.mjs';
import {prerenderLoadingArt} from './prerender_loading_art.mjs';
import {localizeHtmlWithStats} from '../site/src/lib/html-localizer.ts';

const [codeArg, storeArg, outputArg, locale = 'zh-CN', pointerArg, region = 'global'] = process.argv.slice(2);
if (!['zh-CN','en'].includes(locale) || !['global','jp'].includes(region)) throw Error('Unsupported projection');
const code = resolve(codeArg), store = resolve(storeArg), output = resolve(outputArg);
const metadata = JSON.parse(await readFile(join(code, 'code-release.json'), 'utf8'));
const pointer = JSON.parse(await readFile(pointerArg, 'utf8'));
if (!/^\/content\/releases\/[a-f0-9]{24}\/manifest.json$/.test(pointer.manifest)) throw Error('Invalid pointer');
const manifestBytes = await readFile(join(store, pointer.manifest.slice('/content/'.length)));
if (createHash('sha256').update(manifestBytes).digest('hex') !== pointer.sha256) throw Error('Invalid manifest digest');
const content = JSON.parse(manifestBytes);
const base = `/${region}/${locale}/`, codeRoot = `/app/releases/${metadata.codeId}/`;
const snapshotId = content.root.split('/').filter(Boolean).at(-1);
const vector = pointer.libraryPointers;
const pair = metadata.codeId + '-' + (vector ? createHash('sha256').update(snapshotId + JSON.stringify(vector)).digest('hex').slice(0,24) : snapshotId);
const derivedRoot = `/rendered/releases/${pair}/`;
globalThis.location = new URL('https://prerender.invalid' + base);
globalThis.__OURNOTES_BASE__ = base;
globalThis[Symbol.for('ournotes.code-root.v1')] = codeRoot;
const pinned = {[region]:pointer, ...(pointer.libraryPointers ?? {})};
const allowedRoots = new Set([content.root]);
for(const [edition, target] of Object.entries(pointer.libraryPointers ?? {})) {
  if(target===null)continue;
  if(!['jp','global'].includes(edition) || !/^\/content\/releases\/[a-f0-9]{24}\/manifest.json$/.test(target.manifest)) throw Error('Invalid library pointer');
  const raw=await readFile(join(store,target.manifest.slice('/content/'.length)));
  const value=JSON.parse(raw);
  if(createHash('sha256').update(raw).digest('hex')!==target.sha256 || (value.region ?? value.contentReleaseId?.split('-')[0])!==edition || value.root!==target.manifest.slice(0,-'manifest.json'.length)) throw Error('Invalid library snapshot');
  allowedRoots.add(value.root);
}
globalThis.fetch = async input => {
  const url = new URL(input, location);
  if (url.origin !== location.origin || !url.pathname.startsWith('/content/')) throw Error('Unexpected renderer request: ' + url);
  const edition = {'/content/current.json':'global','/content/global/current.json':'global','/content/jp/current.json':'jp'}[url.pathname];
  if(edition) return pinned[edition] ? Response.json(pinned[edition]) : new Response('',{status:404});
  const file = resolve(store, url.pathname.slice('/content/'.length));
  if (!file.startsWith(store + '/') || ![...allowedRoots].some(root=>url.pathname.startsWith(root))) throw Error('Mixed or unsafe snapshot');
  try {return new Response(await readFile(file));} catch(error) {if (error.code === 'ENOENT') return new Response('', {status:404}); throw error;}
};
const app = JSON.parse(await readFile(join(code, 'compiled/manifest.json'), 'utf8'));
app.root = 'https://prerender.invalid' + codeRoot;
const fileRoot = pathToFileURL(join(code, 'compiled') + '/');
const shell = await readFile(join(code, 'index.html'), 'utf8');
const boot = shell.match(/src="\/app\/releases\/[a-f0-9]+\/(boot-[^"]+)"/)?.[1];
if (!boot) throw Error('Missing renderer exports');
const {renderToString, renderContext} = await import(new URL(boot, fileRoot));
const bootstrap = await readFile(join(code, 'compiled/prerender/bootstrap.js'), 'utf8');
const navigationScript = await readFile(join(code, 'compiled/prerender/navigation.js'), 'utf8');
const loadingArt = await prerenderLoadingArt({store, contentRoot:content.root, codeRoot});
const results = [];
for (const route of app.routes) {
  // Story text is selected at module evaluation using the document URL. It
  // cannot be reused across story ids in a single renderer process.
  if (['stories/episodes/[id]','database/details/[...record]','404'].includes(route.pattern)) continue;
  globalThis.location = new URL('https://prerender.invalid' + base + route.pattern.replace(/\[.*?\]/g, 'index'));
  const page = await import(new URL(route.module, fileRoot));
  const stylesheet = route.css ? await readFile(new URL(route.css, fileRoot), 'utf8') : undefined;
  const entries = page.getStaticPaths ? await page.getStaticPaths({}) : [{params:{},props:{}}];
  let count = 0;
  for (const entry of entries) {
    const path = route.pattern.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (_,key) => String(entry.params[key]));
    if (path.split('/').some(p => p === '..' || p.startsWith('.')) || /[?#\\]/.test(path)) throw Error('Unsafe rendered path');
    globalThis.location = new URL('https://prerender.invalid' + base + (path ? path + '/' : ''));
    let html = await renderToString(renderContext(location, entry.params, app), page.default, entry.props ?? {}, {}, true);
    if (html instanceof Response) {
      const destination = new URL(html.headers.get('location'), location);
      if (destination.origin !== location.origin) throw Error('Unexpected external page redirect');
      const href = destination.pathname + destination.search + destination.hash;
      const target = join(output, base, path, 'index.html');
      await mkdir(dirname(target), {recursive:true});
      await writeFile(target, redirectHtml(href, locale, {preserveLocation:route.pattern === 'tools/optimizer', storyDirectory:route.pattern === 'stories'}));
      count++; continue;
    }
    if (locale === 'en') html = localizeHtmlWithStats(html, 'en').html;
    const prepared = prepareHtml(html, {app, codeRoot, contentRoot:content.root, base, pointer, bootstrap, navigationScript, loadingArt, css:route.css, stylesheet, locale, route:route.pattern, derivedRoot});
    const target = join(output, base, path, 'index.html');
    await mkdir(dirname(target), {recursive:true});
    await writeFile(target, prepared.html);
    for (const payload of prepared.payloads) {
      await mkdir(join(output, 'payloads'), {recursive:true});
      await writeFile(join(output, 'payloads', payload.name), payload.bytes);
    }
    count++;
  }
  results.push({route:route.pattern, pages:count});
}
await writeFile(join(output, `report-${region}-${locale}.json`), JSON.stringify({schemaVersion:1, codeId:metadata.codeId, pointer, locale, region, results}, null, 2));
console.log(JSON.stringify({locale, region, pages:results.reduce((sum, r) => sum + r.pages, 0), routes:results.length}));
