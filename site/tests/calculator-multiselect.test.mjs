import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setupQuickOptions,selectedOptionText} from '../src/lib/tool-quick-options.mjs';
import {selectedControlValues,restoreFilterControl} from '../src/lib/filter-controls.mjs';
import {filterTeamCards} from '../src/lib/team-card-filters.mjs';
import {filterCalculatorCards} from '../src/lib/calculator-card-model.mjs';
import {matchesSongChart} from '../src/lib/calculator-song-picker.mjs';
import {eventSongCandidates} from '../src/lib/event-song-ranking.mjs';
import {rankSongRows} from '../src/lib/song-ranking-view.mjs';
import {resolveSearchInput} from '../src/lib/scoring-rules/formation-input.mjs';
import {createTeamDraft} from '../src/lib/team-draft.mjs';
import {readOptimizerConstraints} from '../src/lib/optimizer-search-summary.mjs';

function quickField(values,{required=false,selected=[values[0]],all='all',multiple=true,icons={}}={}) {
 const make=tag=>({tagName:tag,dataset:{},attributes:{},children:[],listeners:{},
  setAttribute(k,v){this.attributes[k]=String(v);},getAttribute(k){return this.attributes[k]??null;},hasAttribute(k){return k in this.attributes;},removeAttribute(k){delete this.attributes[k];},
  append(...nodes){this.children.push(...nodes);},addEventListener(k,f){this.listeners[k]=f;},removeEventListener(){},remove(){},closest(){return null;}});
 const field=make('SELECT');field.multiple=multiple;field.dataset.quick='';field.dataset.quickAll=all;field.setAttribute('data-quick','');field.setAttribute('aria-label','Filter');if(required)field.setAttribute('data-quick-required','');
 field.options=values.map(value=>({value,textContent:value.toUpperCase(),selected:selected.includes(value),dataset:icons[value]?{icon:icons[value],iconOnly:'true'}:{},hasAttribute(key){return key==='data-icon-only'&&this.dataset.iconOnly==='true';}}));
 Object.defineProperty(field,'selectedOptions',{get:()=>field.options.filter(o=>o.selected)});
 Object.defineProperty(field,'value',{get:()=>field.selectedOptions[0]?.value??'',set:value=>{for(const o of field.options)o.selected=o.value===value;}});
 let group;const events=[];field.after=node=>{group=node;};field.dispatchEvent=e=>{events.push(e.type);root.listeners[e.type]?.();};
 const root=make('DIV');root.ownerDocument={documentElement:{lang:'en'},createElement:make};root.querySelectorAll=()=>[field];
 const controller=setupQuickOptions(root),click=value=>group.children[values.indexOf(value)].listeners.click();
 const pressed=()=>group.children.filter(b=>b.attributes['aria-pressed']==='true').map(b=>b.title.toLowerCase());
 return {field,events,controller,click,pressed,get group(){return group;}};
}
test('quick difficulty buttons accumulate selections, preserve one, select all and restore accessibly',()=>{
 const f=quickField(['expert','hard','normal','easy','all'],{required:true});
 assert.deepEqual(f.pressed(),['expert']);f.click('hard');assert.deepEqual(selectedControlValues(f.field),['expert','hard']);assert.deepEqual(f.pressed(),['expert','hard']);assert.equal(selectedOptionText(f.field),'EXPERT＋HARD');
 f.click('expert');f.click('hard');assert.deepEqual(selectedControlValues(f.field),['hard']);
 f.click('all');assert.deepEqual(selectedControlValues(f.field),['expert','hard','normal','easy']);assert.equal(selectedOptionText(f.field),'ALL');
 f.click('easy');assert.deepEqual(f.pressed(),['expert','hard','normal']);assert.deepEqual(f.events.slice(0,2),['input','change']);
 f.controller.destroy();assert.equal(f.field.hidden,false);assert.equal(f.field.dataset.quickReady,undefined);
});
test('unrestricted filter groups toggle subsets and clearing the last choice restores all; single controls stay single',()=>{
 const f=quickField(['all','band-1','band-2']);assert.deepEqual(selectedControlValues(f.field),[]);f.click('band-1');f.click('band-2');assert.deepEqual(selectedControlValues(f.field),['band-1','band-2']);
 f.click('band-1');f.click('band-2');assert.deepEqual(selectedControlValues(f.field),[]);assert.deepEqual(f.pressed(),['all']);
 f.click('band-1');f.click('all');assert.deepEqual(selectedControlValues(f.field),[]);restoreFilterControl(f.field,['band-2']);f.controller.sync();assert.deepEqual(f.pressed(),['band-2']);
 const single=quickField(['a','b'],{multiple:false});single.click('b');assert.equal(single.field.value,'b');assert.deepEqual(single.pressed(),['b']);
});
test('song and card filters combine OR within each multi-selection and AND between groups',()=>{
 const tracks=[{id:'a',bandIds:['band-1'],musicType:1},{id:'b',bandIds:['band-2'],musicType:2},{id:'c',bandIds:['band-3'],musicType:1}];
 const charts=tracks.flatMap(t=>['expert','hard','normal'].map(difficulty=>({id:`${t.id}-${difficulty}`,trackId:t.id,difficulty,level:20,analysisDataUrl:'/chart'})));
 assert.deepEqual(eventSongCandidates({tracks,charts,band:['band-1','band-2'],attribute:['1','2'],difficulty:['expert','hard']}).map(c=>c.id),['a-expert','a-hard','b-expert','b-hard']);
 assert.equal(eventSongCandidates({tracks,charts,band:['band-1','band-2'],attribute:['1'],difficulty:['hard']})[0].id,'a-hard');
 assert.equal(matchesSongChart({difficulty:'hard',level:20},{difficulty:['expert','hard']}),true);assert.equal(matchesSongChart({difficulty:'normal',level:20},{difficulty:['expert','hard']}),false);
 const cards=tracks.map((t,i)=>({...t,kind:'member',shortLabel:t.id,attributeCode:t.musicType,rarity:i+2}));
 assert.deepEqual(filterTeamCards(cards,{band:['1','2'],attribute:['1','2'],rarity:['2','3']}).map(c=>c.id),['a','b']);
 assert.deepEqual(filterCalculatorCards(cards,{band:['band-1','band-2'],attributes:['1','2'],rarity:['2','3']}).map(c=>c.id),['b','a']);
 const rows=charts.map(c=>({...c,bands:tracks.find(t=>t.id===c.trackId).bandIds,title:c.id,expectedScore:1,chartSeconds:100}));
 assert.equal(rankSongRows(rows,{difficulty:['hard','expert'],band:['band-1','band-2']}).length,4);
 assert.equal(rankSongRows(rows,{difficulty:[],band:[]}).length,9);
});
test('optimizer reads multiple constraints and applies unions before distinct-character checks, retaining scalar compatibility',()=>{
 const rules=JSON.parse(readFileSync(new URL('../../packages/scoring/data/formal-scoring-rules.json',import.meta.url))),draft=createTeamDraft();
 const all=resolveSearchInput(rules,draft,{scope:'theoretical'});
 const constraints={bandId:[1,2],attribute:[1,2,3,4,5],supportAttribute:[1,2,3,4,5]};
 const before=structuredClone(constraints),result=resolveSearchInput(rules,draft,{scope:'theoretical',constraints});
 const chars=new Map(rules.tables.Character.map(c=>[c._id,c._bandID]));
 const expected=rules.tables.MemberCard.filter(c=>constraints.bandId.includes(chars.get(c._characterID))&&constraints.attribute.includes(c._cardType)).map(c=>`member-card-${c._id}`);
 assert.deepEqual(result.inventory.memberCardIds,expected);assert.deepEqual(constraints,before);assert.ok(result.inventory.memberCardIds.length<=all.inventory.memberCardIds.length);
 assert.deepEqual(resolveSearchInput(rules,draft,{scope:'theoretical',constraints:{bandId:[2]}}).inventory,resolveSearchInput(rules,draft,{scope:'theoretical',constraints:{bandId:2}}).inventory);
 assert.throws(()=>resolveSearchInput(rules,draft,{scope:'theoretical',constraints:{bandId:[1,'2']}}),/bandId/);
 const controls=Object.fromEntries(['band','attribute','support-attribute'].map((name,i)=>[`[data-search-${name}]`,{multiple:true,selectedOptions:(i===0?['1','2']:[]).map(value=>({value}))}]));
 controls['[data-search-constraints]']={value:'{"leaderId":1}'};
 assert.deepEqual(readOptimizerConstraints({querySelector:s=>controls[s]}),{leaderId:1,bandId:[1,2]});
});

test('band icons keep accessible names, multi-selection and a readable fallback',()=>{
 const f=quickField(['all','mygo','mujica'],{icons:{mygo:'/mygo.webp',mujica:'/mujica.webp'}});
 const button=f.group.children[1],image=button.children[0],label=button.children[1];
 assert.equal(button.getAttribute('aria-label'),'MYGO');assert.equal(button.title,'MYGO');
 assert.equal(image.src,'/mygo.webp');assert.equal(label.className,'tool-choice-label');
 f.click('mygo');f.click('mujica');assert.deepEqual(selectedControlValues(f.field),['mygo','mujica']);
 image.listeners.error();assert.equal(image.hidden,true);assert.equal(label.className,'');assert.equal(button.dataset.icon,undefined);
 f.click('all');assert.deepEqual(selectedControlValues(f.field),[]);
});
