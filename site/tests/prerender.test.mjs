import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pinSnapshot} from '../src/runtime/pin-snapshot.mjs';
import {snapshot} from '../src/runtime/content.mjs';
import {prepareHtml, redirectHtml} from '../../tools/prerender_html.mjs';
import vm from 'node:vm';

test('pinned snapshot is lazy, immutable and shared with legacy interaction modules', async () => {
  globalThis.location = new URL('https://example.test/global/en/');
  delete globalThis[Symbol.for('ournotes.content.snapshot.v1')];
  const root = '/content/releases/' + 'a'.repeat(24) + '/';
  const text = JSON.stringify({schemaVersion:1,root,region:'global',locales:{en:{files:{}}}});
  const pointer = {schemaVersion:1,manifest:root+'manifest.json',sha256:createHash('sha256').update(text).digest('hex')};
  const calls = [];
  globalThis.fetch = async url => {calls.push(url); return new Response(text);};
  pinSnapshot(pointer);
  assert.deepEqual(calls, []);
  const [one,two] = await Promise.all([snapshot(),snapshot()]);
  assert.equal(one,two);
  assert.deepEqual(calls,[pointer.manifest]);
  delete globalThis[Symbol.for('ournotes.content.snapshot.v1')];
  pinSnapshot({...pointer,sha256:'0'.repeat(64)});
  await assert.rejects(snapshot(), /校验失败/);
  delete globalThis[Symbol.for('ournotes.content.snapshot.v1')];
});

