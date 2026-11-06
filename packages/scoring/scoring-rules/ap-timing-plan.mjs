import { createFormalSongCalculator, prepareFormalChart } from './formal-song-score.mjs';
import { createFormalSkillResolver } from './formal-skills.mjs';
import { createPerformanceSongCalculator } from './formal-performance-replay.mjs';
import { createFrameClock } from './formal-frame-clock.mjs';
import { formalJudgementType } from './formal-judgement.mjs';
import { skillOrdersFor } from './skill-order-sampling.mjs';
import { stableSnapshotHash } from '../scoring-engine.mjs';

export const AP_TIMING_PLAN_VERSION = 'ap-timing-plan-v2';
const timingVersion = 'ournotes-performance-timing-v1';
const frameRates = [60, 120];
const toleranceMs = 5;
const policies = [0,-20,-25,-30,-40,20];
const identity = order => order.join(',');
const better = (a, b) => b.minimum - a.minimum || b.margin - a.margin || a.adjustments.length - b.adjustments.length;

/** These are uniform reference clocks, not a recording or a device guarantee.
 * 60/120 Hz timestamps have three fractional residues. Midpoints cover all
 * integer timestamp alignments; zero is retained as the published reference. */
export function apTimingClocks(frameRate) {
  return [0, ...Array.from({ length: frameRate === 60 ? 50 : 25 }, (_, i) => (i + .5) / 3)];
}

export function apTimingPerformance(timeline, plan, { frameRate = 60, phaseMs = 0, biasMs = 0 } = {}) {
  const offsets = new Map(plan.adjustments.map(row => [row.scoreIndex, row.timingOffsetMs + biasMs]));
  const clock = createFrameClock({ frameRate, phaseMs });
  return { version: timingVersion, chartId: timeline.chartId, chartHash: timeline.chartHash,
    frameRate, framePhaseMs: phaseMs, skillOrder: [...plan.order],
    judgements: timeline.events.map(({ scoreIndex, timeMs }) => {
      const timingOffsetMs = offsets.get(scoreIndex) ?? 0;
      return { scoreIndex, timeMs, timingOffsetMs, missed: false, inputFrame: clock.indexAt(timeMs + timingOffsetMs) };
    }) };
}

/** Bounded policy/order search. Exact replay determines every compared score;
 * no claim of global optimality over teams or independent per-key timings. */
