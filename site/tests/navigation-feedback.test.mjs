import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {documentNavigationTarget, documentNavigationLabel} from '../src/lib/navigation-feedback.mjs';
const here='https://example.test/global/zh-CN/cards/members/';
const event={button:0};
const link=(href,extra={})=>({href,target:'',hasAttribute:()=>false,...extra});
const labelLink = (text, attributes = {}, heading = '') => ({
 textContent:text, getAttribute:name=>attributes[name] ?? null,
 querySelector:()=>heading ? {textContent:heading} : null,
});
test('rich activity cards use the activity heading, not dates, bonuses and rewards',()=>{
 const card=labelLink('EVENT01 活动 挑战演出活动 アイの奔流 AtoZ 2026/09/30 加成乐队 9 话故事 查看活动', {}, 'アイの奔流　AtoZ');
 assert.equal(documentNavigationLabel(card),'アイの奔流 AtoZ');
});
test('navigation labels prefer explicit titles and stay short for links without headings',()=>{
 assert.equal(documentNavigationLabel(labelLink('misc',{'data-navigation-title':'活动故事'})), '活动故事');
 assert.equal(documentNavigationLabel(labelLink('decorative text',{'aria-label':'歌曲目录'})), '歌曲目录');
 assert.equal(documentNavigationLabel(labelLink('  活动\n  ')), '活动');
 assert.equal(documentNavigationLabel(labelLink('很长的卡片内容'.repeat(30))), '');
});
test('normal region/locale navigation keeps filters and server identity',()=>{
 const url=documentNavigationTarget(event,link('/jp/en/music/?server=jp'),here);
 assert.equal(url.href,'https://example.test/jp/en/music/?server=jp');
});
test('dialogs, hash changes, modified clicks, new tabs and downloads stay native',()=>{
 for(const [e,a] of [[{...event,defaultPrevented:true},link('/jp/en/')],[{...event,ctrlKey:true},link('/jp/en/')],[{...event,button:1},link('/jp/en/')],[event,link('/jp/en/',{target:'_blank'})],[event,link('/jp/en/',{hasAttribute:()=>true})],[event,link('#detail=item-1')],[event,link('https://other.test/jp/en/')],[event,link('/content/releases/a/file.json')],[event,link('/global/en/favicon.svg')]])assert.equal(documentNavigationTarget(e,a,here),null);
});

test('navigation starts immediately with top progress rail and defers full-page waiting overlay until slow threshold', async () => {
 const listeners=new Map(), dataset={motion:'on'}, assigned=[], timers=[];
 class Element {
  constructor(){this.style={visibility:''};this.inert=false;this.dataset={};this.attributes=new Map();}
  setAttribute(k,v){this.attributes.set(k,v);}
  getAttribute(k){return this.attributes.get(k) ?? null;}
  removeAttribute(k){this.attributes.delete(k);}
  hasAttribute(k){return this.attributes.has(k);}
  focus(){}
 }
 const main=new Element();
 const nodes=new Map();
 const panel=new Element();
 panel.querySelector=selector=>{
  if(!nodes.has(selector))nodes.set(selector,new Element());
  return nodes.get(selector);
 };
 const document={documentElement:{dataset,hasAttribute:()=>false},
  head:{append(){}},body:{append(node){node.isConnected=true;}},
  querySelector:selector=>selector==='#main-content'?main:null,
  querySelectorAll:()=>[],addEventListener(){},
  createElement:tag=>tag==='main'?panel:new Element()
 };
 const source=readFileSync(new URL('../src/lib/navigation-feedback.mjs',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replaceAll('export function','function');
 vm.runInNewContext(source+'\ninstallNavigationFeedback({css:"",art:{stamp:"/stamp.webp"}});',{
  document,window:{addEventListener:(name,fn)=>listeners.set(name,fn)},Element,
  Image:class {},MutationObserver:class {observe(){} disconnect(){}},URL,
  location:{href:here,assign:url=>assigned.push(url)},matchMedia:()=>({matches:false}),
  setTimeout:(fn,ms)=>{const id=timers.length+1;timers.push({id,fn,ms});return id;},clearTimeout(){},
  loadingKind:()=> 'tool',
  loadingPresentation:()=>({art:'stamp',caption:'好演出，从准备开始。'})
 });
 const anchor=new Element();anchor.href='/global/zh-CN/tools/song-calculator/';anchor.textContent='歌曲计算';anchor.querySelector=()=>null;
 const target=new Element();target.closest=()=>anchor;
 listeners.get('click')({button:0,target,preventDefault(){}});
 assert.deepEqual(assigned,['https://example.test/global/zh-CN/tools/song-calculator/']);
 assert.equal(dataset.navigationPhase,'loading');
 assert.equal(main.style.visibility,'');
 assert.notEqual(panel.isConnected,true);
 const slowOverlay=timers.find(t=>t.ms===300);
 assert.ok(slowOverlay,'slow-network overlay timer should be scheduled');
 slowOverlay.fn();
 assert.equal(main.style.visibility,'hidden');
 assert.equal(panel.isConnected,true);
 assert.equal(nodes.get('img').src,'/stamp.webp');
});