const args = {app:{routes:[],endpoints:{},scripts:{'/src/layouts/BaseLayout.astro?astro':'scripts/base.js','/src/components/Live2DWorkbench.astro?astro':'scripts/tool.js'}},codeRoot:'/app/releases/abc/',contentRoot:'/content/releases/abc/',base:'/global/en/',pointer:{},bootstrap:'void 0;',css:'page.css',locale:'en',route:'tools/live2d',derivedRoot:'/rendered/releases/pair/'};
test('old optimizer bookmarks keep server, team, song and anchor in the canonical workbench', () => {
  const here = new URL('https://example.test/jp/en/tools/optimizer/?server=jp&members=member-1&song=track-1#song-settings');
  const html = redirectHtml('/jp/en/tools/deck-builder/', 'en', {preserveLocation:true});
  let destination;
  vm.runInNewContext(html.match(/<script>(.*?)<\/script>/s)[1], {URL, location:{href:here.href,search:here.search,hash:here.hash,replace:value=>destination=value}});
  assert.equal(destination,'https://example.test/jp/en/tools/deck-builder/'+here.search+here.hash);
});
test('tool HTML prepares automatically with the original loading scene and preloads interaction modules', () => {
  const input = '<html><head></head><body><main><live2d-workbench><script type="application/json" data-l2d-config>{"models":[1]}</script><button>Open</button></live2d-workbench></main><script type="module" src="https://prerender.invalid/app/releases/abc/scripts/tool.js"></script><script type="module" src="/app/releases/abc/scripts/base.js"></script></body></html>';
  const result = prepareHtml(input,args);
  assert.equal(result.payloads.length,1);
  assert.deepEqual(JSON.parse(result.payloads[0].bytes),{models:[1]});
  assert.match(result.html,/<live2d-workbench inert=""/);
  assert.match(result.html,/<live2d-workbench[^>]* hidden=""/);
  assert.match(result.html,/\[data-tool-pending\]\s*\{\s*display:\s*none\s*!important/);
  assert.doesNotMatch(result.html,/data-tool-start/);
  assert.match(result.html,/data-tool-status/);
  assert.match(result.html,/loading-companion/);
  assert.match(result.html,/loading-beat/);
  assert.match(result.html,/rel="modulepreload" href="\/app\/releases\/abc\/scripts\/tool.js"/);
  assert.match(result.html,/data-deferred-module="\/app\/releases\/abc\/scripts\/tool.js"/);
  assert.doesNotMatch(result.html,/src="[^"]*tool.js"/);
  assert.match(result.html,/type="module" src="[^"]*base.js"/);
  assert.doesNotMatch(result.html,/prerender.invalid/);
});
test('ordinary pages retain data and scripts, expose first images without waiting for JS', () => {
  const result = prepareHtml('<html><head></head><body><main><h1>Cards</h1><img data-src="/media/a.webp" data-controlled-lazy="pending"><script type="application/json">{"x":1}</script></main></body></html>',{...args,route:'cards/members'});
  assert.equal(result.payloads.length,0);
  assert.match(result.html,/src="\/content\/releases\/abc\/public\/media\/a.webp"/);
  assert.match(result.html,/<h1>Cards<\/h1>/);
  assert.doesNotMatch(result.html,/data-tool-start/);
});
for (const [route, tag] of [['song-ranking','song-ranking'],['event-efficiency','event-efficiency-tool'],['ap-grade','ap-grade-tool'],['deck-builder','team-draft-workbench'],['song-calculator','scoring-research-workbench']]) {
  test(`${route} keeps its controls hidden while preparing the cached payload`, () => {
    const result = prepareHtml(`<html><head></head><body><main><${tag}><h2>Results</h2><script type="application/json">{"rows":[1,2]}</script></${tag}></main><script type="module" src="/app/releases/abc/scripts/tool.js"></script></body></html>`, {...args,route:`tools/${route}`});
    assert.equal(result.payloads.length,1);
    assert.match(result.html,/<h2>Results<\/h2>/);
    assert.match(result.html,/data-deferred-json/);
    assert.match(result.html,new RegExp(`<${tag}[^>]* hidden=""`));
    assert.match(result.html,/rel="modulepreload"/);
    assert.doesNotMatch(result.html,/data-tool-start/);
  });
}
test('unavailable calculator preserves explanation without loading calculation modules', () => {
  const result = prepareHtml('<html><head></head><body><main data-scoring-unavailable>Unavailable</main><script type="module" src="/app/releases/abc/scripts/tool.js"></script></body></html>',{...args,route:'tools/optimizer'});
  assert.match(result.html,/data-scoring-unavailable/);
  assert.match(result.html,/data-deferred-module/);
  assert.doesNotMatch(result.html,/data-tool-start/);
});
test('styles arrive in HTML without a second request and keep code asset URLs', () => {
  const result = prepareHtml('<html><head></head><body><main>Ready</main></body></html>',{...args,route:'characters',css:'pages/characters.css',stylesheet:'.a{background:url(../assets/a.webp)}.b{background:url("data:image/svg+xml,%3Csvg%3E")}'});
  assert.match(result.html,/<style data-prerender-styles="">/);
  assert.match(result.html,/url\("\/app\/releases\/abc\/assets\/a.webp"\)/);
  assert.match(result.html,/data:image\/svg\+xml,%3Csvg%3E/);
  assert.doesNotMatch(result.html,/<link rel="stylesheet"/);
});

test('personal growth retains the original automatic loading scene outside the tools route', () => {
  const result=prepareHtml('<html><head></head><body><main><personal-growth-workbench><script type="application/json">{"cards":[]}</script><h2>My growth</h2></personal-growth-workbench></main><script type="module" src="/app/releases/abc/scripts/tool.js"></script></body></html>',{...args,route:'my-growth'});
  assert.equal(result.payloads.length,1);assert.match(result.html,/loading-companion/);assert.match(result.html,/data-deferred-module/);assert.match(result.html,/personal-growth-workbench inert/);
});

test('old story category bookmarks redirect to modules while retaining server and filters', async () => {
 const {redirectHtml} = await import('../../tools/prerender_html.mjs');
 const vm = await import('node:vm');
 for(const [category,section] of [['main','main'],['extra','extra'],['viewpoint','viewpoint'],['friendship','friendship'],['event','events']]) {
  const html=redirectHtml('/global/zh-CN/stories/main/','zh-CN',{storyDirectory:true});
  const location=new URL(`https://example.test/global/zh-CN/stories/?category=${category}&server=global-kr&q=hello#results`);
  let target; location.replace=value=>{target=new URL(value);};
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{location,URL,URLSearchParams});
  assert.equal(target.pathname,`/global/zh-CN/stories/${section}/`);
  assert.equal(target.search,'?server=global-kr&q=hello');
  assert.equal(target.hash,'#results');
 }
});