export function createApTimingCalculator(rules, chart, { scorePrecision = 'full', eventAdapters = [] } = {}) {
  const timeline = prepareFormalChart(rules, { ...chart, sourceReleaseId: chart.sourceReleaseId ?? rules.sourceReleaseId });
  const ideal = createFormalSongCalculator(rules, chart, { scorePrecision, eventAdapters });
  const resolve = createFormalSkillResolver(rules);
  const rulesHash = stableSnapshotHash(rules);
  const engine = createPerformanceSongCalculator(rules, chart, {
    eventAdapters, performance: apTimingPerformance(timeline, { order: [0,1,2,3,4], adjustments: [] }) });
  const manual = timeline.events.filter(event => [1,20,40].includes(event.type) && event.kind === 'authored');
  const sources = new Map(chart.notes.map(note => [note.id,note]));
  const windowFor = event => rules.tables.LiveJudgementTiming.find(row => row._assistLevel === 0 && row._noteSimulateJudgement === 5
    && row._noteJudgementType === formalJudgementType(event.type, event.critical));
  const adjustmentFor = (event, offset) => {
    const window=windowFor(event),source=sources.get(event.noteId),node=source?.nodes?.[event.nodeIndex??0]??source;
    const next=event.type===20?timeline.events.find(n=>n.noteId===event.noteId&&n.timeMs>event.timeMs):null;
    const margin=Math.min(window._beforeMs+offset,window._afterMs-offset,event.timeMs+offset,next?next.timeMs-event.timeMs-offset-1:Infinity);
    return {scoreIndex:event.scoreIndex,noteId:event.noteId,nodeIndex:event.nodeIndex??null,timeMs:event.timeMs,
      position:node?.position??0,size:node?.size??1,timingOffsetMs:offset,apEarlyMs:window._beforeMs,apLateMs:window._afterMs,apMarginMs:margin};
  };
  function calculate(draft, { includeTrace = false } = {}) {
    const regular = ideal.calculate(draft);
    const skills = resolve(draft);
    const cumulative = skills.flatMap((skill, slot) => skill.liveEffects.filter(effect => effect.active && effect.cumulative).map(effect => ({ slot, effect })));
    const context = stableSnapshotHash({ version: AP_TIMING_PLAN_VERSION, search: 'cumulative-timing-benefit-v1', rulesHash, chartHash: timeline.chartHash,
      power: regular.power, skills, event: draft.modifiers?.event ?? null });
    const saved = draft.modifiers?.apTimingPlan;
    let plan;
    const run = (candidate, condition, trace = false) => engine.withPerformance(apTimingPerformance(timeline, candidate, condition))
      .calculate(draft, { includeTrace: trace });
    const minimum = (candidate, conditions) => Math.min(...conditions.map(condition => run(candidate, condition).expectedScore));
    const quickConditions = frameRates.flatMap(frameRate => [0,1].flatMap(phaseMs => [-toleranceMs,0,toleranceMs].map(biasMs => ({ frameRate, phaseMs, biasMs }))));
    const assess = candidate => {
      const rates=frameRates.map(frameRate => {
        const outcomes=apTimingClocks(frameRate).flatMap(phaseMs=>[-toleranceMs,0,toleranceMs].map(biasMs=>{
          const condition={frameRate,phaseMs,biasMs};return {...condition,score:run(candidate,condition).expectedScore};
        }));
        const nominal=outcomes.filter(row=>row.biasMs===0),favorable=nominal.reduce((a,b)=>b.score>a.score?b:a);
        const ranked=[...outcomes].sort((a,b)=>a.score-b.score||Math.abs(a.biasMs)-Math.abs(b.biasMs)||a.phaseMs-b.phaseMs);
        const lowest=ranked[0],highest=[...outcomes].sort((a,b)=>b.score-a.score||Math.abs(a.biasMs)-Math.abs(b.biasMs)||a.phaseMs-b.phaseMs)[0];
        return {frameRate,referenceScore:nominal[0].score,minimumScore:lowest.score,maximumScore:highest.score,
          minimumCondition:{phaseMs:lowest.phaseMs,biasMs:lowest.biasMs},maximumCondition:{phaseMs:highest.phaseMs,biasMs:highest.biasMs},
          baselineScore:run({...candidate,adjustments:[]},{frameRate}).expectedScore,favorable:{phaseMs:favorable.phaseMs,score:favorable.score}};
      });
      return {rates,minimum:Math.min(...rates.map(row=>row.minimumScore))};
    };
    if (scorePrecision !== 'screen' && saved?.version === AP_TIMING_PLAN_VERSION && saved.context === context) {
      // Stored scores are derived data. Rebuild operations and rescore them.
      const seen=new Set();
      const adjustments=saved.adjustments.map(row=>{
        const event=manual.find(n=>n.scoreIndex===row.scoreIndex);
        if(!event||seen.has(row.scoreIndex)||!Number.isSafeInteger(row.timingOffsetMs))throw Error('保存的微操音符无效');
        seen.add(row.scoreIndex);const adjustment=adjustmentFor(event,row.timingOffsetMs);
        if(adjustment.apMarginMs<toleranceMs)throw Error('保存的微操超出 AP 操作余量');return adjustment;
      });
      plan={...structuredClone(saved),adjustments,toleranceMs,chartId:timeline.chartId,chartHash:timeline.chartHash};
      const checked=assess(plan);plan.rates=checked.rates;plan.score=checked.minimum;
      plan.apMarginMs=adjustments.length?Math.min(...adjustments.map(row=>row.apMarginMs)):50;
      plan.search={screenedOrders:0,refinedOrders:1,policies:[],phaseClasses:77,...plan.search,optimality:'candidate_search'};
    } else {
      const empty = order => ({ order, adjustments: [], margin: 50 });
      let candidates;
      // Fixed boosts retain chart-time coverage. Native float32 rollback can
      // alter rounding, but that alone does not warrant an input guide.
      // The independent AP window solver still retains those exact differences.
      if (!cumulative.length) candidates = [empty(regular.bestOrder)];
      else {
        // Every sampled order gets timing policies before any order is cut.
        // Full scoring checks all 120 orders; screening uses 10 balanced orders.
        const selected = [...new Map([regular.bestOrder,...skillOrdersFor(scorePrecision)].map(order=>[identity(order),order])).values()];
        candidates = selected.flatMap(order => {
          const windows = cumulative.map(({ slot, effect }) => ({ start: timeline.skillTimes[order.indexOf(slot)], duration: effect.durationMs }));
          const adjustable = manual.filter(event => windows.some(w => event.timeMs > w.start + 50 && event.timeMs < w.start + w.duration));
          return policies.map(offset => {
            const adjustments = offset === 0 ? [] : adjustable
              .flatMap(event => {
                const adjustment=adjustmentFor(event,offset);
                return adjustment.apMarginMs<toleranceMs?[]:[adjustment];
              });
            return { order, adjustments, margin: adjustments.length ? Math.min(...adjustments.map(row => row.apMarginMs)) : 50 };
          });
        });
      }
      const screenConditions=frameRates.flatMap(frameRate=>[0,1].map(phaseMs=>({frameRate,phaseMs,biasMs:0})));
      for (const candidate of candidates) candidate.minimum = minimum(candidate, screenConditions);
      candidates.sort(better);
      if(scorePrecision==='screen'){
        const best=candidates[0];
        return {...regular,expectedScore:best.minimum,minimumScore:best.minimum,maximumScore:best.minimum,
          bestOrder:best.order,scoreDistribution:undefined,performanceScenario:{profile:'ap_timing'},
          apTimingScreen:{score:best.minimum,onTimeScore:Math.max(...candidates.filter(c=>!c.adjustments.length).map(c=>c.minimum)),
            order:best.order,adjustments:best.adjustments,orders:new Set(candidates.map(c=>identity(c.order))).size},
          scorePrecision:'screen'};
      }
      // Prune unnecessary operations against both rates and timing perturbations.
      // The final comparison below rechecks complete uniform phase classes.
      const shortlist = candidates.slice(0,6);
      for(const candidate of shortlist)candidate.minimum=minimum(candidate,quickConditions);
      shortlist.sort(better);shortlist.splice(3);
      const onTime = candidates.find(candidate=>candidate.adjustments.length===0);
      if(onTime&&!shortlist.includes(onTime))shortlist.push(onTime);
      for (const candidate of shortlist) {
        for (const adjustment of [...candidate.adjustments]) {
          const reduced = { ...candidate, adjustments: candidate.adjustments.filter(row => row !== adjustment) };
          const value = minimum(reduced, quickConditions);
          if (value >= candidate.minimum) { candidate.adjustments = reduced.adjustments; candidate.minimum = value; }
        }
        candidate.margin = candidate.adjustments.length ? Math.min(...candidate.adjustments.map(row => row.apMarginMs)) : 50;
        Object.assign(candidate,assess(candidate));
      }
      shortlist.sort(better);
      const best = shortlist[0];
      plan = { version: AP_TIMING_PLAN_VERSION, context, chartId: timeline.chartId, chartHash: timeline.chartHash,
        order: best.order, adjustments: best.adjustments, score: best.minimum, apMarginMs: best.margin, toleranceMs,
        rates: best.rates, search: { screenedOrders: new Set(candidates.map(c => identity(c.order))).size, refinedOrders: new Set(candidates.map(c => identity(c.order))).size,
          policies: cumulative.length ? policies : [0], phaseClasses: 77, optimality: 'candidate_search' } };
    }
    // Saved inputs are rescored too: an offset alone is not evidence of a gain.
    // Compare the same order across the same clocks, retaining robustness gains.
    if(plan.adjustments.length){
      const onTime=assess({...plan,adjustments:[]});
      plan.onTimeMinimumScore=onTime.minimum;
      if(!cumulative.length||plan.score<=onTime.minimum){
        plan={...plan,adjustments:[],apMarginMs:50,score:onTime.minimum,rates:onTime.rates};
      }
    }else plan.onTimeMinimumScore=plan.score;
    plan.minimumScore=plan.score;
    plan.maximumScore=Math.max(...plan.rates.map(rate=>rate.maximumScore));
    const reference = run(plan, { frameRate: 60 }, includeTrace);
    const result = { ...reference, expectedScore: plan.score, minimumScore: plan.minimumScore, maximumScore: plan.maximumScore,
      scoreDistribution: undefined, scorePrecision: 'ap_timing', orderCount: plan.search.refinedOrders,
      apTimingPlan: plan, performanceScenario: { profile: 'ap_timing' },
      performanceSummary: plan.adjustments.length ? '60／120 帧共用 AP 操作；按已检查时钟与统一 -5／0／+5 毫秒偏移中的较低分比较。' : '固定技能顺序的正拍 AP 估分。',
      warnings: [...reference.warnings, ...(plan.adjustments.length ? ['微操是有限候选搜索，未证明全局最高分；时钟与统一偏移情景不代表设备实测或逐键独立误差的保底。'] : [])] };
    if (includeTrace) {
      const variants = plan.rates.flatMap(rate => [
        { frameRate: rate.frameRate, phaseMs: 0, kind: 'reference' },
        ...(rate.favorable.score > rate.referenceScore ? [{ frameRate: rate.frameRate, phaseMs: rate.favorable.phaseMs, kind: 'alignment' }] : [])
      ]).map(condition => {
        const replay = run(plan, condition, true);
        return { ...replay.skillPlayback.variants[0], kind: 'explicit', timingCondition: condition };
      });
      result.skillPlayback = { ...reference.skillPlayback, variants };
    }
    return result;
  }
  return { calculate, timeline };
}
