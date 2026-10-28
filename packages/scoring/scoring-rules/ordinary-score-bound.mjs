import { createFrameClock, skillEndFrame } from './formal-frame-clock.mjs';
import { createJointPowerScoreBound } from './joint-power-score-bound.mjs';
import { createBonusConstrainedScoreBound } from './bonus-constrained-score-bound.mjs';

const unitRoundoff = 2 ** -24;
const gamma = n => n * unitRoundoff < 1 ? n * unitRoundoff / (1 - n * unitRoundoff) : Infinity;
const upward = n => Math.fround(n * (1 + 2 ** -23));

/** Each ordinary command can be reapplied only while its 40 ms bucket can
 * still receive an input. With nonnegative arrival lag <= L, a bucket ending
 * at t is immutable after t+L. There are <=2 Calculate calls per ideal frame
 * (input and skill), and one final flush. Empty-gap calls use distinct frames.
 * Below 2^20 ms scoreFrame's float32 division still equals integer ceil(t/40).
 * Unusual clocks/timestamps fall back to the chart-wide call count. */
export function ordinaryReplayApplicationLimit(timeline, profiles, frameRate = 60) {
  const clock = createFrameClock({ frameRate });
  let lag = 0;
  const include = (time, frame) => {
    const arrival = clock.at(frame).timeMs;
    if (!Number.isSafeInteger(time) || time < 0 || arrival < time || arrival >= 2 ** 20) return false;
    lag = Math.max(lag, arrival - time); return true;
  };
  for (const event of timeline.events) {
    if (event.inputFrame != null || !include(event.timeMs, clock.indexAt(event.timeMs))) return Infinity;
  }
  for (const start of timeline.skillTimes) {
    if (!include(start, clock.indexAt(start))) return Infinity;
    for (const profile of profiles) for (const effect of profile.effects) {
      const end = skillEndFrame(clock, start, effect.durationRawMs);
      if (!include(end.timeMs, end.frame)) return Infinity;
    }
  }
  return 2 * (Math.ceil((40 + lag) * frameRate / 1000) + 2) + 1;
}

/** Bound the ideal ordinary replay, including native float32 rewind residue.
 * This is not a bound for dynamic player inputs or Gekisou task rewards. */
