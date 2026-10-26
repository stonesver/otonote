import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { loadingKind } from '../src/runtime/loading-route.mjs';
import { loadingArtFiles, loadingPresentation } from '../src/runtime/loading-presentation.mjs';
import { loadPageInputs, loadStylesheet } from '../src/runtime/page-readiness.mjs';

test('the cold entry contains usable navigation, styles, skeletons and retry before modules execute', async () => {
  const bundled = await build({entryPoints:[new URL('../src/runtime/loading-shell.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
  const {renderLoadingShell} = await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const brand = await readFile(new URL('../public/brand/ournotes-mark.svg', import.meta.url));
  const loadingArt = Object.fromEntries(loadingArtFiles.map(file => [file,
    `data:image/svg+xml;base64,${brand.toString('base64')}`]));
  const html = renderLoadingShell({css:'.loading-page{color:black}',clientScript:'',codeRoot:'/app/releases/test/',boot:'boot.js',brandSvg:'<svg/>',loadingArt});
  assert.match(html, /<header[\s>]/);
  assert.match(html, /nav-my-tools/);
  assert.match(html, /配队推荐/);
  assert.match(html, /data-nav-workspace/);
  assert.equal((html.match(/data-loading-toggle=/g) ?? []).length, 3);
  assert.equal((html.match(/data-nav-submenu hidden inert/g) ?? []).length, 3);
  assert.match(html, /<style data-loading-style>\.loading-page/);
  assert.match(html, /<main[^>]*aria-busy="true"/);
  assert.match(html, /href="\/global\/zh-CN\/cards\/members\/"/);
  assert.match(html, /data-loading-retry/);
  assert.match(html, /data-loading-companion[^>]*alt=""/);
  assert.match(html, /href="\/global\/zh-CN\/about\/"/);
  const embeddedArt = JSON.parse(html.match(/<script type="application\/json" data-loading-art>(.*?)<\/script>/s)[1]);
  for (const file of loadingArtFiles) {
    assert.match(embeddedArt[file], /^data:image\/svg\+xml;base64,/);
    assert.deepEqual(Buffer.from(embeddedArt[file].split(',')[1], 'base64'),
      brand);
  }
  assert.ok(!html.includes('data-art-root'));
  assert.ok(!html.includes('/app/releases/test/loading/'));
  assert.ok(!html.includes('src="/content/'));
  assert.match(html, /<noscript>/);
  for (const kind of ['cards','music','detail','story','tool','scene','home','list']) {
    assert.ok(html.includes(`data-loading-template="${kind}"`));
  }
  assert.ok(html.indexOf('<header') < html.indexOf('<script type="module"'));
  const early = renderLoadingShell({css:'', clientScript:'', codeRoot:'/app/releases/test/', boot:'boot.js', brandSvg:'',
    appManifest:{schemaVersion:1, routes:[], scripts:{example:'</script><script>unsafe()'}}, startupScript:'startEarly();'});
  assert.ok(early.indexOf('startEarly();') < early.indexOf('<style data-loading-style>'));
  assert.ok(early.includes('\\u003c/script>\\u003cscript>unsafe()'));
  assert.ok(!early.includes('</script><script>unsafe()'));
});

test('every loading route uses a small bundled companion without content lookup', async () => {
  for (const file of loadingArtFiles) {
    const data = await readFile(new URL('../public/brand/ournotes-mark.svg', import.meta.url));
    assert.ok(data.length < 35_000, `${file} exceeds the decorative image budget`);
  }
  for (const kind of ['home','cards','music','detail','story','scene','tool','list','unknown']) {
    const zh = loadingPresentation(kind), en = loadingPresentation(kind, 'en');
    assert.ok(loadingArtFiles.includes(zh.art));
    assert.equal(en.art, zh.art);
    assert.notEqual(en.caption, zh.caption);
    assert.match(en.caption, /^[\x00-\x7f\u2018\u2019]+$/);
  }
});

test('target route selects a fitting skeleton for either language and direct deep links', () => {
  const paths = {'/':'home','/cards/members/':'cards','/cards/supports/':'cards','/cards/supports/support-card-1/':'detail','/music/':'music','/music/bgm/':'music','/music/music-1/':'detail','/characters/character-1/':'detail','/stories/episodes/story-1/':'story','/tools/song-calculator/':'tool','/tools/live2d/':'scene','/immersive/':'scene','/missions/':'list'};
  for (const locale of ['zh-CN','en']) for (const [path,kind] of Object.entries(paths)) {
    assert.equal(loadingKind(`/global/${locale}${path}`),kind,path);
    assert.equal(loadingKind(`/global/${locale}${path}`.replace(/\/$/,'')),kind,path);
  }
});

test('slow content does not delay starting the route and CSS task', async () => {
  let finishContent, routeStarted = false;
  const result = loadPageInputs(() => new Promise(resolve => {finishContent=resolve;}), async () => {routeStarted=true;return 'route';});
  assert.equal(routeStarted,true);
  finishContent('snapshot');
  assert.deepEqual(await result,{content:'snapshot',route:'route'});
  await assert.rejects(loadPageInputs(async()=>{throw Error('offline');},async()=> 'route'),/offline/);
});

test('the stylesheet gate resolves only after load and rejects failures or stalls', async () => {
  let link;
  const document = {createElement:()=>({remove(){this.removed=true;}}),head:{append(node){link=node;}}};
  let settled = false;
  const ready = loadStylesheet('/page.css',document).then(value=>{settled=true;return value;});
  await Promise.resolve();
  assert.equal(settled,false);
  assert.equal(link.href,'/page.css');
  link.onload();
  assert.equal(await ready,link);
  const failed = loadStylesheet('/missing.css',document);
  link.onerror();
  await assert.rejects(failed,/Stylesheet unavailable/);
  assert.equal(link.removed,true);
  await assert.rejects(loadStylesheet('/stalled.css',document,1),/timed out/);
});

test('loading animation respects reduced motion and explicit motion off', async () => {
  const css=await readFile(new URL('../src/styles/loading-shell.css',import.meta.url),'utf8');
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /data-motion="off"/);
});
