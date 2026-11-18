import test from 'node:test';
import assert from 'node:assert/strict';
import {createArenaRankingScroll} from '../src/lib/arena-ranking-scroll.mjs';
test('automatic paging stops for errors, modal, hidden document, detached target and end of capture',()=>{
 let target={isConnected:true},callback,calls=0,blocked=false,disconnects=0;
 const ownerDocument={visibilityState:'visible',addEventListener(){},removeEventListener(){}};
 const state={status:'available',loadingMore:false,paginationError:false,data:{nextCursor:'page2'}};
 const root={ownerDocument,querySelector:()=>target};
 const pager=createArenaRankingScroll({root,getState:()=>state,loadMore:()=>calls++,isBlocked:()=>blocked,makeObserver:fn=>{callback=fn;return {observe(){},disconnect(){disconnects++;}};}});
 pager.observe();const original=target,hit=()=>callback([{target:original,isIntersecting:true}]);
 hit();assert.equal(calls,1);
 for(const [key,value] of [['loadingMore',true],['refreshing',true],['paginationError',true],['status','changed']]){const old=state[key];state[key]=value;hit();state[key]=old;}
 blocked=true;hit();blocked=false;ownerDocument.visibilityState='hidden';hit();ownerDocument.visibilityState='visible';
 target={isConnected:true};hit();target=original;original.isConnected=false;hit();original.isConnected=true;
 state.data.nextCursor=null;hit();assert.equal(calls,1);state.data.nextCursor='next';
 pager.destroy();hit();assert.equal(calls,1);assert.ok(disconnects>0);
});