export function createOrdinaryScoreBound({ song, pairSkills, legacyFactor, input, metric, frameRate = 60, localRewinds = true, assignmentBound = true, jointPowerBound = false, bonusConstraintBound = false }) {
  // Audit adapters before either the envelope or homogeneous-team shortcut.
  song.upperBound(0, 1, { eventContext: input.draft.modifiers?.event });
  const clock = createFrameClock({ frameRate }), profiles = new Map(), canonical = new Map(), cache = new Map();
  for (const [key, skill] of pairSkills) {
    const effects = skill.liveEffects.filter(e => e.active).map(e => ({ type: e.type,
      value: Math.fround(Math.floor(Math.fround(Math.fround(e.rate) * 100000)) / 100000),
      durationRawMs: e.durationRawMs ?? e.durationMs, dynamic: Boolean(e.cumulative) }));
    const signature = JSON.stringify(effects);
    if(!canonical.has(signature))canonical.set(signature,{signature,effects,absolute:effects.reduce((n,e)=>n+Math.abs(e.value),0)});
    profiles.set(key,canonical.get(signature));
  }
  const edgeProfiles=new WeakMap();
  const profileFor=edge=>{
    let profile=edgeProfiles.get(edge);
    if(!profile)edgeProfiles.set(edge,profile=profiles.get(edge.key));
    return profile;
  };
  const uniqueProfiles = [...canonical.values()];
  const applicationLimit = localRewinds ? ordinaryReplayApplicationLimit(song.timeline, uniqueProfiles, frameRate) : Infinity;
  const replayError = (absolute, options, limit) => {
    // A cumulative handle can be replaced once per judgement frame. Both its
    // old-value removal and new-value insertion contribute to the absolute
    // command sum; bounding command COUNT alone does not bound that sum.
    const replacements = song.timeline.events.length + 2;
    const commands = 10 * Math.max(0, ...options.map(p => p.effects.reduce((n,e) => n + (e.dynamic ? replacements : 1), 0)));
    const variation = options.some(p => p.effects.some(e => e.dynamic)) ? replacements : 1;
    const magnitude = 2 * absolute * variation;
    const calls = Math.min(limit, 4 * (song.timeline.events.length + commands + 1)), undo = commands * calls;
    const stateError = gamma(2 * undo + 1) * (1 + 2 * magnitude)
      + (1 + gamma(2 * undo + 1)) * undo * gamma(commands) * magnitude;
    return { commands, error: stateError + unitRoundoff * (1 + 2 * absolute + stateError) };
  };
  const linearCache = new Map(), events = song.timeline.events;
  const indexAt = time => {
    let lo=0, hi=events.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(events[mid].timeMs<time)lo=mid+1;else hi=mid;}
    return lo;
  };
  const spans = new Map(uniqueProfiles.map(p => [p.signature, song.timeline.skillTimes.map(start => p.effects.map(e => ({
    first:indexAt(start),last:indexAt(skillEndFrame(clock,start,e.durationRawMs).timeMs),value:Math.max(0,e.value)
  })))]));
  const jointBound = jointPowerBound ? createJointPowerScoreBound({
    coefficients:song.powerLinearUpperBound?.({eventContext:input.draft.modifiers?.event}),spans,profileFor,metric
  }) : null;
  const bonusBound=bonusConstraintBound?createBonusConstrainedScoreBound({
    coefficients:song.powerLinearUpperBound?.({eventContext:input.draft.modifiers?.event}),spans,profileFor,metric
  }):null;
  const linearFor = power => {
    if (!assignmentBound || !song.linearUpperBound || events.length>100000) return null;
    if (!linearCache.has(power)) {
      const coefficients=song.linearUpperBound(power,{eventContext:input.draft.modifiers?.event});
      if(coefficients.some(v=>!Number.isFinite(v)||v<0))return null;
      const prefix=[0];for(const value of coefficients)prefix.push(prefix.at(-1)+value);
      const total=prefix.at(-1), n=coefficients.length+1, u=2**-53;
      // Range subtraction uses two rounded prefixes. An absolute allowance
      // protects short intervals too; a relative-only allowance would not.
      const epsilon=total*2*n*u/(1-n*u);
      const gains=new Map([...spans].map(([signature,positions])=>[signature,positions.map(effects=>effects.reduce((sum,e)=>
        sum+Math.max(0,prefix[e.last]-prefix[e.first]+epsilon)*e.value,0))]));
      if(linearCache.size>=64)linearCache.delete(linearCache.keys().next().value);
      linearCache.set(power,{total:total+epsilon,gains});
    }
    return linearCache.get(power);
  };
  const assignedGain = (available, forced, leader, power) => {
    const linear=linearFor(power);if(!linear)return null;
    const compulsory=new Map(forced.map(e=>[e.character,e]));
    const leaderCharacter=available.find(e=>e.member===leader)?.character;
    const groups=new Map();
    for(const e of available){
      const fixed=compulsory.get(e.character);
      if(fixed && e.key!==fixed.key || e.character===leaderCharacter && e.member!==leader)continue;
      const signature=profileFor(e).signature;
      let group=groups.get(e.character);
      if(!group)groups.set(e.character,group={mandatory:Boolean(fixed)||e.character===leaderCharacter,values:Array(5).fill(0),mean:0,seen:new Set()});
      if(group.seen.has(signature))continue;
      group.seen.add(signature);
      const gains=linear.gains.get(signature);
      for(let i=0;i<5;i++)group.values[i]=Math.max(group.values[i],gains[i]);
      group.mean=Math.max(group.mean,gains.reduce((a,b)=>a+b,0)/5);
    }
    let gain;
    if(metric!=='maximumScore'){
      // Each member occurs in each skill position in exactly 24 of 120 orders.
      // The minimum score is also <= this mean. Support uniqueness is relaxed.
      const mandatory=[...groups.values()].filter(g=>g.mandatory),optional=[...groups.values()].filter(g=>!g.mandatory);
      gain=mandatory.reduce((sum,g)=>sum+g.mean,0)+optional.sort((a,b)=>b.mean-a.mean).slice(0,5-mandatory.length).reduce((sum,g)=>sum+g.mean,0);
    }else{
      // 32-mask assignment: each character at most once, every position once,
      // with locked pairs and the leader compulsory. This is a relaxation of
      // legal teams because supports may repeat; it never excludes a team.
      let dp=Array(32).fill(-Infinity);dp[0]=0;
      for(const group of groups.values()){
        const next=group.mandatory?Array(32).fill(-Infinity):[...dp];
        for(let mask=0;mask<32;mask++)if(Number.isFinite(dp[mask]))for(let i=0;i<5;i++)if(!(mask&(1<<i)))
          next[mask|(1<<i)]=Math.max(next[mask|(1<<i)],dp[mask]+group.values[i]);
        dp=next;
      }
      gain=dp[31];
    }
    return {total:linear.total,gain};
  };
  const remember = (key, calculate) => {
    if (!cache.has(key)) { if (cache.size >= 8192) cache.delete(cache.keys().next().value); cache.set(key, calculate()); }
    return cache.get(key);
  };
  const bound = function(state, model, solution, draftForSolution, includePriority = false, cutoff = -Infinity, minimumBonus) {
    const fixed = new Set(state.required), banned = new Set(state.forbidden);
    const forced = solution.edges.filter(e => fixed.has(e.key));
    const used = field => new Set(forced.map(e => e[field]));
    const members = used('member'), supports = used('support'), characters = used('character');
    const available = model.edges.filter(e => fixed.has(e.key) || !banned.has(e.key)
      && !members.has(e.member) && !supports.has(e.support) && !characters.has(e.character));
    const types = new Map(available.map(e => { const p = profileFor(e); return [p.signature, p]; }));
    // All legal teams in this subspace have exactly the same command stream at
    // a given power. Positive native multiplications/floors are monotone in
    // power; the maximum-power feasible team therefore supplies an exact bound.
    if (!model.powerIsUpperBound && types.size === 1 && [...types.values()][0].effects.every(e => e.value >= 0 && !e.dynamic)) {
      const key = `exact:${[...types.keys()][0]}:${solution.weight}`;
      const value=remember(key, () => { bound.stats.fullScoreCalculations++; return song.calculate(draftForSolution())[metric]; });
      return includePriority?{upper:value,priority:value}:value;
    }
    const maxima = new Map();
    let fixedAbsolute = 0, leaderBest = -Infinity, leaderCharacter;
    for (const e of available) {
      const p = profileFor(e);
      if (fixed.has(e.key)) fixedAbsolute += p.absolute;
      else maxima.set(e.character, Math.max(maxima.get(e.character) ?? 0, p.absolute));
      if (e.member === state.leader) { leaderBest = Math.max(leaderBest, p.absolute); leaderCharacter = e.character; }
    }
    let remaining = 5 - forced.length;
    if (!members.has(state.leader)) { fixedAbsolute += leaderBest; remaining--; maxima.delete(leaderCharacter); }
    const absolute = fixedAbsolute + [...maxima.values()].sort((a,b) => b-a).slice(0,remaining).reduce((a,b) => a+b,0);
    const factor = Math.min(legacyFactor, upward((1 + 2 * absolute) * 1.0001));
    const signatures = [...types.keys()].sort(), envelopeKey = JSON.stringify([absolute, signatures]);
    const options = [...types.values()];
    const active = () => remember(`active:${JSON.stringify(signatures)}`, () => {
      const intervals = song.timeline.skillTimes.map(start => options.map(p => p.effects.map(e => ({
        start, end: skillEndFrame(clock, start, e.durationRawMs).timeMs, value: e.value
      }))));
      return Float64Array.from(song.timeline.events,event=>intervals.reduce((sum,choices)=>sum+Math.max(0,...choices.map(effects=>effects.reduce((n,e)=>
        n+(e.start<=event.timeMs&&event.timeMs<e.end?Math.max(0,e.value):0),0))),0));
    });
    const getEnvelope=(prefix,limit)=>remember(`${prefix}envelope:${envelopeKey}`, () => {
      // replayScoreTimeline makes at most four Calculate calls per arrival
      // (input/skill and both gap boundaries), plus the final flush. Each call
      // applies at most C commands and undoes at most C nonempty factor buckets.
      // Delta accumulation has at most C additions before every undo. Bound
      // both errors without assuming start/end cancellation is exact.
      const { error } = replayError(absolute, options, limit);
      if (!Number.isFinite(error)) return null;
      // The old 1+2*A bound is safe only while its extra A also dominates
      // accumulated rewind error. Huge future charts must keep the wider bound.
      const safeFactor = error <= absolute ? factor : Infinity;
      // The joint relaxation only needs error. Delay the per-note envelope
      // until a cheaper safe bound has failed to prune this partition.
      let factors;
      return {get factors(){return factors??=active().map(value=>Math.min(safeFactor,upward(1+value+error)));},error};
    });
    const envelope=getEnvelope('',applicationLimit);
    const timedBound=(prefix,envelope)=>envelope===null?Infinity:remember(`${prefix}score:${envelopeKey}:${solution.weight}`, () => { const factors=envelope.factors; return song.upperBound(solution.weight, (_, index) => factors[index], { eventContext: input.draft.modifiers?.event }); });
    if(envelope===null)return includePriority?{upper:Infinity,priority:Infinity}:Infinity;
    if(minimumBonus)return bonusBound?bonusBound(available,forced,state.leader,solution,envelope.error,minimumBonus.forEdge,minimumBonus.value,state):Infinity;
    const joint=jointBound ? jointBound(available,forced,state.leader,solution,envelope.error,!state.forbidden.length,cutoff) : Infinity;
    if (!includePriority && joint <= cutoff) return joint;
    const timed=timedBound('',envelope);
    const assignment=assignedGain(available,forced,state.leader,solution.weight);
    // The small outward binary64 allowance covers the <=100000 positive sums,
    // five-effect gains and assignment additions, separately from native f32.
    let upper=assignment && Number.isFinite(assignment.gain) ? Math.min(timed,
      Math.ceil((assignment.total*(1+envelope.error)+assignment.gain)*(1+1e-10))) : timed;
    upper=Math.min(upper,joint);
    return includePriority?{upper,priority:timedBound('legacy:',getEnvelope('legacy:',Infinity))}:upper;
  };
  // A cutoff only skips additional SAFE bounds after one already proves
  // this partition cannot improve the incumbent. It never changes the domain.
  bound.withCutoff=(state,model,solution,draftForSolution,cutoff)=>bound(state,model,solution,draftForSolution,false,cutoff);
  bound.withMinimumBonus=(state,model,solution,draftForSolution,forEdge,value)=>{
    if(bonusBound)bonusBound.witnesses=[];
    return bound(state,model,solution,draftForSolution,false,-Infinity,{forEdge,value});
  };
  Object.defineProperty(bound,'bonusConstraintWitnesses',{get:()=>bonusBound?.witnesses??[]});
  bound.bonusConstraintStats=bonusBound?.stats??{matchingCalls:0};
  // This envelope covers every legal five-pair team containing the supplied
  // required members. It only proves that a chart domain cannot reach a grade;
  // it supplies no score and must retain fractional score/threshold units.
  // For minimum score, any subset of the 120 orders supplies an upper
  // bound: min(all orders) <= mean(orders with these members in fixed slots).
  // Choose slots using conservative per-member gains; this only tightens the
  // proof and never changes the scored orders or the candidate pool.
  const conditionalGains=new Map();
  const minimumGainFor=requiredMembers=>{
    const members=[...new Set(requiredMembers)].sort(),key=members.join('|');
    if(!members.length||members.length>5)return bonusBound.envelope.gainFor;
    if(conditionalGains.has(key))return conditionalGains.get(key);
    const costs=members.map(member=>{
      const values=Array(5).fill(0);let found=false;
      for(const pair of profiles.keys())if(pair.startsWith(member+'|')){
        found=true;const gains=bonusBound.envelope.positionGainsFor({key:pair});
        for(let i=0;i<5;i++)values[i]=Math.max(values[i],gains[i]);
      }
      return found?values:null;
    });
    if(costs.some(row=>!row))return bonusBound.envelope.gainFor;
    let dp=new Map([[0,{cost:0,positions:[]}]]);
    for(const values of costs){
      const next=new Map();
      for(const [mask,row] of dp)for(let i=0;i<5;i++)if(!(mask&(1<<i))){
        const target=mask|(1<<i),cost=row.cost+values[i];
        if(!next.has(target)||cost<next.get(target).cost)next.set(target,{cost,positions:[...row.positions,i]});
      }
      dp=next;
    }
    const chosen=[...dp.values()].sort((a,b)=>a.cost-b.cost)[0];
    const fixed=new Map(members.map((member,i)=>[member,chosen.positions[i]]));
    const remaining=[0,1,2,3,4].filter(i=>!chosen.positions.includes(i));
    const gainFor=edge=>{
      const gains=bonusBound.envelope.positionGainsFor(edge),position=fixed.get(edge.member);
      if(position!==undefined)return gains[position];
      // Unrecognized optional edges cannot belong to a five-forced-member
      // team. Keep a conservative value even if a caller includes them.
      return remaining.length?remaining.reduce((sum,i)=>sum+gains[i],0)/remaining.length:Math.max(...gains);
    };
    if(conditionalGains.size>=64)conditionalGains.delete(conditionalGains.keys().next().value);
    conditionalGains.set(key,gainFor);return gainFor;
  };
  bound.normalizedPowerEnvelope=(threshold,requiredMembers=[])=>{
    if(!bonusBound||!Number.isFinite(threshold)||threshold<=0)return null;
    const absolute=5*Math.max(0,...uniqueProfiles.map(p=>p.absolute));
    const {error}=replayError(absolute,uniqueProfiles,applicationLimit);
    const baseCoefficient=bonusBound.envelope.baseCoefficient*(1+error)/threshold*(1+1e-10);
    if(!Number.isFinite(baseCoefficient))return null;
    const gainFor=metric==='minimumScore'?minimumGainFor(requiredMembers):bonusBound.envelope.gainFor;
    return {baseCoefficient,gainFor:edge=>gainFor(edge)/threshold*(1+1e-10)};
  };
  bound.stats={fullScoreCalculations:0};
  bound.withPriority=(...args)=>bound(...args,true);
  return bound;
}
