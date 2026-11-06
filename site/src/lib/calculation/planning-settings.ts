import type {TeamDraft} from '../team-draft.mjs';
import type {Inventory, CardPool, GrowthRecords, GrowthPlan, PlanningScenario} from './growth-types.ts';
import type {OptimizerConstraints, PerformanceScenario, OptimizerRequest} from './optimizer-types.ts';

export type PlanningKind = 'reference' | 'selected' | 'current' | 'training' | 'trial';
export type RecommendationGoal = 'score' | 'stable' | 'missions';
type FormNumber = string | number;
/** Raw form values retain strings until the existing numeric validation runs. */
export interface PlanningFormValues {
  kind: string; trainingScope?: string; unknownGrowth?: string; growthMode?: string;
  maxTrainedCards?: FormNumber; skillLevel?: FormNumber; gekisouSkillLevel?: FormNumber;
  allowedCardIds?: string[]; targets?: GrowthRecords; trialCardIds?: CardPool;
  profile?: string; timingBiasMs?: FormNumber; timingSpreadMs?: FormNumber;
  missPercent?: FormNumber; startSeconds?: FormNumber; endSeconds?: FormNumber;
  explicit?: string; goal?: string;
}
export interface PlanningSettings {
  planningScenario: PlanningScenario; performanceScenario: PerformanceScenario;
  recommendationGoal: RecommendationGoal;
}
/** Translate a short player-facing form into explicit, saved calculation assumptions. */
const KINDS = new Set(['reference','selected','current','training','trial']);
export const planningKindScope = (kind: string) => kind === 'reference' ? 'reference' : kind === 'selected' ? 'selected' : kind === 'trial' ? 'trial' : 'owned';
export const planningObjectiveForGoal = (goal: string) => goal==='stable'?'minimum_song_score':'expected_song_score';
export const legacyPlanningScope = (kind: string,trainingScope='owned'): NonNullable<OptimizerRequest['scope']> => kind === 'reference' ? 'theoretical' : kind === 'selected'||kind==='training'&&trainingScope==='selected' ? 'selected' : 'owned';
export function defaultPlanningKind(inventory: Inventory | null | undefined, draft: TeamDraft | null | undefined): PlanningKind {
  if ((inventory?.memberCardIds?.length ?? 0) + (inventory?.supportCardIds?.length ?? 0)) return 'current';
  return draft?.slots?.some(s => s.memberCardId || s.supportCardId) ? 'selected' : 'reference';
}
function numeric(value: unknown, label: string, min: number, max: number) {
  const n=Number(value); if(!Number.isFinite(n)||n<min||n>max)throw new Error(`${label}应在 ${min}–${max} 之间`); return n;
}
export function createPlanningSettings(values: PlanningFormValues, {sourceReleaseId, draft}: {sourceReleaseId: string; draft: TeamDraft}): PlanningSettings {
  if(!KINDS.has(values.kind))throw new Error('请重新选择配队方式');
  const planningScenario: PlanningScenario={schemaVersion:1,sourceReleaseId,scope:values.kind==='training'&&values.trainingScope==='selected'?'selected':planningKindScope(values.kind),unknownGrowth:values.unknownGrowth==='reference'?'reference':'exclude'};
  if(values.kind==='reference'||values.unknownGrowth==='reference'||values.kind==='trial')planningScenario.referenceGrowth='maximum';
  if(values.kind==='selected'||values.kind==='trial'||values.kind==='training'&&values.trainingScope==='selected')planningScenario.selectedCardIds={
    memberCardIds:[...new Set(draft.slots.map(s=>s.memberCardId).filter((id): id is string => Boolean(id)))],
    supportCardIds:[...new Set(draft.slots.map(s=>s.supportCardId).filter((id): id is string => Boolean(id)))]};
  if(values.kind==='trial') {
    const ids=values.trialCardIds??{memberCardIds:[],supportCardIds:[]};
    if(!ids.memberCardIds.length&&!ids.supportCardIds.length)throw new Error('先加入一张想试的卡；也可以改用参考队伍。');
    planningScenario.trialCardIds=structuredClone(ids);
  }
  if(values.kind==='training') {
    const maxTrainedCards=numeric(values.maxTrainedCards,'培养张数',1,10);
    if(!Number.isInteger(maxTrainedCards))throw new Error('培养张数应为整数');
    const plan: GrowthPlan={schemaVersion:1,sourceReleaseId,enabled:true,mode:values.growthMode==='maximum'?'maximum':'current-cap',maxTrainedCards};
    if(values.allowedCardIds?.length)plan.allowedCardIds=[...new Set(values.allowedCardIds)];
    for(const field of ['skillLevel','gekisouSkillLevel'] as const)if(values[field]!==''&&values[field]!=null){plan[field]=numeric(values[field],'技能等级',1,5);if(!Number.isInteger(plan[field]))throw new Error('技能等级应为整数');}
    const targets=Object.fromEntries(Object.entries(values.targets??{}).filter(([,fields])=>Object.keys(fields).length));
    if(Object.keys(targets).length)plan.targets=structuredClone(targets);
    planningScenario.plan=plan;
  }
  const profile=values.profile==='ideal'||values.profile==='steady'||values.profile==='practice'?values.profile:'steady';
  const performanceScenario: PerformanceScenario={profile,seed:20261004,samples:profile==='ideal'?1:3,timingBiasMs:numeric(values.timingBiasMs??0,'整体偏差',-500,500)};
  if(values.timingSpreadMs!==''&&values.timingSpreadMs!=null)performanceScenario.timingSpreadMs=numeric(values.timingSpreadMs,'时机波动',0,500);
  if(values.missPercent!==''&&values.missPercent!=null)performanceScenario.missRate=numeric(values.missPercent,'漏按比例',0,100)/100;
  if(values.startSeconds!==''&&values.startSeconds!=null||values.endSeconds!==''&&values.endSeconds!=null) {
    if(values.startSeconds===''||values.endSeconds==='')throw new Error('较难区间的开始和结束都需要填写');
    const startMs=numeric(values.startSeconds,'开始时间',0,86400)*1000,endMs=numeric(values.endSeconds,'结束时间',0,86400)*1000;
    if(endMs<=startMs)throw new Error('较难区间的结束时间应晚于开始时间');
    performanceScenario.difficultRanges=[{startMs,endMs,spreadMultiplier:2}];
  }
  if(values.explicit?.trim()) {
    try{performanceScenario.performance=JSON.parse(values.explicit);}catch{throw new Error('演出记录不是有效的 JSON，请检查后重试');}
    performanceScenario.profile='explicit';performanceScenario.samples=1;
  }
  return {planningScenario,performanceScenario,recommendationGoal:values.goal==='score'||values.goal==='stable'||values.goal==='missions'?values.goal:'score'};
}
export function planningSettingsValues(modifiers: TeamDraft['modifiers']={}, fallback: PlanningKind='reference'): PlanningFormValues {
  const s=modifiers.planningScenario,p=modifiers.performanceScenario??{};
  return {kind:s?.plan?.enabled!==false&&s?.plan?'training':s?.scope==='owned'?'current':KINDS.has(s?.scope??'')?s!.scope!:fallback,
    trainingScope:s?.scope==='selected'?'selected':'owned',unknownGrowth:s?.unknownGrowth??'exclude',growthMode:s?.plan?.mode==='maximum'?'maximum':'current-cap',maxTrainedCards:s?.plan?.maxTrainedCards??1,
    skillLevel:s?.plan?.skillLevel??'',gekisouSkillLevel:s?.plan?.gekisouSkillLevel??'',allowedCardIds:s?.plan?.allowedCardIds??[],targets:structuredClone(s?.plan?.targets??{}),
    trialCardIds:structuredClone(s?.trialCardIds??{memberCardIds:[],supportCardIds:[]}),profile:p.profile==='explicit'?'steady':p.profile??'steady',
    timingBiasMs:p.timingBiasMs??0,timingSpreadMs:p.timingSpreadMs??'',missPercent:p.missRate==null?'':p.missRate*100,
    startSeconds:p.difficultRanges?.[0]?.startMs==null?'':p.difficultRanges[0].startMs/1000,endSeconds:p.difficultRanges?.[0]?.endMs==null?'':p.difficultRanges[0].endMs/1000,
    explicit:p.profile==='explicit'?JSON.stringify(p.performance,null,2):'',goal:modifiers.recommendationGoal??'score'};
}
const kindLabels: Record<string,string>={reference:'参考队伍 · 卡片满养成',selected:'手选卡',current:'当前养成',training:'培养计划',trial:'试用队伍'};
export function planningSummary(values: PlanningFormValues) {
  let text=kindLabels[values.kind]??'参考队伍';
  if(values.kind==='training')text+=` · 最多练 ${values.maxTrainedCards} 张 · ${values.growthMode==='maximum'?'全满养成参考':'保持突破、觉醒'}`;
  if(values.unknownGrowth==='reference'&&values.kind!=='reference')text+=' · 缺失养成按满养成参考';
  return text;
}
export function updatePlanningCardPreference(constraints: OptimizerConstraints,{kind,id,preference}: {kind: 'member' | 'support'; id: string; preference: 'keep' | 'exclude' | ''}) {
  const next=structuredClone(constraints),suffix=kind==='member'?'MemberIds':'SupportIds';
  for(const prefix of ['required','excluded'] as const) {
    const key=`${prefix}${suffix}` as const;next[key]=(next[key]??[]).filter(value=>String(value)!==String(id));
    if((prefix==='required'&&preference==='keep')||(prefix==='excluded'&&preference==='exclude'))next[key].push(id);
    if(!next[key].length)delete next[key];
  }
  return next;
}
