import {RANKING_OPTIONS, editionName} from './song-ranking-options.mjs';
import {SCORE_GRADES} from './song-grade-ranking.mjs';

const basic = ['title','difficulty','level'];
const scores = ['expectedScore','efficiency','minimumScore','maximumScore','p10Score','p10Efficiency'];
const timing = ['durationSeconds','chartSeconds','audioSeconds','cycleSeconds'];
const skills = ['skillScoreGain','skillShare','scoreSpread','baseScore','scoreMultiplier','skillMultiplier','difficultyFactor','comboFactor'];
const structure = ['eventCount','convertedNoteCount','averageDensity','peakDensity','bpmMin','bpmMax'];
const gekisou = ['gekisouMultiplier','rankingBonusShare','rankingBonus','sampleCount','standardError'];
export function rankingTableColumns(mode = 'ordinary', metric = 'expectedScore') {
  const keys = ['title', ...(['requiredPower','targetScore'].includes(metric) ? ['requiredPower','targetScore'] : []), ...scores.slice(0,2), timing[0], ...basic.slice(1), ...scores.slice(2), ...timing.slice(1), ...skills, ...structure,
    ...(mode === 'gekisou' ? gekisou : [])];
  return keys.map(key => ({key, labels:RANKING_OPTIONS[key], width:key === 'title' ? 296 : ['p10Score','p10Efficiency'].includes(key) ? 164 : key === 'difficulty' || key === 'level' ? 76 : 116}));
}
export function formatRankingCell(key, row, locale = 'zh-CN') {
  const en = locale.startsWith('en'), value = row[key];
  const number = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString(locale, {maximumFractionDigits:digits}) : '—';
  if (key === 'editionLabel') return [row.applicableEditions?.length ? row.applicableEditions.map(edition => editionName(edition,en)).join(' / ') : '',
    row.pendingEditions?.length ? `${en ? 'Pending: ' : '待算：'}${row.pendingEditions.map(edition => editionName(edition,en)).join(' / ')}` : ''].filter(Boolean).join(' · ') || '—';
  if (key === 'calculationState') return row.pending ? en ? 'Benchmark pending' : '基准待计算' : !Number.isFinite(row.expectedScore) ? en ? 'Unavailable' : '当前条件不可算'
    : row.calculation === 'replay' ? en ? 'Replay complete' : '已完成精算' : row.calculation === 'linear' && row.skillProfile?.some(skill => skill.percent && skill.seconds) ? en ? 'Quick estimate' : '快速估算' : en ? 'Benchmark ready' : '基准已计算';
  if (RANKING_OPTIONS[key]?.[2] === 'text') return key === 'difficulty' ? value?.toUpperCase() ?? '—' : value || '—';
  if (!Number.isFinite(value)) return '—';
  if (key === 'requiredPower') return `${en ? 'Approx. ' : '约 '}${number(row.displayPower,0)}`;
  if (key === 'enteredRank') return SCORE_GRADES[value - 2] ?? '—';
  const type = RANKING_OPTIONS[key]?.[2];
  return type === 'percent' ? `${number(value*100)}%` : type === 'ratio' ? `${number(value,4)}×` : type === 'seconds' ? `${number(value)} s` : type === 'density' ? `${number(value)} / s` : number(value);
}

export function rankingStatusTags(row, locale = 'zh-CN') {
  const en = locale.startsWith('en');
  return [
    {kind:'band',label:row.bandLabels?.join(' / ') || '—',title:en?'Performing band':'演唱乐队',icons:row.bandIcons?.filter(Boolean)},
    {kind:'attribute',label:row.attribute || '—',title:en?'Song attribute':'歌曲属性',icons:row.attributeIcon?[row.attributeIcon]:[],color:row.attributeColor},
    {kind:'edition',label:formatRankingCell('editionLabel',row,locale),title:en?'Score editions':'分数适用版本',editions:[...new Set([...(row.applicableEditions??[]),...(row.pendingEditions??[])])]},
    {kind:'state',symbol:row.pending?'pending':!Number.isFinite(row.expectedScore)?'unavailable':row.calculation==='replay'?'replay':row.calculation==='linear'&&row.skillProfile?.some(skill=>skill.percent&&skill.seconds)?'estimate':'base',label:row.pending?en?'Pending':'待算':!Number.isFinite(row.expectedScore)?en?'N/A':'缺条件':row.calculation==='replay'?en?'Replay':'精算':row.calculation==='linear'&&row.skillProfile?.some(skill=>skill.percent&&skill.seconds)?en?'Estimate':'估算':en?'Base':'基准',description:formatRankingCell('calculationState',row,locale),title:en?'Calculation state':'计算状态',state:row.pending?'pending':Number.isFinite(row.expectedScore)?'calculated':'unavailable'}
  ];
}
export function rankingMetricExplanation(metric,mode='ordinary',en=false) {
  if(['requiredPower','targetScore'].includes(metric))return en ? 'Lower estimated power means an easier score threshold under the same AP and skill conditions, not easier play. Power is a linear estimate rounded up to 1,000; missing or unverified edition data is not ranked.' : '相同 AP 与技能条件下，参考综合力越低，越容易达到目标档位，不代表谱面操作更简单。综合力按基准线性估算、向上取整至千位；缺少或未经核验的版本数据不参与综合力排名。';
  if(!['p10Score','p10Efficiency'].includes(metric))return '';
  return mode==='gekisou'
    ? en?'P10 is the lower 10th percentile of fixed LUCK samples, not a guaranteed live score.':'P10 是固定 LUCK 样本中偏低的 10% 分位参考值，不是实战保底。'
    : en?'P10 is the 12th lowest score among 120 skill orders. Identical skills may produce equal scores; this is not a live guarantee.':'P10：将 120 种技能顺序从低到高排列，取第 12 个分数。技能相同时可能完全相同，不是实战保底。';
}
