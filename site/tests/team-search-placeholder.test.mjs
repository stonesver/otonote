import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeamSearchPlaceholder} from '../src/lib/team-search-placeholder.mjs';

test('waiting view disappears on the first streamed team, cancellation or task switch',t=>{
 const original=globalThis.document;
 globalThis.document={createElement:()=>({children:[],style:{setProperty(){}},setAttribute(){},append(...nodes){this.children.push(...nodes);}})};
 t.after(()=>{if(original)globalThis.document=original;else delete globalThis.document;});
 const view=createTeamSearchPlaceholder();
 assert.equal(view.element.hidden,true);
 view.update({running:true,title:'正在寻找推荐队伍'});
 assert.equal(view.element.hidden,false);
 // A partial team must replace the animation while computation continues.
 view.update({running:true,hasResults:true});
 assert.equal(view.element.hidden,true);
 view.update({running:false,hasResults:false});
 assert.equal(view.element.hidden,true);
 view.update({running:true,active:false});
 assert.equal(view.element.hidden,true);
 view.update({running:true,title:'正在寻找冲榜队伍'});
 assert.equal(view.element.hidden,false);
 assert.equal(view.element.children[0].children[1].textContent,'正在寻找冲榜队伍');
});
