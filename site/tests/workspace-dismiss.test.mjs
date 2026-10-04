import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkspaceDismiss} from '../src/lib/workspace-dismiss.mjs';
function fixture(){
  const doc=new EventTarget(),panel=new EventTarget(),inside={},outside={},launcher={contains:target=>target===launcher};
  Object.assign(panel,{ownerDocument:doc,open:true,isConnected:true,nested:false,querySelector:()=>panel.nested,contains:target=>target===inside,getBoundingClientRect:()=>({left:100,right:500,top:20,bottom:700})});
  let dismissed=0;const cleanup=installWorkspaceDismiss(panel,launcher,()=>dismissed++);
  const fire=(type,target=outside,props={})=>{const event=new Event(type);Object.defineProperties(event,Object.fromEntries(Object.entries({target,button:0,clientX:0,clientY:0,...props}).map(([key,value])=>[key,{value}])));doc.dispatchEvent(event);};
  return {panel,inside,outside,launcher,fire,cleanup,count:()=>dismissed};
}
test('closes on an outside press and release, including modal backdrop coordinates',()=>{
  const f=fixture();f.fire('pointerdown');f.fire('click');assert.equal(f.count(),1);
  f.fire('pointerdown',f.panel,{clientX:40,clientY:50});f.fire('click',f.panel,{clientX:40,clientY:50});assert.equal(f.count(),2);
});
test('inside clicks, drags across edge, keyboard clicks and launcher are preserved',()=>{
  const f=fixture();for(const target of [f.inside,f.launcher]){f.fire('pointerdown',target);f.fire('click',target);}
  f.fire('pointerdown',f.inside);f.fire('click');f.fire('pointerdown');f.fire('click',f.inside);f.fire('click');
  f.fire('pointerdown',f.panel,{clientX:200,clientY:50});f.fire('click',f.panel,{clientX:200,clientY:50});assert.equal(f.count(),0);
});
test('child modal interactions and interrupted gestures do not close parent',()=>{
  const f=fixture();f.panel.nested=true;f.fire('pointerdown');f.panel.nested=false;f.fire('click');
  f.fire('pointerdown');f.fire('pointercancel');f.fire('click');
  f.fire('pointerdown');f.panel.dispatchEvent(new Event('close'));f.fire('click');assert.equal(f.count(),0);
});
test('closed or disconnected panels and disposed listeners are inert',()=>{
  const f=fixture();f.panel.open=false;f.fire('pointerdown');f.fire('click');f.panel.open=true;f.panel.isConnected=false;f.fire('pointerdown');f.fire('click');
  f.panel.isConnected=true;f.cleanup();f.fire('pointerdown');f.fire('click');assert.equal(f.count(),0);
});
