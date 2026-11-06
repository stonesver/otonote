import test from 'node:test';
import assert from 'node:assert/strict';
import {teamWorkbenchState,setupTeamWorkbenchView} from '../src/lib/team-workbench-view.mjs';

test('setup, in-flight work and completed recommendations have distinct states',()=>{
  assert.equal(teamWorkbenchState(), 'setup');
  assert.equal(teamWorkbenchState({running:true,hasResults:true},'running'),'running');
  assert.equal(teamWorkbenchState({finished:true,hasResults:true},'complete'),'results');
  assert.equal(teamWorkbenchState({finished:true,hasResults:false},'complete'),'empty');
});
test('cancellation and failure never present partial candidates as completed work',()=>{
  for(const hasResults of [false,true]) {
    assert.equal(teamWorkbenchState({finished:true,hasResults},'stopped'),'stopped');
    assert.equal(teamWorkbenchState({finished:true,hasResults},'error'),'error');
  }
  assert.equal(teamWorkbenchState({running:true},'stopped'),'running');
});
test('comparison stays accessible during calculation and restores the optimizer state on return',()=>{
  const state={running:true,hasResults:true};
  assert.equal(teamWorkbenchState(state,'running',true),'compare');
  assert.equal(teamWorkbenchState(state,'running',false),'running');
  assert.equal(teamWorkbenchState({},'idle',false),'setup');
});

test('the live layout keeps the original band filters beside the card source after hiding the legacy sidebar',t=>{
  const created=[];
  class Node {
    constructor(){created.push(this);this.children=[];this.dataset={};this.attributes={};this.className='';this.hidden=false;this.value='';this.textContent='';this.options=[];this.selectedOptions=[];this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){}};}
    get ownerDocument(){return document;}
    append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
    prepend(...nodes){this.append(...nodes);this.children=[...nodes,...this.children.filter(node=>!nodes.includes(node))];}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
    before(){} after(){}
    replaceChildren(...nodes){for(const node of this.children)node.parentElement=null;this.children=[];this.append(...nodes);}
    contains(node){return this===node||this.children.some(child=>child.contains(node));}
    closest(selector){this.parents??=new Map();if(!this.parents.has(selector)){const parent=new Node();parent.append(this);this.parents.set(selector,parent);}return this.parents.get(selector);}
    querySelector(){return null;}
    querySelectorAll(){return [];}
    addEventListener(){}
    setAttribute(key,value){this.attributes[key]=String(value);}
    getAttribute(key){return this.attributes[key]??null;}
    getBoundingClientRect(){return {height:50};}
  }
  const prior={document:globalThis.document,MutationObserver:globalThis.MutationObserver,ResizeObserver:globalThis.ResizeObserver};
  globalThis.document={createElement:()=>new Node(),createElementNS:()=>new Node()};
  globalThis.MutationObserver=globalThis.ResizeObserver=class{observe(){}disconnect(){}};
  t.after(()=>{for(const [key,value] of Object.entries(prior)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
  const nodes=new Map(),q=selector=>{if(!nodes.has(selector))nodes.set(selector,new Node());return nodes.get(selector);};
  const host=new Node();host.querySelector=q;host.data={locale:'zh-CN'};
  const inputs=Object.fromEntries(['main','shell','aside','conditionBody','current','context','songRow','songLabel','songButton','tags','adjust'].map(key=>[key,new Node()]));
  inputs.aside.append(inputs.conditionBody);
  const bands=q('[data-search-card-bands]'),member=q('[data-search-band]'),support=q('[data-search-support-band]');bands.append(member,support);inputs.conditionBody.append(bands);
  q('[data-planning-kind]').value='reference';q('[data-search-constraints]').value='{}';q('[data-planning-window-limit]').value='5';q('[data-pairing-objective]').value='expected_song_score';
  setupTeamWorkbenchView(host,inputs);
  assert.equal(inputs.aside.hidden,true);
  const cards=created.find(node=>node.className==='team-card-field');
  assert.ok(cards.contains(member),'member band filter must leave the hidden legacy sidebar');
  assert.ok(cards.contains(support),'memory band filter must leave the hidden legacy sidebar');
  assert.equal(bands.parentElement,cards,'move the existing controls so their listeners and selected values survive');
});
