#!/usr/bin/env node
/** Compile existing presentation templates without loading any game snapshot. */
import { readFile, writeFile, mkdir, readdir, cp, access } from 'node:fs/promises';
import { resolve, dirname, relative, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build, transform as transformTs } from '../site/node_modules/esbuild/lib/main.js';
import { transform } from '../site/node_modules/@astrojs/compiler-rs/dist/index.mjs';
import { loadingArtFiles } from '../site/src/runtime/loading-presentation.mjs';
import { attachDataProfiles,interactionPreloads } from './web_client_dependencies.mjs';
import { buildPrerenderRuntime } from './build_prerender_runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');
const output = resolve(process.argv[2] ?? join(root, 'output/web-client'));
if (!output.startsWith(join(root, 'output') + '/')) throw new Error('Output must be under output/');
await mkdir(dirname(output), {recursive:true});
await mkdir(output); // A code release is always new; never overwrite a deployed tree.
const stage = join(output, 'compiled');
const templates = new Map(), scripts = new Map(), workers = new Map();
const groupsByInput = new Map();
async function walk(path) {
  return (await Promise.all((await readdir(path, { withFileTypes: true })).map(e => e.isDirectory() ? walk(join(path, e.name)) : join(path, e.name)))).flat();
}
const extras = new Set(['live2d-catalog.json','immersive-scenes.json','auto-stage-skin.json','music-previews.json','formal-scoring-rules.json']);
async function template(file) {
  if (!templates.has(file)) {
    const filename = '/' + relative(site, file);
    const result = await transform(await readFile(file, 'utf8'), { filename, experimentalScriptOrder: true,
      internalURL: join(site, 'src/runtime/astro.mjs') });
    if (result.diagnostics.some(d => d.severity === 1)) throw new Error(JSON.stringify(result.diagnostics));
    if (result.hydratedComponents.length || result.clientOnlyComponents.length || result.serverComponents.length) throw new Error('Unsupported template directive: ' + filename);
    result.scripts.forEach((script, i) => scripts.set(`${filename}?astro&type=script&index=${i}&lang.ts`, { ...script, file }));
    templates.set(file, result);
  }
  return templates.get(file);
}
function contentModule(name) {
  if (name === 'supplemental/formal-scoring-rules.json') return `import {artifact} from ${JSON.stringify(join(site,'src/runtime/content.mjs'))}; export default (await artifact(${JSON.stringify(name)},{optional:true})) ?? {verificationStatus:'unavailable'};`;
  return `import {artifact} from ${JSON.stringify(join(site,'src/runtime/content.mjs'))}; export default await artifact(${JSON.stringify(name)});`;
}
const plugin = { name: 'ournotes-independent-content', setup(builder) {
  // All page/interaction chunks live one directory below compiled/. Keep the
  // optional player self-contained instead of discovering its runtime in rounds.
  builder.onResolve({ filter: /\/live2d-player\.mjs$/ }, () => ({ path: '../live2d/player.js', external: true }));
  builder.onResolve({ filter: /\/song-ranking-data\.mjs$/ }, () => ({ path:'song-rankings',namespace:'content-derived' }));
  builder.onLoad({ filter: /.*/,namespace:'content-derived' }, () => ({contents:`import {artifact} from ${JSON.stringify(join(site,'src/runtime/content.mjs'))};
    export async function loadSongRankingData({releaseId}) {
      const data=await artifact('supplemental/song-rankings.json');
      if(data.sourceReleaseId!==releaseId || data.unavailable) throw new Error('排行榜与当前内容版本不匹配');
      return data;
    }`,loader:'js',resolveDir:site}));
  builder.onResolve({ filter: /^@projection-data\// }, args => ({ path: 'projection/' + args.path.slice('@projection-data/'.length), namespace: 'content' }));
  builder.onLoad({ filter: /.*/, namespace: 'content' }, args => ({ contents: contentModule(args.path), loader: 'js', resolveDir: site }));
  builder.onResolve({ filter: /\.json$/ }, args => {
    if (!args.path.startsWith('.')) return;
    const path = resolve(args.resolveDir, args.path);
    const local = relative(site, path);
    if (local.startsWith('src/data/') && extras.has(path.split('/').at(-1))) return { path: 'supplemental/' + path.split('/').at(-1), namespace: 'content' };
    if (/^public\/(growth|system-banners|mission-rewards)\/manifest\.json$/.test(local)) return { path: local, namespace: 'content' };
    if (local.startsWith('src/data/') && !['scoring-evidence-global-report.json'].includes(basename(path))) {
      throw new Error('Game data must have a runtime content binding: '+local);
    }
  });
  builder.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0,-4)), namespace: 'raw' }));
  builder.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({ contents: `export default ${JSON.stringify(await readFile(args.path,'utf8'))}`, loader: 'js' }));
  builder.onResolve({ filter: /\.astro\?astro&type=style/ }, args => ({ path: args.path, namespace: 'astro-css' }));
  builder.onLoad({ filter: /.*/, namespace: 'astro-css' }, async args => {
    const [name, query] = args.path.split('?');
    const file = join(site, name);
    const result = await template(file);
    return { contents: result.css[Number(new URLSearchParams(query).get('index'))], loader: 'css', resolveDir: dirname(file) };
  });
  builder.onResolve({ filter: /^interaction:/ }, args => ({ path: args.path.slice('interaction:'.length), namespace: 'interaction' }));
  builder.onLoad({ filter: /.*/, namespace: 'interaction' }, args => {
    const script = scripts.get(args.path);
    return { contents: script.type === 'external' ? `import ${JSON.stringify(script.src)}` : script.code, loader: 'ts', resolveDir: dirname(script.file) };
  });
  builder.onLoad({ filter: /\.(astro|ts|mjs)$/ }, async args => {
    if (!args.path.startsWith(join(site,'src')) && !args.path.startsWith(join(root,'packages/scoring'))) return;
    let code = args.path.endsWith('.astro') ? (await template(args.path)).code : await readFile(args.path, 'utf8');
    // Strip TS type parameters before replacing Vite's data-only glob macro.
    code = (await transformTs(code, { loader: 'ts', target: 'es2022' })).code;
    code = code.replace(/new Worker\(\s*new URL\((["'])(.+?)\1,\s*import.meta.url\)/g, (_,quote,name) => {
      const file=resolve(dirname(args.path),name), key=basename(file).replace(/\.mjs$/, '');
      workers.set(key,file);
      return `new Worker(new URL(${JSON.stringify('../workers/'+key+'.js')}, import.meta.url)`;
    });
    if (code.includes('import.meta.glob')) {
      groupsByInput.set(args.path, [...code.matchAll(/import\.meta\.glob\(\s*["']([^"']+)["']/g)].map(match => match[1]));
      code = `import {artifactGlob as __contentGlob} from ${JSON.stringify(join(site,'src/runtime/content.mjs'))};\n` + code.replace(/import\.meta\.glob\(([^;]*?)\)/g, '(await __contentGlob($1))');
    }
    return { contents: code, loader: 'js', resolveDir: dirname(args.path) };
  });
} };
const pages = (await walk(join(site,'src/pages'))).filter(p => p.endsWith('.astro'));
const entries = Object.fromEntries(pages.map(p => ['pages/' + relative(join(site,'src/pages'),p).replace(/\.astro$/, '').replaceAll('/','_').replace(/[^a-zA-Z0-9_-]/g,'-'),p]));
entries['endpoints/search-index'] = join(site,'src/pages/search-index.json.ts');
entries.boot = join(site,'src/runtime/boot.mjs');
const options = { bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  sourcemap: false, metafile: true, outdir: stage, entryNames: '[dir]/[name]-[hash]', chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]', plugins: [plugin],
  define: { 'import.meta.env.BASE_URL': 'globalThis.__OURNOTES_BASE__', 'import.meta.env.PUBLIC_SITE_PROFILE': '"v1"',
    ...Object.fromEntries(['PUBLIC_GROWTH_TOOL_URL','PUBLIC_GROWTH_SOURCE_URL','PUBLIC_GROWTH_DOWNLOAD_URL']
      .map(key=>['import.meta.env.'+key,JSON.stringify(process.env[key]??'')])),
    'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false', 'import.meta.env': '{}' },
  loader: { '.woff2': 'file', '.woff': 'file', '.png': 'file', '.svg': 'file', '.webp': 'file' } };
await build({ ...options, plugins: [], splitting: false,
  entryPoints: { 'live2d/player': join(site, 'src/lib/live2d-player.mjs') }, entryNames: '[dir]/[name]' });
const compiled = await build({ ...options, entryPoints: entries });
const interactions = await build({ ...options, entryPoints: Object.fromEntries([...scripts.keys()].map((id,i) => ['scripts/script-' + i,'interaction:' + id])) });
// Workers receive their inputs by message. Their URLs must resolve inside the
// immutable code release, including workers created by another worker.
const compiledWorkers = new Set();
while ([...workers.keys()].some(key=>!compiledWorkers.has(key))) {
  const batch=[...workers].filter(([key])=>!compiledWorkers.has(key));
  await build({...options,entryNames:'[dir]/[name]',entryPoints:Object.fromEntries(batch.map(([key,file])=>['workers/'+key,file]))});
  batch.forEach(([key])=>compiledWorkers.add(key));
}
// Heavy recognition engines are static, same-origin and loaded only after explicit use.
const recognitionDir=join(stage,'recognition');
await mkdir(recognitionDir,{recursive:true});
for(const name of ['worker.js','shortlist.js'])await cp(join(site,'src/lib/card-recognition',name),join(recognitionDir,name));
for(const [source,target] of [
  ['@techstark/opencv-js/dist/opencv.js','opencv.js'],['@techstark/opencv-js/LICENSE','OPENCV-LICENSE'],
  ['tesseract.js/dist/tesseract.min.js','tesseract.min.js'],['tesseract.js/dist/worker.min.js','worker.min.js'],
  ['tesseract.js/LICENSE.md','TESSERACT-LICENSE'],['tesseract.js-core/LICENSE','CORE-LICENSE'],
  ['@tesseract.js-data/eng/package.json','LANG-PACKAGE.json'],['@tesseract.js-data/eng/README.md','LANG-README.md'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz','lang/eng.traineddata.gz'],
  ...['lstm','simd-lstm','relaxedsimd-lstm'].flatMap(variant=>['wasm.js','wasm'].map(ext=>[
    `tesseract.js-core/tesseract-core-${variant}.${ext}`,`core/tesseract-core-${variant}.${ext}`]))
]){await mkdir(dirname(join(recognitionDir,target)),{recursive:true});await cp(join(site,'node_modules',source),join(recognitionDir,target));}
const relativeOutput = p => relative(stage, resolve(p));
const byEntry = new Map(Object.entries(compiled.metafile.outputs).filter(([,v]) => v.entryPoint).map(([p,v]) => [resolve(v.entryPoint),{ module:relativeOutput(p), css:v.cssBundle ? relativeOutput(v.cssBundle) : null }]));
const scriptOutputs = Object.fromEntries(Object.entries(interactions.metafile.outputs).filter(([,v])=>v.entryPoint).map(([p,v]) => [v.entryPoint.replace(/^interaction:/,''),relativeOutput(p)]));
const routes = pages.map(p => ({ pattern: relative(join(site,'src/pages'),p).replace(/\.astro$/,'').replace(/(^|\/)index$/,''), ...byEntry.get(p) }));
routes.sort((a,b) => Number(a.pattern.includes('['))-Number(b.pattern.includes('[')) || b.pattern.length-a.pattern.length);
const appManifest = { schemaVersion:1, contentSchemaVersion:1, routes, scripts:scriptOutputs,
  ...interactionPreloads(interactions.metafile,stage),
  endpoints: {'search-index.json':byEntry.get(entries['endpoints/search-index'])} };
const profiledManifest = {...appManifest, buildRoot:stage};
attachDataProfiles(profiledManifest, compiled.metafile, groupsByInput);
appManifest.dataProfiles = profiledManifest.dataProfiles;
await writeFile(join(stage,'manifest.json'),JSON.stringify(appManifest));
for (const group of ['brand','images/filter-bands','vendor/live2d']) {
  const source = join(site,'public',group);
  if (await access(source).then(()=>true,()=>false)) await cp(source,join(stage,group),{recursive:true});
}
// A licensed local Core may be supplied privately to a code build. Keep it out
// of Git; the final code-release manifest records its digest with every file.
if (process.env.OURNOTES_LIVE2D_CORE_FILE) {
  const source = resolve(process.env.OURNOTES_LIVE2D_CORE_FILE);
  const header = (await readFile(source)).subarray(0, 512).toString('utf8');
  if (!header.includes('Live2D Cubism Core') || !header.includes('Redistributable Code')) {
    throw new Error('Invalid licensed Live2D Core file');
  }
  await cp(source, join(stage,'vendor/live2d/live2dcubismcore.min.js'));
}
await mkdir(join(stage, 'loading'));
const loadingArt = {}, loadingSources = [];
for (const file of loadingArtFiles) {
  const original = join(site,'public/gallery',file);
  const present = await access(original).then(()=>true,()=>false);
  const source = present ? original : join(site,'public/brand/ournotes-mark.svg');
  const mime = source.endsWith('.svg') ? 'image/svg+xml' : 'image/webp';
  loadingArt[file] = `data:${mime};base64,${(await readFile(source)).toString('base64')}`;
  loadingSources.push({file,source:relative(root,source),fallback:!present});
}
await writeFile(join(stage,'loading/provenance.json'),JSON.stringify({
  usage:'Available decorative artwork, or the original site mark when game assets are absent.',files:loadingSources
},null,2));
await cp(join(site,'public/favicon.svg'),join(stage,'favicon.svg'));
const boot = byEntry.get(entries.boot).module;
await buildPrerenderRuntime(stage);
const navigationScript = await readFile(join(stage,'prerender/navigation.js'),'utf8');
// Build the first frame without loading a game snapshot. Inline its styles and
// tiny route selector so even cold/failed module requests leave a usable page.
const shellRenderer = await build({entryPoints:[join(site,'src/runtime/loading-shell.mjs')],bundle:true,write:false,format:'esm',platform:'node',target:'es2022'});
const {renderLoadingShell} = await import('data:text/javascript;base64,'+Buffer.from(shellRenderer.outputFiles[0].text).toString('base64'));
const shellClient = await build({entryPoints:[join(site,'src/runtime/loading-shell-client.mjs')],bundle:true,write:false,minify:true,format:'iife',target:'es2022'});
const startupClient = await build({entryPoints:[join(site,'src/runtime/startup-client.mjs')],bundle:true,write:false,minify:true,format:'iife',target:'es2022'});
const shellCss = (await Promise.all(['global','site-shell','unified-search','loading-shell'].map(name=>readFile(join(site,`src/styles/${name}.css`),'utf8')))).join('\n');
const css = (await transformTs(shellCss,{loader:'css',minify:true})).code;
const shell = renderLoadingShell({css,clientScript:shellClient.outputFiles[0].text,
  appManifest,startupScript:startupClient.outputFiles[0].text,loadingArt,navigationScript,
  codeRoot:'/app/releases/__CODE_ID__/',boot,brandSvg:await readFile(join(site,'public/brand/ournotes-mark.svg'),'utf8')});
// Shell-only edits must also create a new immutable code identity.
await writeFile(join(stage,'entry-shell.json'),JSON.stringify({sha256:createHash('sha256').update(shell).digest('hex')}));
// Bind the official source identity before sealing; docs/test-only commits must
// not collide with an existing immutable release carrying another receipt.
if (process.env.OURNOTES_SOURCE_FINGERPRINT || process.env.OURNOTES_SOURCE_COMMIT) {
  const fingerprint=process.env.OURNOTES_SOURCE_FINGERPRINT, commit=process.env.OURNOTES_SOURCE_COMMIT, verificationRun=process.env.OURNOTES_VERIFICATION_RUN;
  if (!/^[a-f0-9]{64}$/.test(fingerprint??'') || !/^[a-f0-9]{40,64}$/.test(commit??'') || !/^[a-f0-9]{32}$/.test(verificationRun??'')) throw Error('Invalid source identity');
  await writeFile(join(stage,'build-source.json'),JSON.stringify({fingerprint,commit,verificationRun}));
}
const files = {};
for (const file of (await walk(stage)).sort()) files[relative(stage,file)] = createHash('sha256').update(await readFile(file)).digest('hex');
const codeId = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0,24);
await writeFile(join(output,'index.html'),shell.replaceAll('__CODE_ID__',codeId));
await writeFile(join(output,'code-release.json'),JSON.stringify({schemaVersion:1,codeId,contentSchemaVersion:1,files,provenance:{kind:'local-preview'}},null,2));
console.log(JSON.stringify({codeId,routes:routes.length,scripts:scripts.size,files:Object.keys(files).length,output},null,2));
