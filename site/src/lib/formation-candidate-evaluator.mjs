import {createFormationCalculator} from './scoring-rules/formation-power.mjs';
import {createFormalSongCalculator} from './scoring-rules/formal-song-score.mjs';
import {createGekisouSongCalculator} from './scoring-rules/gekisou-song-score.mjs';
import {gekisouPlacements} from './scoring-rules/formation-placements.mjs';
import {createScenarioSongCalculator} from '../../../packages/scoring/scoring-rules/performance-scenario-calculator.mjs';
const metrics = {expected_song_score:'expectedScore',minimum_song_score:'minimumScore',maximum_song_score:'maximumScore'};

/** One context per worker. Master indexes and chart reconstruction are reused. */
export function createCandidateEvaluator({rules,chart,mode='ordinary',objective='formation_power',gekisouScenario,performanceScenario,scorePrecision='full',eventAdapters=[]}, existing={}) {
  const calculator = existing.calculator ?? createFormationCalculator(rules,{eventAdapters});
  const song = existing.song ?? (metrics[objective] ? performanceScenario
    ? createScenarioSongCalculator(rules,chart,{mode,performanceScenario,scenario:gekisouScenario,scorePrecision,eventAdapters}) : mode==='gekisou'
    ? createGekisouSongCalculator(rules,chart,{scenario:gekisouScenario,scorePrecision,eventAdapters}) : createFormalSongCalculator(rules,chart,{scorePrecision,eventAdapters}) : null);
  function score(candidate) {
    const power=calculator.calculate(candidate), result=song?.calculate(candidate);
    return {power:power.total.total,value:result ? result[metrics[objective]] : power.total.total,breakdown:power.breakdown,
      ...(result ? {scorePrecision:result.scorePrecision,orderCount:result.orderCount,expectedScore:result.expectedScore,minimumScore:result.minimumScore,maximumScore:result.maximumScore,
        scoreDistribution:result.scoreDistribution,inputHash:result.inputHash,performanceScenario:result.performanceScenario??performanceScenario,
        performanceSummary:result.performanceSummary,warnings:result.warnings,scenario:result.scenario,
        ...(mode==='gekisou' ? {sections:result.sections?.map(section=>({...section,taskEventCount:song.timeline?.events?.filter(event=>event.timeMs>=section.startMs&&event.timeMs<=section.endMs).length})),rankingBonus:result.rankingBonus,rankingBonusShare:result.rankingBonusShare,
          standardError:result.standardError,sampleCount:result.sampleCount,randomSampling:result.randomSampling,
          scenario:result.scenario,verificationStatus:result.verificationStatus} : {skillScoreGain:result.skillScoreGain})} : {})};
  }
  async function evaluate(candidate,{signal,yieldControl=async()=>{},onProgress}={}) {
    const placements=mode==='gekisou' && song ? gekisouPlacements(candidate) : [candidate];
    let best;
    for (const [i,draft] of placements.entries()) {
      if(signal?.aborted) return null;
      const value=score(draft);
      if(!best || value.value>best.value) best={...value,draft};
      onProgress?.({phase:'placements',completed:i+1,total:placements.length});
      await yieldControl();
    }
    return signal?.aborted ? null : best;
  }
  return {score,evaluate};
}
