import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolCardPicker} from '../src/lib/tool-card-picker.mjs';

class Element extends EventTarget {
 constructor(tag,document){super();this.tagName=tag;this.ownerDocument=document;this.children=[];this.dataset={};this.attributes={};this.value='';this.scrollTop=0;this.disabled=false;this.open=false;}
 append(...children){this.children.push(...children);if(this.tagName==='select'&&this.children.length===children.length)this.value=children[0]?.value??'';}
 replaceChildren(...children){this.children=[...children];}
 setAttribute(name,value){this.attributes[name]=String(value);}
 focus(){this.ownerDocument.activeElement=this;}
 showModal(){this.open=true;}
 close(){this.open=false;this.dispatchEvent(new Event('close'));}
 querySelector(){return null;}
 getBoundingClientRect(){return {left:10,right:110,top:10,bottom:110};}
}
function setup(t){
 const document={documentElement:{lang:'en'},activeElement:null,createElement:tag=>new Element(tag,document)};
 const before=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});
 t.after(()=>{if(before)Object.defineProperty(globalThis,'document',before);else delete globalThis.document;});
 const root=document.createElement('div');root.data={};
 const cards=[1,2].map(id=>({id:`member-card-${id}`,kind:'member',displayName:`Stage ${id}`,attributeCode:1,bandIds:['band-1'],characterIds:[`character-${id}`],rarity:2}));
 const draft={slots:Array.from({length:5},()=>({memberCardId:null,supportCardId:null})),modifiers:{}};
 const picker=createToolCardPicker({root,getCards:kind=>kind==='member'?cards:[],getDraft:()=>draft,getOwned:()=>[],conflict:card=>draft.slots.some(s=>s.memberCardId===card.id)?'Already selected':'',
  getCardState:()=>({growth:{level:2},source:'actual'}),onChoose:(card,target)=>{draft.slots[target.slot][`${target.kind}CardId`]=card.id;}});
 const nodes=()=>{const walk=node=>[node,...node.children.flatMap(c=>typeof c==='string'?[]:walk(c))];return walk(root);};
 return {root,document,picker,draft,nodes};
}
test('continuous selection retains filters and focuses a card without returning to search',t=>{
 const {picker,nodes,draft,document}=setup(t);picker.open('member',0);
 const search=nodes().find(n=>n.type==='search'),band=nodes().find(n=>n.dataset.cardFilter==='band');search.value='Stage';search.dispatchEvent(new Event('input'));band.value='1';band.dispatchEvent(new Event('change'));
 nodes().find(n=>n.dataset.cardId==='member-card-1').dispatchEvent(new Event('click'));
 assert.equal(draft.slots[0].memberCardId,'member-card-1');assert.equal(search.value,'Stage');assert.equal(band.value,'1');assert.equal(document.activeElement.dataset.cardId,'member-card-2');
 const dialog=nodes().find(n=>n.className==='ux-card-picker');assert.equal(dialog.open,true);dialog.close();picker.open('member',3);assert.equal(search.value,'Stage');assert.equal(band.value,'1');
});
test('pointer backdrop dismissal closes the picker and stops the click before a parent dialog sees it',t=>{
 const {picker,nodes}=setup(t);picker.open('member',0);const dialog=nodes().find(n=>n.className==='ux-card-picker');
 const event=type=>{const e=new Event(type,{cancelable:true});Object.defineProperties(e,{clientX:{value:1},clientY:{value:1}});return e;};
 dialog.dispatchEvent(event('pointerdown'));const click=event('click');dialog.dispatchEvent(click);assert.equal(dialog.open,false);assert.equal(click.defaultPrevented,true);assert.equal(click.cancelBubble,true);
});
