import test from 'node:test';
import assert from 'node:assert/strict';
import {setupWorkbenchControls} from '../src/lib/workbench-controls.mjs';

test('segmented controls update original fields and reflect external changes and disabled options',t=>{
 class Node extends EventTarget {
  constructor(){super();this.children=[];this.attrs={};this.classList={add(){},remove(){}};}
  append(n){this.children.push(n);}
  setAttribute(k,v){this.attrs[k]=v;}
  getAttribute(k){return this.attrs[k]??null;}
  remove(){this.removed=true;}
 }
 const previous=globalThis.document;globalThis.document={createElement:()=>new Node()};t.after(()=>globalThis.document=previous);
 const host=new Node(),field=new Node(),label=new Node();label.childNodes=[{nodeType:3,textContent:'演出类型'}];
 field.options=[{value:'ordinary',textContent:'普通演出'},{value:'challenge',textContent:'挑战演出'}];field.value='ordinary';field.hidden=false;
 field.closest=()=>label;field.after=n=>label.append(n);host.querySelector=s=>s==='[data-mode]'?field:null;
 const events=[];field.addEventListener('input',()=>events.push('input'));field.addEventListener('change',()=>events.push('change'));
 const controls=setupWorkbenchControls(host),buttons=label.children[0].children;
 buttons[1].dispatchEvent(new Event('click'));
 assert.equal(field.value,'challenge');assert.deepEqual(events,['input','change']);assert.equal(buttons[1].attrs['aria-pressed'],'true');
 field.value='ordinary';field.options[1].disabled=true;host.dispatchEvent(new Event('change'));
 assert.equal(buttons[0].attrs['aria-pressed'],'true');assert.equal(buttons[1].disabled,true);
 controls.destroy();assert.equal(field.hidden,false);assert.equal(label.children[0].removed,true);
});
