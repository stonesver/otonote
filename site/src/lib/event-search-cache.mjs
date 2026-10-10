// Disposable, local-only acceleration. Failure or eviction never blocks a run.
// Bump when candidate generation or scoring behaviour changes.
import {SCORE_MODEL_VERSION} from './scoring-rules/model-version.mjs';
export const EVENT_SEARCH_VERSION = 3;
const ruleKeys=new WeakMap();
export async function searchDigest(value){
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
function rulesKey(rules){
  // Release rules are immutable for the lifetime of a worker.
  if(!ruleKeys.has(rules))ruleKeys.set(rules,searchDigest(rules));
  return ruleKeys.get(rules);
}
export async function eventSearchPartition(rules,eventId,input){
  const {selectedSongId,selectedDifficulty,...draft}=input.draft;
  return searchDigest({version:EVENT_SEARCH_VERSION,modelVersion:SCORE_MODEL_VERSION,rules:await rulesKey(rules),eventId,scope:input.scope,inventory:input.inventory,rewardCards:input.rewardCards,rewardGrowth:input.rewardGrowth,draft});
}
export async function bindEventScoreCache(cache,{rules,chart,draft}){
  const context=await searchDigest({version:EVENT_SEARCH_VERSION,modelVersion:SCORE_MODEL_VERSION,rules:await rulesKey(rules),chart,draft});
  if(cache.get('$context')!==context){cache.clear();cache.set('$context',context);}
}

export function createEventSearchStore({indexedDB=globalThis.indexedDB,maxBytes=48*1024*1024,maxEntries=512}={}){
  let connection;
  const open=()=>connection??=(new Promise(resolve=>{
    if(!indexedDB)return resolve(null);
    const request=indexedDB.open('ournotes-event-search',1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('entries',{keyPath:'key'});request.result.createObjectStore('metadata',{keyPath:'key'});};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
    request.onerror=request.onblocked=()=>resolve(null);
  })).catch(()=>null);
  async function get(key){
    try{
      const db=await open();if(!db)return null;
      return await new Promise(resolve=>{
        const tx=db.transaction(['entries','metadata'],'readwrite'),store=tx.objectStore('entries'),request=store.get(key);
        let result=null;
        request.onsuccess=()=>{const row=request.result;if(row){result=row.value;const meta=tx.objectStore('metadata').get(key);meta.onsuccess=()=>{if(meta.result)tx.objectStore('metadata').put({...meta.result,touched:Date.now()});};}};
        tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>resolve(null);
      });
    }catch{return null;}
  }
  async function put(key,value){
    try{
      const bytes=new TextEncoder().encode(JSON.stringify(value)).length;if(bytes>maxBytes)return false;
      const db=await open();if(!db)return false;
      return await new Promise(resolve=>{
        const tx=db.transaction(['entries','metadata'],'readwrite'),store=tx.objectStore('entries');
        store.put({key,value});const metadata=tx.objectStore('metadata');metadata.put({key,bytes,touched:Date.now()});
        // Cursor collects metadata only, never an in-memory copy of all caches.
        const entries=[];let size=0;const scan=metadata.openCursor();
        scan.onsuccess=()=>{
          const cursor=scan.result;
          if(cursor){const {key,bytes,touched}=cursor.value;entries.push({key,bytes,touched});size+=bytes;cursor.continue();return;}
          entries.sort((a,b)=>a.touched-b.touched);let count=entries.length;
          for(const row of entries){if(size<=maxBytes&&count<=maxEntries)break;store.delete(row.key);metadata.delete(row.key);size-=row.bytes;count--;}
        };
        tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>resolve(false);
      });
    }catch{return false;}
  }
  return {get,put};
}
