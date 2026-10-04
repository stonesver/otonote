import {resolveGrowthScenario} from '../../../packages/scoring/scoring-rules/growth-scenarios.mjs';
import {teamCardFacets,teamCardFilterOptions} from './team-card-filters.mjs';
const copy=value=>structuredClone(value??{});

/** Presentation reads scenario evidence; it never fills or changes the actual collection. */
export function resolveTeamCardGrowth({card,draft,inventory,rules}) {
  const id=card.id,kind=card.kind??(id.startsWith('member-')?'member':'support'),modifiers=draft?.modifiers??{},scenario=modifiers.planningScenario;
  const owned=inventory?.[`${kind}CardIds`]?.includes(id),actual=owned?inventory?.growth?.[id]:undefined;
  const supplied=modifiers.growth?.[id],previous=modifiers.planningResult;
  const training=scenario?.plan&&scenario.plan.enabled!==false;
  const trial=scenario?.scope==='trial'&&scenario.trialCardIds?.[`${kind}CardIds`]?.includes(id)&&!owned;
  const reference=scenario?.scope==='reference'||trial;
  if(reference&&rules){
    const selected={memberCardIds:[],supportCardIds:[]};selected[`${kind}CardIds`]=[id];
    const ref=resolveGrowthScenario(rules,{slots:draft?.slots??Array.from({length:5},()=>({})),modifiers:{}},
      {scope:'selected',selectedCardIds:selected,unknownGrowth:'reference',referenceGrowth:scenario?.referenceGrowth??'maximum'});
    return {growth:copy(ref.cards[id]?.currentGrowth),source:'reference'};
  }
  if(reference)return {growth:copy(supplied),source:'reference'};
  if(scenario?.scope==='owned'&&!training&&!actual)return {growth:{},source:'unknown'};
  const explicitlySelected=scenario?.scope==='selected'&&!training;
  const baseline=explicitlySelected?(supplied??actual):(actual??previous?.actualGrowth?.[id]??supplied);
  if(training&&rules){
    const selected=previous?.selectedTrainingCardIds;
    const active=selected!==undefined?selected.includes(id):Object.hasOwn(scenario.plan.targets??{},id);
    const allowed=scenario.plan.allowedCardIds==null||scenario.plan.allowedCardIds.includes(id);
    if(active&&allowed){
      const pool={memberCardIds:[],supportCardIds:[]};pool[`${kind}CardIds`]=[id];
      // A single-card view does not evaluate other targets or choose additional cards to train.
      const plan={...scenario.plan,sourceReleaseId:rules.sourceReleaseId,allowedCardIds:[id],targets:scenario.plan.targets?.[id]?{[id]:scenario.plan.targets[id]}:{}};
      const resolved=resolveGrowthScenario(rules,{slots:draft?.slots??Array.from({length:5},()=>({})),modifiers:{growth:baseline?{[id]:copy(baseline)}:{}}},
        {scope:'selected',selectedCardIds:pool,unknownGrowth:scenario.unknownGrowth??'exclude',referenceGrowth:scenario.referenceGrowth,plan});
      const entry=resolved.cards[id];
      if(entry)return {growth:copy(entry.targetGrowth),source:entry.actualKnown?'training':'reference'};
    }
  }
  if(!baseline||!Object.keys(baseline).length)return {growth:{},source:'unknown'};
  return {growth:copy(baseline),source:explicitlySelected&&supplied?'selected':actual?'actual':supplied||previous?.actualGrowth?.[id]?'selected':'unknown'};
}

/** Noninteractive card content safe to place inside a caller-owned button or list item. */
export function createTeamCardView(card,{growth={},kind=card.kind,locale='zh-CN',data={},compact=false,source='unknown'}={}) {
  const doc=data.document??globalThis.document,en=locale==='en',say=(zh,english)=>en?english:zh;
  const node=(tag,text,cls)=>{const value=doc.createElement(tag);if(text!=null)value.textContent=text;if(cls)value.className=cls;return value;};
  const root=node('span',null,`tw-card-view${compact?' tw-card-view--compact':''}`);root.dataset.source=source;
  const art=node('span',null,'tw-card-art');
  if(card.imageUrl){const image=node('img');image.src=card.imageUrl;image.alt='';image.loading='lazy';art.append(image);}
  else art.append(node('span','—','tw-card-no-art'));
  root.append(art);
  const body=node('span',null,'tw-card-body');body.append(node('span',card.shortLabel??card.displayName??card.id,'tw-card-name'));
  if(!compact&&card.relationLabel)body.append(node('span',card.relationLabel,'tw-card-relation'));
  const meta=node('span',null,'tw-card-meta'),facets=teamCardFacets(card),options=teamCardFilterOptions([card],data);
  for(const group of ['attribute','band','rarity'])for(const value of facets[group]){
    const option=options[group].find(row=>row.value===value),label=option?.label??value;
    const chip=node('span',null,`tw-card-${group}`);chip.title=label;
    if(option?.icon){const image=node('img');image.src=option.icon;image.alt=label;image.loading='lazy';chip.append(image);}
    else chip.textContent=group==='attribute'?say(`属性 ${label}`,`Attribute ${label}`):group==='band'?say(`乐队 ${label}`,`Band ${label}`):label;
    meta.append(chip);
  }
  body.append(meta);
  const stats=node('span',null,'tw-card-growth');
  const fields=kind==='support'?[['level','等级','Level','supportLevel'],['rank','突破','Rank','rank']]:[
    ['level','等级','Level','memberLevel'],['rank','突破','Rank','rank'],['awake','觉醒','Awakening','awake'],
    ['skillLevel','演出技能','Live skill'],['gekisouSkillLevel','激奏技能','Gekisou skill']];
  for(const [field,zh,english,icon] of fields){
    const value=Number.isInteger(growth?.[field])?growth[field]:'—',label=say(zh,english),stat=node('span',null,'tw-card-stat');stat.dataset.field=field;stat.title=`${label} ${value}`;
    if(icon&&data.growthIcons?.[icon]){const image=node('img');image.src=data.growthIcons[icon];image.alt=label;image.loading='lazy';stat.append(image);}else stat.append(node('span',label,'tw-card-stat-label'));
    stat.append(node('span',field==='level'?`Lv.${value}`:String(value),'tw-card-stat-value'));stats.append(stat);
  }
  body.append(stats);
  const sources={actual:say('当前养成','Current growth'),training:say('培养目标','Training target'),reference:say('参考养成','Reference growth'),selected:say('手选养成','Selected growth'),unknown:say('养成未记录','Growth unknown')};
  body.append(node('span',sources[source]??sources.unknown,'tw-card-source'));root.append(body);return root;
}
