import {createPerformanceTemplate,createPerformanceSongCalculator} from './scoring-rules/formal-performance-replay.mjs';
import {createScoringRandom} from '../../../packages/scoring/scoring-rules/gekisou-luck.mjs';

// Player-operated judgements, matching the AP input model. Automatic hold and
// trace ticks stay PERFECT; a broken hold's cascading misses are not modeled.
const manualTypes=new Set([1,20,40,41,42,101,102]);
function placements(notes){
 const layouts=[];
 for(let i=0;i<6;i++){
  const shuffled=[...notes],random=createScoringRandom(20261109+i*1009);
  for(let j=shuffled.length-1;j>0;j--){const k=Math.floor(random()*(j+1));[shuffled[j],shuffled[k]]=[shuffled[k],shuffled[j]];}
  layouts.push(shuffled);
 }
 for(let i=0;i<6;i++){const start=Math.floor(notes.length*i/6);layouts.push([...notes.slice(start),...notes.slice(0,start)]);}
 return layouts;
}

/** Bounded reference samples, not a worst-case guarantee or a probability.
 * Retain the AP-lowest skill order and vary both scattered and clustered
 * mistakes. Every reported count/score is actually replayed, including skills,
 * judgement conversion, combo resets and life. Counts are final judgements. */
export function calculateEventMistakeReference(rules,chart,draft,{order,targetRank,eventAdapters=[],onProgress=()=>{}}){
 const music=rules.tables.LiveMusic.find(m=>`music-${m._id}`===draft.selectedSongId);
 const threshold=rules.tables.LiveScoreRank.find(r=>r._group===music._liveScoreRankGroup&&r._liveScoreRank===targetRank)._requiredScore;
 const template=createPerformanceTemplate(rules,chart);template.skillOrder=[...order];
 const calculator=createPerformanceSongCalculator(rules,chart,{performance:template,eventAdapters});
 const baseline=calculator.calculate(draft),base={threshold,baselineScore:baseline.minimumScore,skillOrder:[...order]};
 if(targetRank===2)return {...base,status:'lowest_grade'};
 if(baseline.minimumScore<threshold)return {...base,status:'below_target'};
 const notes=calculator.timeline.events.filter(e=>e.kind==='authored'&&manualTypes.has(e.type)).map(e=>e.scoreIndex),layouts=placements(notes);
 const results=[];let completed=0;
 for(const judgement of [4,1]){
  const samples=layouts.map(layout=>{
   const evaluate=count=>{
    const changed=new Set(layout.slice(0,count));
    const performance={...template,judgements:template.judgements.map(n=>changed.has(n.scoreIndex)?{...n,judgement}:n)};
    const score=calculator.withPerformance(performance).calculate(draft);
    return {inputCount:count,count:score.performance.judgementCounts[judgement],score:score.minimumScore,lowestLife:score.performance.lowestLife,
     passed:score.minimumScore>=threshold&&score.performance.lowestLife>0};
   };
   let passed={inputCount:0,count:0,score:baseline.minimumScore,lowestLife:baseline.performance.lowestLife,passed:true},failed=null,one=null;
   // Probe geometrically, then refine this observed crossing. Skill effects
   // can be non-monotone: these are checked examples, not maximal tolerances.
   for(let n=1;n<=notes.length;n=Math.min(notes.length,n*2)){
    const trial=evaluate(n);if(n===1)one=trial;
    if(!trial.passed){failed=trial;break;}passed=trial;if(n===notes.length)break;
   }
   while(failed&&failed.inputCount-passed.inputCount>1){
    const trial=evaluate(Math.floor((passed.inputCount+failed.inputCount)/2));
    if(trial.passed)passed=trial;else failed=trial;
   }
   onProgress({completed:++completed,total:layouts.length*2});
   return {passed,failed,one};
  });
  const counts=samples.map(s=>s.passed.count);
  results.push({judgement,passingRange:[Math.min(...counts),Math.max(...counts)],oneCanFail:samples.some(s=>s.one&&!s.one.passed),
   allInputsPassed:samples.every(s=>!s.failed),samples});
 }
 return {...base,status:'estimated',eligibleNotes:notes.length,patternCount:layouts.length,results};
}
