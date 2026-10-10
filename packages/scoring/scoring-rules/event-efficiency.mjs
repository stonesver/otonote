import { addCardPower, cardPowerPoints, createCardPowerBP, createCardPowerInt, floorCardPower, multiplyCardPower } from './card-power.mjs';

const integer = (value, label, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
};
const one = (rows, predicate, label) => {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous ${label}`);
  return matches[0];
};

/** JP BattleLiveScoreRankCalculator.CalcRequiredScore (0x5ae94f4).
 * eligiblePlayers is the client's rank-target count, not an assumed room size.
 */
export function battleScoreRequirement(baseScore, eligiblePlayers) {
  integer(baseScore, 'battle base threshold'); integer(eligiblePlayers, 'rank-target players', 1, 5);
  return integer(Math.trunc(baseScore * Math.sqrt(5 / eligiblePlayers) * eligiblePlayers), 'battle threshold', 0, 2147483647);
}

/** JP ChallengeLive data model. Amounts are client-model estimates, not server
 * settlements. Display-rounded percentages must never be used as inputs.
 * Evidence: output/verification/event-efficiency-20260930/native-evidence.txt.
 */
export function createEventEfficiency({ tables, sourceReleaseId, eventId }) {
  if (!(/^(jp|global)-/.test(sourceReleaseId ?? ''))) throw new Error('Unsupported event release');
  const event = one(tables.Event, r => r._id === eventId, 'event');
  if (event._eventType !== 1) throw new Error('Unsupported event mechanism');
  const effects = tables.EventEffect.filter(e => e._eventId === eventId);
  for (const e of effects) {
    if (![0, 1, 2].includes(e._eventBonusType) || ![2, 3].includes(e._resourceTypeConstraint) || e._tagId) {
      throw new Error(`Unsupported event effect ${e._id}`);
    }
    for (let rank = 1; rank <= 5; rank++) integer(e[`_rank${rank}EffectValue`], 'effect value');
  }
  const characters = new Map(tables.Character.map(r => [r._id, r]));
  function cardBonus(kind, id, rank) {
    if (!['member', 'support'].includes(kind)) throw new Error('Invalid card kind');
    integer(rank, 'card rank', 1, 5);
    const type = kind === 'member' ? 2 : 3;
    const card = one(tables[kind === 'member' ? 'MemberCard' : 'SupportCard'], r => r._id === id, 'card');
    const cast = kind === 'member' ? [card._characterID] : card._characterIDs;
    if (!cast?.length || cast.some(id => !characters.has(id))) throw new Error('Missing card characters');
    const matched = effects.filter(e => e._resourceTypeConstraint === type
      && (!e._memberCardId || kind === 'member' && card._id === e._memberCardId)
      && (!e._supportCardId || kind === 'support' && card._id === e._supportCardId)
      && (!e._characterId || cast.includes(e._characterId))
      && (!e._bandId || cast.some(id => characters.get(id)._bandID === e._bandId))
      && (!e._cardType || card._cardType === e._cardType));
    return { kind, id, rank, characterIds: cast, attribute: card._cardType,
      // Native EventPointBonus filters type 0; item rewards use type 1.
      eventPointBP: matched.filter(e => e._eventBonusType === 0)
        .reduce((sum, e) => sum + e[`_rank${rank}EffectValue`], 0),
      rewardBP: matched.filter(e => e._eventBonusType === 1)
        .reduce((sum, e) => sum + e[`_rank${rank}EffectValue`], 0),
      powerBP: matched.filter(e => e._eventBonusType === 2)
        .reduce((sum, e) => sum + e[`_rank${rank}EffectValue`], 0),
      effectIds: matched.map(e => e._id) };
  }
  function teamBonus(slots) {
    if (slots.length !== 5) throw new Error('Exactly five pairs required');
    const cards = slots.flatMap(s => [cardBonus('member', s.memberId, s.memberRank), cardBonus('support', s.supportId, s.supportRank)]);
    const members = cards.filter(c => c.kind === 'member'), supports = cards.filter(c => c.kind === 'support');
    if (new Set(members.flatMap(c => c.characterIds)).size !== 5 || new Set(supports.map(c => c.id)).size !== 5) throw new Error('Duplicate character or support');
    return { rewardBP: cards.reduce((sum, c) => sum + c.rewardBP, 0),
      eventPointBP: cards.reduce((sum, c) => sum + c.eventPointBP, 0), cards };
  }
  function rewards({ mode, scoreRank, rewardBP, eventPointBP, liveBoost = 0, challengeCost = 200 }) {
    if (!['ordinary', 'gekisou', 'challenge'].includes(mode)) throw new Error('Unsupported live mode');
    integer(scoreRank, 'score rank', 2, 7); integer(rewardBP, 'reward bonus');
    integer(eventPointBP, 'event point bonus');
    integer(liveBoost, 'live boost', 0, 10);
    const challenge = mode === 'challenge';
    if (challenge && liveBoost !== 0) throw new Error('Challenge Live cannot spend live boost');
    const boost = challenge
      ? one(tables.ChallengeMusicBoostBonus, r => r._consumedChallengePointCount === challengeCost, 'challenge consumption')
      : liveBoost ? one(tables.LiveMusicBoostBonus, r => r._consumedLiveBoostCount === liveBoost, 'live boost')
        : { _eventPointRate: 1, _liveMusicRewardRate: 1 };
    const pointGroup = challenge ? event._challengeLiveEventPointGroup : event._liveEventPointGroup;
    const rewardGroup = challenge ? event._challengeLiveEventRewardGroup : event._liveEventRewardGroup;
    const prefix = challenge ? 'ChallengeLive' : 'Live';
    const basePoints = one(tables[`${prefix}EventPoint`], r => r._group === pointGroup && r._scoreRank === scoreRank, 'event points')._value;
    const badge = one(tables[`${prefix}EventReward`], r => r._eventGroup === rewardGroup && r._scoreRank === scoreRank
      && r._resourceType === 1 && r._resourceId === event._eventItemId, 'badge reward');
    if (badge._probability !== 10000) throw new Error('Probabilistic badge rewards are not supported');
    // Native event result presenter: base CP * boost, with NO deck bonus.
    const challengePoints = challenge ? 0 : one(tables.LiveChallengePoint, r => r._scoreRank === scoreRank, 'challenge points')._value * boost._eventPointRate;
    const scaled = (base, multiplier, bonus) => {
      integer(base, 'base reward'); integer(multiplier, 'reward multiplier', 1);
      const value = BigInt(base) * BigInt(10000 + bonus) * BigInt(multiplier) / 10000n;
      return integer(Number(value), 'reward overflow');
    };
    const eventPoints = scaled(basePoints, boost._eventPointRate, eventPointBP);
    const badges = scaled(badge._resourceCount, boost._liveMusicRewardRate, rewardBP);
    return { status: 'client_model_estimate', sourceReleaseId, eventId, mode, scoreRank, rewardBP, eventPointBP,
      eventPoints, badges, challengePoints, liveBoost: challenge ? 0 : liveBoost,
      challengeCost: challenge ? challengeCost : 0,
      badgesPerChallengePoint: challenge ? badges / challengeCost : null,
      challengePointsPerBoost: !challenge && liveBoost ? challengePoints / liveBoost : null,
      badgesPerBoost: !challenge && liveBoost ? badges / liveBoost : null };
  }
  function scoreRank(musicId, score) {
    if (!Number.isFinite(score) || score < 0) throw new Error('Invalid live score');
    const song = one(tables.LiveMusic, r => r._id === musicId, 'music');
    const rows = tables.LiveScoreRank.filter(r => r._group === song._liveScoreRankGroup);
    if (rows.length !== 6) throw new Error('Missing score thresholds');
    return Math.max(...rows.filter(r => score >= r._requiredScore).map(r => r._liveScoreRank));
  }
  function battleRank(musicId, eligibleTotalScore, eligiblePlayers) {
    integer(eligibleTotalScore, 'eligible total score');
    const song = one(tables.LiveMusic, r => r._id === musicId, 'music');
    const rows = tables.LiveScoreRank.filter(r => r._group === song._liveScoreRankGroup);
    if (rows.length !== 6) throw new Error('Missing battle thresholds');
    return Math.max(...rows.filter(r => eligibleTotalScore >= battleScoreRequirement(r._battleLiveRequiredScore, eligiblePlayers))
      .map(r => r._liveScoreRank));
  }
  function challengeAdapter(rules) {
    if (rules.sourceReleaseId !== sourceReleaseId || JSON.stringify(rules.tables.EventEffect) !== JSON.stringify(tables.EventEffect)) throw new Error('Event adapter release_mismatch');
    const growthRank = (draft, kind, id) => draft.modifiers?.growth?.[`${kind}-card-${id}`]?.rank ?? 1;
    return { sourceReleaseId, supports: row => row._id === eventId,
      resolve: () => ({ effects: ['member_power', 'support_power', 'song_context'].map(phase => ({ phase })) }),
      handlers: {
        member_power: (values, _, { draft, member }) => {
          const bp = cardBonus('member', member._id, growthRank(draft, 'member', member._id)).powerBP;
          const own = createCardPowerInt(...values);
          const delta = floorCardPower(multiplyCardPower(own, createCardPowerBP(bp, bp, bp)));
          const result = cardPowerPoints(addCardPower(own, delta));
          return [result.performance, result.technic, result.visual];
        },
        // Native CalculateSlotPower adds the snapshot event BP to its normal
        // support BP. It does NOT multiply the two percentages together.
        support_power: (values, _, { draft, support }) => {
          const bp = support ? cardBonus('support', support._id, growthRank(draft, 'support', support._id)).powerBP : 0;
          return values.map(value => value + bp);
        },
        song_context: song => {
          if (!song) throw new Error('Challenge song required');
          const row = one(tables.ChallengeMusic, r => r._eventId === eventId && r._liveMusicId === song._id, 'challenge song');
          if ([row._gekisouMission1, row._gekisouMission2, row._gekisouMission3].some(v => v !== 0)) throw new Error('Unsupported challenge missions');
          return { ...song, _musicType: row._musicType, _gekisouMission1: 0, _gekisouMission2: 0, _gekisouMission3: 0 };
        }
      } };
  }
  return { event, cardBonus, teamBonus, rewards, scoreRank, battleRank, challengeAdapter };
}

/** Finite budget: leftover CP cannot be spent fractionally. Milestone rewards
 * are deliberately separate from repeatable live rewards. */
export function eventFarmingCycle({ normal, challenge, normalPlays, startingCP = 0, normalSeconds, challengeSeconds }) {
  integer(normalPlays, 'normal plays'); integer(startingCP, 'starting CP');
  if (!['ordinary', 'gekisou'].includes(normal.mode) || challenge.mode !== 'challenge'
    || normal.sourceReleaseId !== challenge.sourceReleaseId || normal.eventId !== challenge.eventId
    || challenge.challengeCost <= 0) throw new Error('Incompatible farming stages');
  const cp = startingCP + normal.challengePoints * normalPlays;
  const challengePlays = Math.floor(cp / challenge.challengeCost);
  const liveBoost = normal.liveBoost * normalPlays;
  const badges = normal.badges * normalPlays + challenge.badges * challengePlays;
  const seconds = normalSeconds == null || challengeSeconds == null ? null
    : normalPlays * normalSeconds + challengePlays * challengeSeconds;
  if (seconds !== null && (!Number.isFinite(seconds) || seconds <= 0 || normalSeconds <= 0 || challengeSeconds <= 0)) throw new Error('Invalid cycle time');
  return { normalPlays, challengePlays, remainingCP: cp % challenge.challengeCost, liveBoost, badges,
    eventPoints: normal.eventPoints * normalPlays + challenge.eventPoints * challengePlays,
    badgesPerBoost: liveBoost ? badges / liveBoost : null, seconds, badgesPerMinute: seconds ? badges * 60 / seconds : null };
}

/** Spend a finite CP balance across mixed consumption tiers. Maximize the
 * selected reward, then the other reward, then use fewer plays. */
export function planChallengeSpending(options, availableCP, metric = 'badges') {
  integer(availableCP, 'available CP');
  return createChallengeSpendingPlanner(options, metric)(availableCP);
}

/** Job-local value function: extend the exact DP once and reuse its prefixes
 * for every team's earned CP instead of rebuilding the table per query. */
export function createChallengeSpendingPlanner(options, metric = 'badges') {
  options = options.map(row => ({ ...row }));
  if(!['badges','eventPoints'].includes(metric))throw Error('Invalid challenge reward objective');
  if (!options.length) throw new Error('Challenge options required');
  const first = options[0];
  for (const row of options) {
    integer(row.challengeCost, 'challenge cost', 1); integer(row.badges, 'badges'); integer(row.eventPoints, 'event points');
    if (row.mode !== 'challenge' || row.sourceReleaseId !== first.sourceReleaseId || row.eventId !== first.eventId) throw new Error('Incompatible challenge options');
  }
  if (new Set(options.map(r => r.challengeCost)).size !== options.length) throw new Error('Duplicate challenge cost');
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const unit = options.map(r => r.challengeCost).reduce(gcd);
  const states = [{ badges: 0, plays: 0, eventPoints: 0 }], prefixes = [0];
  const secondary = metric === 'badges' ? 'eventPoints' : 'badges';
  const better = (a, b) => !b || a[metric] > b[metric] || a[metric] === b[metric]
    && (a[secondary] > b[secondary] || a[secondary] === b[secondary] && a.plays < b.plays);
  return function query(availableCP) {
    integer(availableCP, 'available CP');
    const size = Math.floor(availableCP / unit);
    if (size > 100000) throw new Error('Challenge budget too large');
    for (let i = states.length; i <= size; i++) {
      states[i] = null;
      for (const [index, row] of options.entries()) {
        const previous = i - row.challengeCost / unit;
        if (previous < 0 || !states[previous]) continue;
        const before = states[previous];
        const next = { badges: before.badges + row.badges, eventPoints: before.eventPoints + row.eventPoints, plays: before.plays + 1, previous, index };
        if (better(next, states[i])) states[i] = next;
      }
      const previousBest = prefixes[i - 1];
      prefixes[i] = states[i] && better(states[i], states[previousBest]) ? i : previousBest;
    }
    const bestIndex = prefixes[size];
    const counts = new Map();
    for (let i = bestIndex; i > 0; i = states[i].previous) {
      const cost = options[states[i].index].challengeCost; counts.set(cost, (counts.get(cost) ?? 0) + 1);
    }
    const best = states[bestIndex];
    return { badges: best.badges, eventPoints: best.eventPoints, plays: best.plays,
      spentCP: bestIndex * unit, remainingCP: availableCP - bestIndex * unit,
      consumption: [...counts].sort((a, b) => b[0] - a[0]).map(([cost, plays]) => ({ cost, plays })) };
  };
}
