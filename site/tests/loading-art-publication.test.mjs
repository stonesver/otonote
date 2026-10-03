import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPrerenderRuntime} from '../../tools/build_prerender_runtime.mjs';
import {prepareHtml} from '../../tools/prerender_html.mjs';
import {loadingArtFiles} from '../src/runtime/loading-presentation.mjs';

const codeRoot='/app/releases/test/';
const options={app:{scripts:{},routes:[]},codeRoot,contentRoot:'/content/releases/test/',base:'/global/en/',pointer:{},bootstrap:'',locale:'en',route:'tools/song-ranking',derivedRoot:'/rendered/releases/test/'};
const input='<html><head></head><body><main><song-ranking></song-ranking></main></body></html>';

test('clean code builds supply the image used by tool gates and navigation', async () => {
  const stage=await mkdtemp(join(tmpdir(),'loading-art-'));
  try {
    await buildPrerenderRuntime(stage);
    const {html}=prepareHtml(input,options);
    const src=html.match(/class="loading-companion" src="([^"]+)"/)[1];
    assert.ok(src.startsWith(codeRoot));
    await access(join(stage,src.slice(codeRoot.length)));
    const config=JSON.parse(html.match(/globalThis\[Symbol.for\('ournotes.prerender.v1'\)\]=(.*?);/)[1]);
    assert.equal(config.loadingArt['stamps-1000000004.webp'],src);
    for(const url of Object.values(config.loadingArt)) await access(join(stage,url.slice(codeRoot.length)));
  } finally {await rm(stage,{recursive:true,force:true});}
});

test('tools and navigation use the same pinned content artwork', () => {
  const loadingArt=Object.fromEntries(loadingArtFiles.map(file=>[file,options.contentRoot+'public/gallery/'+file]));
  const {html}=prepareHtml(input,{...options,loadingArt});
  assert.ok(html.includes(`src="${loadingArt['stamps-1000000004.webp']}"`));
  const config=JSON.parse(html.match(/globalThis\[Symbol.for\('ournotes.prerender.v1'\)\]=(.*?);/)[1]);
  assert.deepEqual(config.loadingArt,loadingArt);
});

test('snapshot selection restores available characters and falls back independently for missing art', async () => {
  const {prerenderLoadingArt}=await import('../../tools/prerender_loading_art.mjs');
  const store=await mkdtemp(join(tmpdir(),'loading-content-'));
  const contentRoot='/content/releases/'+'a'.repeat(24)+'/';
  try {
    const select=()=>prerenderLoadingArt({store,contentRoot,codeRoot});
    const fallback=await select();
    for(const file of loadingArtFiles) assert.equal(fallback[file],codeRoot+'loading/brand-fallback.svg');
    const gallery=join(store,contentRoot.slice('/content/'.length),'public/gallery');
    await mkdir(gallery,{recursive:true});
    await writeFile(join(gallery,loadingArtFiles[0]),'fixture');
    const partial=await select();
    assert.equal(partial[loadingArtFiles[0]],contentRoot+'public/gallery/'+loadingArtFiles[0]);
    assert.equal(partial[loadingArtFiles[1]],fallback[loadingArtFiles[1]]);
    await writeFile(join(gallery,loadingArtFiles[1]),'fixture');
    for(const [file,url] of Object.entries(await select())) assert.equal(url,contentRoot+'public/gallery/'+file);
    await assert.rejects(prerenderLoadingArt({store,contentRoot:'/content/../../',codeRoot}),/Invalid loading art snapshot/);
  } finally {await rm(store,{recursive:true,force:true});}
});

test('the actual navigation entry consumes prerender, cold-entry and fallback artwork', async () => {
  const {build}=await import('esbuild');
  const {default:vm}=await import('node:vm');
  const bundled=await build({entryPoints:[new URL('../src/runtime/navigation-client.mjs',import.meta.url).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'text'},plugins:[{name:'capture-navigation-input',setup(build){
    build.onResolve({filter:/navigation-feedback\.mjs$/},()=>({path:'capture',namespace:'test'}));
    build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export function installNavigationFeedback(value) { globalThis.capturedArt=value.art; }'}));
  }}]});
  const pinned=Object.fromEntries(loadingArtFiles.map(file=>[file,options.contentRoot+'public/gallery/'+file]));
  const embedded=Object.fromEntries(loadingArtFiles.map(file=>[file,'data:image/svg+xml;base64,fixture']));
  for(const [prerender,cold,expected] of [[{loadingArt:pinned},null,pinned],[undefined,embedded,embedded],[undefined,null,Object.fromEntries(loadingArtFiles.map(file=>[file,codeRoot+'loading/brand-fallback.svg']))]]) {
    const context={document:{currentScript:{dataset:{codeRoot}},querySelector:()=>cold?{textContent:JSON.stringify(cold)}:null}};
    context[Symbol.for('ournotes.prerender.v1')]=prerender;
    vm.runInNewContext(bundled.outputFiles[0].text,context);
    assert.deepEqual(JSON.parse(JSON.stringify(context.capturedArt)),expected);
  }
});
