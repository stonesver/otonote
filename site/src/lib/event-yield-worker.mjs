import {optimizeEventYield} from './event-yield-optimizer.mjs';
import {eventYieldGoals,selectEventYieldRows,EVENT_YIELD_GOAL_LABELS} from './event-yield-goals.mjs';
import {createCalculationScheduler} from './calculation-scheduler.mjs';
import {createEventSearchStore,eventSearchPartition,searchDigest} from './event-search-cache.mjs';
import {planEventSearch} from './event-search-plan.mjs';
import {eventYieldStageInput} from './event-yield-stage.mjs';
const store=createEventSearchStore();
self.addEventListener('message',async({data})=>{
 try{
   const {rules,eventId,candidates,challengeCandidates,input}=data;
   const partition=await eventSearchPartition(rules,eventId,input);
   const preparedKey=partition+':prepared';
   const failures=[],rows=[],challengeRows=[],charts=new Map();
   const candidateCache=new Map(await store.get(preparedKey)??[]);
   let done=0,cacheHits=0,calculations=0,storedCandidates=candidateCache.size;
   const plan=planEventSearch(candidates,rules,input.draft);
   const selected=input.searchDepth==='full'?plan.full:plan.quick;
   const cycle=input.mode==='ordinary'&&input.includeChallenge;
   const total=selected.length+(cycle?challengeCandidates.length:0);
   const available=candidates.length+(cycle?challengeCandidates.length:0);
   const yieldControl=createCalculationScheduler({eco:input.eco!==false});
   const bestRows=()=>selectEventYieldRows(rows,input.goal);
   const snapshot=type=>({type,rows:bestRows(),failures,done,total,available,complete:done===available,cacheHits,calculations});
   const load=async c=>{
     if(!charts.has(c.id))charts.set(c.id,(async()=>{
       const r=await fetch(c.analysisDataUrl,{signal:AbortSignal.timeout(30000)});
       if(!r.ok)throw Error(`谱面加载失败（${r.status}）`);return r.json();
     })());
     return charts.get(c.id);
   };
   const run=async(c,mode)=>{
     try{
       self.postMessage({type:'progress',done,total,title:c.title,stage:mode==='challenge'?'比较挑战队伍与歌曲':'比较普通队伍与歌曲'});
       const stageInput=eventYieldStageInput(input,mode);
       const stagePartition=await eventSearchPartition(rules,eventId,stageInput);
       const chart=await load(c),scoreKey=stagePartition+':'+mode+':'+await searchDigest({chart});
       const scoreCache=new Map(await store.get(scoreKey)??[]);
       const found=[];let newScores=0;
       for(const goal of eventYieldGoals(input.goal,mode)){
         let reportedAt=0,reportedStage='';
         self.postMessage({type:'progress',done,total,title:c.title,stage:`${mode==='challenge'?'挑战':'普通'} · ${EVENT_YIELD_GOAL_LABELS[goal]}`});
         const result=await optimizeEventYield({rules,eventId,...stageInput,candidate:c,chart,challengeRows,candidateCache,scoreCache,yieldControl,
           includeChallenge:mode==='ordinary'&&input.includeChallenge,goal,onProgress:p=>{
             if(!p.stage)return;
             const now=Date.now();if(p.stage===reportedStage&&now-reportedAt<120&&p.completed!==p.total)return;
             reportedAt=now;reportedStage=p.stage;
             self.postMessage({type:'progress',done,total,title:c.title,stage:`${mode==='challenge'?'挑战':'普通'} · ${EVENT_YIELD_GOAL_LABELS[goal]}`,detail:`${p.stage} ${p.completed} / ${p.total??'…'}`});
           }});
         cacheHits+=result.practical.scoreCacheHits;calculations+=result.practical.scoreCalculations;newScores+=result.practical.scoreCalculations;
         found.push(...result.results.map(row=>({...row,recommendationGoals:[goal]})));
       }
       if(newScores)await store.put(scoreKey,[...scoreCache]);
       const prepared=[...candidateCache].filter(([key])=>!key.startsWith('power:'));
       if(prepared.length!==storedCandidates){await store.put(preparedKey,prepared);storedCandidates=prepared.length;}
       return found;
     }catch(error){failures.push({id:c.id,mode,title:c.title,message:error.message});return [];}
     finally{done++;}
   };
   if(cycle){
     for(const c of challengeCandidates)challengeRows.push(...await run(c,'challenge'));
     if(!challengeRows.length)throw Error('后续挑战全部计算失败，无法可靠比较总收益。请查看谱面条件或改为仅比较普通阶段。');
   }
   for(const c of selected){
     rows.push(...await run(c,input.mode));
     const retained=selectEventYieldRows(rows,input.goal,30);rows.splice(0,rows.length,...retained);
     self.postMessage(snapshot('partial'));
   }
   self.postMessage(snapshot('result'));
 }catch(error){self.postMessage({type:'error',message:error.message});}
});
