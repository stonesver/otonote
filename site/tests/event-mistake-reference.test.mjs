import test from 'node:test';
import assert from 'node:assert/strict';
import {eventYieldOracleFixture} from './helpers/event-yield-oracle-fixture.mjs';
import {calculateEventMistakeReference} from '../src/lib/event-mistake-reference.mjs';
import {createPerformanceTemplate,createPerformanceSongCalculator} from '../src/lib/scoring-rules/formal-performance-replay.mjs';
import {createEventEfficiency} from '../src/lib/scoring-rules/event-efficiency.mjs';

function fixture(challenge=false){
 const f=eventYieldOracleFixture(),order=[2,4,0,1,3];
 const model=createEventEfficiency({tables:f.rules.tables,sourceReleaseId:f.rules.sourceReleaseId,eventId:1});
 const eventAdapters=challenge?[model.challengeAdapter(f.rules)]:[];
 if(challenge)f.draft.modifiers.event={id:1,sourceReleaseId:f.rules.sourceReleaseId};
 const performance=createPerformanceTemplate(f.rules,f.chart);performance.skillOrder=order;
 const score=createPerformanceSongCalculator(f.rules,f.chart,{performance,eventAdapters}).calculate(f.draft);
 f.rules.tables.LiveScoreRank.find(r=>r._liveScoreRank===7)._requiredScore=Math.floor(score.minimumScore*.9);
 return {...f,options:{order,targetRank:7,eventAdapters},score};
}
test('ordinary and challenge references replay checked examples with their own event context',()=>{
 for(const challenge of [false,true]){
  const f=fixture(challenge),before=structuredClone(f.draft),progress=[];
  const result=calculateEventMistakeReference(f.rules,f.chart,f.draft,{...f.options,onProgress:p=>progress.push(p)});
  assert.equal(result.baselineScore,f.score.minimumScore);assert.deepEqual(result.skillOrder,f.options.order);
  assert.equal(result.patternCount,12);assert.deepEqual(progress.at(-1),{completed:24,total:24});
  for(const group of result.results)for(const sample of group.samples){
   assert.ok(sample.passed.score>=result.threshold&&sample.passed.lowestLife>0);
   assert.ok(sample.passed.count<=sample.passed.inputCount,'counts reflect converted judgements');
   if(sample.failed)assert.ok(sample.failed.score<result.threshold||sample.failed.lowestLife<=0);
  }
  assert.deepEqual(f.draft,before);
  assert.deepEqual(calculateEventMistakeReference(f.rules,f.chart,f.draft,f.options),result);
 }
});
test('an unmet target and the lowest reward grade do not claim a tolerance budget',()=>{
 const f=fixture();f.rules.tables.LiveScoreRank.find(r=>r._liveScoreRank===7)._requiredScore=f.score.minimumScore+1;
 assert.equal(calculateEventMistakeReference(f.rules,f.chart,f.draft,f.options).status,'below_target');
 assert.equal(calculateEventMistakeReference(f.rules,f.chart,f.draft,{...f.options,targetRank:2}).status,'lowest_grade');
});
test('life depletion fails a MISS example even when the resulting score meets the grade',()=>{
 const f=fixture();
 for(const support of f.rules.tables.SupportCard)support._supportSkillId01=support._supportSkillId02=0;
 for(const effect of f.rules.tables.LiveSkillEffect)effect._effectValue=0;
 f.rules.tables.LiveScoreRank.find(r=>r._liveScoreRank===7)._requiredScore=1;
 const result=calculateEventMistakeReference(f.rules,f.chart,f.draft,f.options);
 assert.ok(result.results.find(r=>r.judgement===1).samples.some(s=>s.failed?.lowestLife===0&&s.failed.score>=result.threshold));
});
