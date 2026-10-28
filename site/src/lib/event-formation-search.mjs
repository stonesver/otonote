import { resolveSearchInput } from './scoring-rules/formation-input.mjs';
import { createFormalSongCalculator } from './scoring-rules/formal-song-score.mjs';
import { createFormalSkillResolver } from './scoring-rules/formal-skills.mjs';
import { maximumPairing, partitionPairing } from './scoring-rules/maximum-pairing.mjs';
import { SearchQueue } from './scoring-rules/search-queue.mjs';
import { compilePairingModels, draftFromPairing, compareScoredFormations } from './inventory-optimizer.mjs';
import { createCandidateEvaluator } from './formation-candidate-evaluator.mjs';
import { createOrdinaryScoreBound } from '../../../packages/scoring/scoring-rules/ordinary-score-bound.mjs';

/** Complete legal pairing partitions with independently bounded score/bonuses.
 * The budget limits work, never the candidate library. A sampled player scenario
 * keeps its existing practical path until a corresponding bound is available. */
export async function searchEventFormations({ rules, draft, chart, scope, inventory, eventAdapters = [],
  objective = 'expected_song_score', boundMetric, seeds = [], bonusFor, upperCandidate, transformScore = r => r,
  compareCandidates = (a,b) => b.value-a.value, rankCandidates = compareCandidates, maxEvaluations = 24, topN = 3,
  signal, yieldControl = async () => {}, onProgress = () => {}, scoreCache,
  pairCache, pairCacheKey, modelCache, scoreCounters, baselineResult, bonusCeiling, scoreBoundOptions = {}, proofCount = topN, includeTieScoreBound = true,
  shouldPause = () => false, onContinuation, partitionCards = false }) {
  if (!Number.isInteger(maxEvaluations) || maxEvaluations < 0) throw new Error('Invalid event search budget');
  if (!Number.isInteger(topN) || topN < 1 || topN > 100) throw new Error('Invalid event result limit');
  if (!Number.isInteger(proofCount) || proofCount < 1 || proofCount > topN) throw new Error('Invalid event proof count');
  if (draft.modifiers?.performanceScenario) return { results: seeds, optimality: 'practical_checked',
    searchStatus: 'player_scenario_bound_unavailable', evaluated: 0, upperBound: null, optimalityGap: null };
  const input = resolveSearchInput(rules, draft, { scope, inventory });
  const cardDomains = partitionCards && !bonusFor;
  const characterFor = cardDomains ? new Map(rules.tables.MemberCard.map(row=>[`member-card-${row._id}`,row._characterID])) : null;
  const models = await compilePairingModels(rules, input, { eventAdapters, signal, yieldControl, pairCache, pairCacheKey, modelCache });
  if (!models) return { results: seeds, optimality: 'incomplete', searchStatus: 'cancelled', evaluated: 0 };
  const song = createFormalSongCalculator(rules, chart, { eventAdapters });
  const evaluator = createCandidateEvaluator({ rules, chart, objective, eventAdapters }, { song });
  const resolver = createFormalSkillResolver(rules), pairSkills = new Map(), maxima = [];
  for (const memberCardId of input.inventory.memberCardIds) {
    let max = 0;
    for (const supportCardId of input.inventory.supportCardIds) {
      const skill = resolver({ slots: [{ memberCardId, supportCardId }], modifiers: input.draft.modifiers })[0];
      pairSkills.set(`${memberCardId}|${supportCardId}`, skill);
      max = Math.max(max, skill.liveEffects.filter(e=>e.active).reduce((n,e)=>n+Math.abs(Math.fround(Math.floor(Math.fround(e.rate*100000))/100000)),0));
    }
    maxima.push(max); await yieldControl();
    if (signal?.aborted) return { results: seeds, optimality: 'incomplete', searchStatus: 'cancelled', evaluated: 0 };
  }
  const metric = boundMetric ?? { expected_song_score:'expectedScore', maximum_song_score:'maximumScore', minimum_song_score:'minimumScore' }[objective];
  if (!['expectedScore','minimumScore','maximumScore'].includes(metric)) throw new Error('Invalid event score objective');
  const scoreBound = createOrdinaryScoreBound({ ...scoreBoundOptions, song, pairSkills, legacyFactor: Math.fround((1+2*maxima.sort((a,b)=>b-a).slice(0,5).reduce((a,b)=>a+b,0))*1.0001), input, metric });
  // Event grade may use minimumScore, but its final tie-break uses expectedScore.
  const tieBound = bonusFor && includeTieScoreBound && metric !== 'expectedScore'
    ? createOrdinaryScoreBound({ song, pairSkills, legacyFactor: Math.fround((1+2*maxima.slice(0,5).reduce((a,b)=>a+b,0))*1.0001), input, metric: 'expectedScore' })
    : scoreBound;
  const rootHints = new Map();
  // One global bonus ceiling can certify the retained reward tuples after
  // bounding reachable grades. Avoid two bonus flows per leader (and their
  // large edge matrices) when no further reward improvement is possible.
  if (bonusCeiling && seeds.length >= proofCount) {
    for (const model of models) {
      const state={leader:model.leader,required:[],forbidden:[]};
      const power=maximumPairing({edges:model.edges,requiredMembers:[model.leader]});
      if(power)rootHints.set(model.leader,{power,
        scoreUpper:scoreBound(state,model,power,()=>draftFromPairing(input,model.leader,power.edges))});
      await yieldControl();
      if(signal?.aborted)return {results:seeds,optimality:'incomplete',searchStatus:'cancelled',evaluated:0};
    }
    const upper=upperCandidate({...bonusCeiling,scoreUpper:Math.max(...[...rootHints.values()].map(r=>r.scoreUpper)),tieScoreUpper:Number.MAX_VALUE});
    const retained=[...seeds].sort(rankCandidates).slice(0,topN);
    if(compareCandidates(upper,retained[proofCount-1])>=0)return {results:retained,evaluated:0,expanded:0,candidateBoundPruned:0,
      fullScoreCalculations:0,scoreCacheHits:0,
      boundScoreCalculations:scoreBound.stats.fullScoreCalculations+(tieBound===scoreBound?0:tieBound.stats.fullScoreCalculations),
      proofTarget:proofCount===1?'best':'top_n',certifiedCount:proofCount,
      optimality:'proven_within_model',searchStatus:'completed',upperBound:upper.value,optimalityGap:0,
      upperCandidate:{value:upper.value,total:upper.total,scoreRank:upper.reward.scoreRank},
      bestProven:true,topNComplete:proofCount===topN,frontier:0,proof:'reachable_grade_and_bonus_ceiling'};
  }
  const byLeader = new Map(models.map(m => [m.leader, m]));
  const primary = bonusFor ? bonusFor.metric : null;
  const rootBonuses=new Map();
  if(bonusFor?.card){
    const characters=new Map(rules.tables.MemberCard.map(row=>[`member-card-${row._id}`,row._characterID]));
    const values=Object.fromEntries(['rewardBP','eventPointBP'].map(kind=>{
      const byCharacter=new Map();
      for(const id of input.inventory.memberCardIds){
        const character=characters.get(id),value=bonusFor.card('member',id)[kind];
        byCharacter.set(character,Math.max(byCharacter.get(character)??0,value));
      }
      return [kind,{byCharacter,support:input.inventory.supportCardIds.map(id=>bonusFor.card('support',id)[kind])
        .sort((a,b)=>b-a).slice(0,5).reduce((a,b)=>a+b,0)}];
    }));
    for(const {leader} of models)rootBonuses.set(leader,Object.fromEntries(Object.entries(values).map(([kind,v])=>
      [kind,bonusFor.card('member',leader)[kind]+v.support+[...v.byCharacter].filter(([c])=>c!==characters.get(leader))
        .map(([,value])=>value).sort((a,b)=>b-a).slice(0,4).reduce((a,b)=>a+b,0)])));
  }
  // Bonus is integer-valued. Lexicographic (bonus, power) matching keeps the
  // exact bonus maximum while avoiding arbitrary weak teams among its ties.
  const bonusModels = new Map();
  const bonusModel=leader=>{
    if(!bonusModels.has(leader)){
      const model=byLeader.get(leader),scale=10*Math.max(...model.edges.map(e=>Math.abs(e.weight)))+1;
      bonusModels.set(leader,Object.fromEntries(['rewardBP','eventPointBP'].map(kind=>[kind,
        e=>bonusFor.pair(e)[kind]*scale+e.weight])));
    }
    return bonusModels.get(leader);
  };
  const solveBonus=(state,kind)=>{
    const result=maximumPairing({required:state.required,forbidden:state.forbidden,requiredMembers:[state.leader],
      edges:byLeader.get(state.leader).edges,weight:bonusModel(state.leader)[kind]});
    return {...result,weight:result.edges.reduce((sum,e)=>sum+bonusFor.pair(e)[kind],0)};
  };
  // Legacy callers retain their expansion order and separate certificate heap.
  // The joint challenge relaxation uses its tighter bound for both purposes.
  const preservePriority = !bonusFor && !scoreBoundOptions.jointPowerBound;
  const solve = (state, cutoff = -Infinity) => {
    let model = byLeader.get(state.leader);
    const options = { required: state.required, forbidden: state.forbidden, requiredMembers: [state.leader] };
    if (cardDomains) {
      const members=state.memberRequired,supports=state.supportRequired;
      const characters=new Map(members.map(id=>[characterFor.get(id),id]));
      // Every required card remains compulsory in the exact power matching.
      // Other cards of its character cannot belong to any legal team here.
      model={...model,edges:model.edges.filter(e=>!state.memberExcluded.includes(e.member)&&!state.supportExcluded.includes(e.support)
        &&(!characters.has(e.character)||characters.get(e.character)===e.member)
        &&(members.length<5||members.includes(e.member))&&(supports.length<5||supports.includes(e.support)))};
      options.requiredMembers=members;options.requiredSupports=supports;
    }
    const hint=!state.required.length&&!state.forbidden.length?rootHints.get(state.leader):null;
    const power = hint?.power??maximumPairing({ ...options, edges: model.edges });
    if (!power) return null;
    if (!bonusFor) {
      const {upper,priority}=scoreBoundOptions.jointPowerBound
        ? {upper:scoreBound.withCutoff(state,model,power,()=>draftFromPairing(input,state.leader,power.edges),cutoff)}
        : scoreBound.withPriority(state,model,power,()=>draftFromPairing(input,state.leader,power.edges));
      const inherited=Math.min(upper,state.upper?.value??Infinity);
      return { ...state, solution: power, upper: { value:inherited,expectedScore:inherited },
        priorityUpper:priority==null?null:{value:priority,expectedScore:priority} };
    }
    const upperScore = hint?.scoreUpper??scoreBound(state, model, power, () => draftFromPairing(input, state.leader, power.edges));
    const root=!state.required.length&&!state.forbidden.length?rootBonuses.get(state.leader):null;
    if(root)return {...state,solution:power,needsBonusCandidate:true,
      upper:upperCandidate({...root,scoreUpper:upperScore,tieScoreUpper:tieBound===scoreBound?upperScore:
        tieBound(state,model,power,()=>draftFromPairing(input,state.leader,power.edges))})};
    const rewards = solveBonus(state,'rewardBP'), points = solveBonus(state,'eventPointBP');
    return { ...state, solution: primary === 'eventPointBP' ? points : rewards,
      upper: upperCandidate({ scoreUpper: upperScore,
        tieScoreUpper: tieBound === scoreBound ? upperScore : tieBound(state, model, power, () => draftFromPairing(input, state.leader, power.edges)),
        rewardBP: rewards.weight, eventPointBP: points.weight }) };
  };
  const compareUpper=(a,b)=>compareCandidates(a.upper,b.upper)||a.leader.localeCompare(b.leader);
  const queue = new SearchQueue([], (a,b) => compareCandidates(a.priorityUpper??a.upper,b.priorityUpper??b.upper) || a.leader.localeCompare(b.leader));
  let certificate=preservePriority?new SearchQueue([],compareUpper):null;
  const active=new Set();
  const push=state=>{queue.push(state);if(certificate){certificate.push(state);active.add(state);}};
  const remaining=()=>{
    if(!certificate)return queue.peek()?.upper;
    while(certificate.length&&!active.has(certificate.peek()))certificate.pop();
    if(certificate.length>2*active.size+128)certificate=new SearchQueue([...active],compareUpper);
    return certificate.peek()?.upper;
  };
  const clear=()=>{queue.clear();certificate?.clear();active.clear();};
  for (const model of models) {
    const state=solve({leader:model.leader,required:[],forbidden:[],...(cardDomains?{
      memberRequired:[model.leader],supportRequired:[],memberExcluded:[],supportExcluded:[]
    }:{})});
    if(state)push(state);
  }
  const signature = d => d.slots.map(s=>`${s.memberCardId}|${s.supportCardId}`).join(';');
  const results = new Map(seeds.map(r=>[signature(r.draft),r]));
  const best = () => [...results.values()].sort(rankCandidates).slice(0,topN);
  let evaluated = 0, expanded = 0, candidateBoundPruned = 0, fullScoreCalculations = 0, scoreCacheHits = 0;
  const run = async () => {
    const startedExpanded=expanded;
    while (queue.length && !signal?.aborted && !shouldPause() && (!maxEvaluations || expanded-startedExpanded < maxEvaluations)) {
      const retained = best(), worst = retained[proofCount-1];
      if (worst && compareCandidates(remaining(), worst) >= 0) { clear(); break; }
      const state = queue.pop();
      active.delete(state);
      if(worst&&compareCandidates(state.upper,worst)>=0)continue;
      if(state.needsBonusCandidate){state.solution=solveBonus(state,primary);state.needsBonusCandidate=false;}
      const candidate = draftFromPairing(input, state.leader, state.solution.edges);
      const key = 'full:' + signature(candidate);
      // A partition's bound covers many teams; its maximum-power representative
      // can be much weaker. Bound THIS complete team before paying for 120
      // native order replays. Still partition the state when it cannot win.
      const candidateUpper = !bonusFor && scoreBoundOptions.jointPowerBound && worst
        ? scoreBound.withCutoff({...state,required:state.solution.edges.map(e=>e.key)},{...models.find(m=>m.leader===state.leader),edges:state.solution.edges},state.solution,()=>candidate,worst.value)
        : Infinity;
      if (worst && candidateUpper <= worst.value) candidateBoundPruned++;
      else {
        let raw = scoreCache?.get(key);
        if (raw) { scoreCacheHits++; if(scoreCounters)scoreCounters.scoreCacheHits++; }
        else { fullScoreCalculations++; raw=evaluator.score(candidate);scoreCache?.set(key,raw);if(scoreCounters)scoreCounters.scoreCalculations++; }
        const transformed = transformScore(raw,candidate);
        const value = { ...transformed, draft:candidate, id:signature(candidate), origins:['certified-search'],
          delta:baselineResult ? transformed.value-baselineResult.value : null,
          comparison:compareScoredFormations(transformed,baselineResult) };
        if (compareCandidates(state.upper,value)>0) throw new Error('Event bound below evaluated candidate');
        results.set(signature(candidate),value); evaluated++;
        const keep = new Set(best().map(r => signature(r.draft)));
        for (const key of results.keys()) if (!keep.has(key)) results.delete(key);
      }
      expanded++;
      const cutoff=!bonusFor && scoreBoundOptions.jointPowerBound ? best()[proofCount-1]?.value??-Infinity : -Infinity;
      // Include/exclude splits are disjoint and cover the complete parent
      // domain. Resolve card sets before enumerating their support pairings:
      // one bound can then exclude many near-identical pair permutations.
      let children;
      if (cardDomains) {
        const member=state.solution.edges.find(e=>!state.memberRequired.includes(e.member))?.member;
        const support=state.solution.edges.find(e=>!state.supportRequired.includes(e.support))?.support;
        if(state.memberRequired.length<5&&member)children=[
          {...state,memberRequired:[...state.memberRequired,member]},
          {...state,memberExcluded:[...state.memberExcluded,member]}
        ];
        else if(state.supportRequired.length<5&&support)children=[
          {...state,supportRequired:[...state.supportRequired,support]},
          {...state,supportExcluded:[...state.supportExcluded,support]}
        ];
      }
      for (const child of children??partitionPairing(state,state.solution)) {
        const solved=solve(child,cutoff);
        // The incumbent cannot decrease. Discard a certified losing partition
        // now instead of retaining its edges and solution in the frontier.
        if(solved && (cutoff===-Infinity || solved.upper.value>cutoff))push(solved);
      }
      onProgress({ phase:'event-exact',completed:evaluated,expanded,frontier:queue.length,bestCandidate:best()[0] });
      await yieldControl();
    }
    const retained=best();
    if (queue.length && retained[proofCount-1] && compareCandidates(remaining(), retained[proofCount-1]) >= 0) clear();
    const complete=!queue.length;
    const upper=remaining();
    const bestRemaining=upper??retained[0];
    return { results:retained, evaluated, expanded, candidateBoundPruned, fullScoreCalculations, scoreCacheHits,
      boundScoreCalculations:scoreBound.stats.fullScoreCalculations+(tieBound===scoreBound?0:tieBound.stats.fullScoreCalculations), proofTarget:proofCount===1?'best':'top_n',
      certifiedCount:complete?Math.min(proofCount,retained.length):0,
      optimality:complete?(retained.length?'proven_within_model':'infeasible'):'incomplete',
      searchStatus:complete?(retained.length?'completed':'no_feasible_formation'):signal?.aborted?'cancelled':shouldPause()?'paused':'budget_exhausted',
      upperBound:retained.length?Math.max(upper?.value??0,retained[0].value):upper?.value??null,
      optimalityGap:retained.length?Math.max(0,(upper?.value??retained[0].value)-retained[0].value):null,
      upperCandidate:bestRemaining?{value:bestRemaining.value,expectedScore:bestRemaining.expectedScore,
        ...(bestRemaining.total?{total:bestRemaining.total,scoreRank:bestRemaining.reward.scoreRank}:{})}:null,
      bestProven:Boolean(retained.length&&(!upper||compareCandidates(upper,retained[0])>=0)),
      topNComplete:complete&&proofCount===topN,frontier:queue.length };
  };
  onContinuation?.(run);
  return run();
}
