import {planningUiText} from './team-planning-translations.mjs';
import {skillActivation} from './skill-activation-view.mjs';
import {teamLineup,scoreComposition} from './score-visuals.mjs';
import {scoringScenarioSearch} from './scoring-rules/scenario-search.mjs';
import {toolRoute} from './tool-route.mjs';
const ui=text=>planningUiText(text,typeof document==='undefined'?'zh-CN':document.documentElement.lang);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=ui(text);if(cls)n.className=cls;return n;};
const number=n=>n==null?'—':n.toLocaleString(undefined,{maximumFractionDigits:2});
const growthFields={level:'等级',rank:'突破阶数',awake:'觉醒阶数',skillLevel:'演出技能',gekisouSkillLevel:'激奏技能'};
export function recommendationScenarioLabel(result) {
  if(result.planning?.label)return result.planning.label;
  const s=result.draft?.modifiers?.planningScenario;
  if(s?.plan&&s.plan.enabled!==false)return '培养计划';
  if(s?.scope==='reference')return '参考队伍 · 满养成';
  if(s?.scope==='trial')return '试用队伍';
  if(result.planning?.missingActual||s?.unknownGrowth==='reference')return '包含参考养成';
  return s?.scope==='owned'?'当前养成':'所选养成';
}
export function visibleRecommendations(results) {
  const seen=new Set();return results.filter(result=>{
    const key=JSON.stringify([result.draft?.slots,result.draft?.modifiers?.growth]);
    if(seen.has(key))return false;seen.add(key);return true;
  }).slice(0,3);
}
function trainingDescription(change,workbench) {
  const kind=change.type??change.kind??(String(change.id).startsWith('support')?'support':'member');
  const card=workbench.cardFor?.(kind,change.id),name=change.name??card?.shortLabel??change.id;
  const fields=Array.isArray(change.fields)?change.fields:Object.entries(change.fields??change.changes??{}).map(([field,values])=>({field,...values}));
  return `${name}：${fields.map(item=>`${ui(growthFields[item.field]??item.field)} ${item.from??ui('未记录')} → ${item.to??'—'}`).join('，')}`;
}
export function renderOptimizerResults(workbench,results,{mode,objective,live=false}={}) {
  const root=workbench.querySelector('[data-pairing-results]');root.replaceChildren();
  workbench.querySelector('[data-results-empty]').hidden=Boolean(results.length);
  for(const [i,result] of visibleRecommendations(results).entries()) {
    const row=el('li',null,'recommendation'),direction=result.direction;
    const header=el('div',null,'recommendation-heading');
    header.append(el('span',direction?.label??(live?'已找到的方案 · 计算中':i?`方案 ${i+1}`:'推荐编成'),'recommendation-label'),
      el('span',mode==='gekisou'?'激奏演出':'普通自由演出','recommendation-mode'));
    row.append(header,el('span',recommendationScenarioLabel(result),'recommendation-scenario'));
    const score=el('div',null,'recommendation-score');
    score.append(el('strong',number(result.value)),el('span',objective==='formation_power'?'综合力':objective==='expected_song_score'?'参考平均分':objective==='minimum_song_score'?'本次比较中的低分':'本次比较中的高分'));
    if(result.delta!=null&&!result.planning?.missingActual)score.append(el('em',`${result.delta>=0?'+':''}${number(result.delta)} 较当前养成方案`,result.delta>=0?'is-positive':'is-negative'));
    row.append(score,teamLineup(workbench,result.draft));
    if(direction?.reason)row.append(el('p',direction.reason,'recommendation-reason'));
    if(direction?.tradeoff)row.append(el('p',direction.tradeoff,'recommendation-tradeoff'));
    const planning=result.planning;
    if(planning?.trainingChanges?.length){
      const training=el('div',null,'recommendation-training');training.append(el('strong',`这套队伍需要练好 ${planning.trainingChanges.length} 张卡`));
      const list=el('ul');for(const change of planning.trainingChanges)list.append(el('li',trainingDescription(change,workbench)));training.append(list);
      const values=[['当前卡库方案',planning.currentValue],['这套队伍按当前养成',planning.plannedTeamCurrentValue],['这套队伍达到目标后',planning.targetValue]];
      if(!planning.missingActual&&values.some(([,v])=>v!=null)){const dl=el('dl',null,'recommendation-power');for(const [label,value] of values){const item=el('div');item.append(el('dt',label),el('dd',number(value)));dl.append(item);}training.append(dl);}
      if(planning.missingActual)training.append(el('p','部分当前养成未记录，暂不计算比现在提高多少。'));
      training.append(el('p','材料消耗尚未核算；应用队伍不会修改实际卡库。'));row.append(training);
    }else if(planning?.missingActual)row.append(el('p','包含参考养成，尚不能作为当前可用队伍或计算实际提升。','recommendation-caption'));
    if(result.performanceSummary)row.append(el('p',typeof result.performanceSummary==='string'?result.performanceSummary:result.performanceSummary.label??'','recommendation-caption'));
    const actions=el('div',null,'recommendation-actions'),apply=el('button','应用队伍');apply.type='button';
    apply.addEventListener('click',()=>{workbench.draft=structuredClone(result.draft);workbench.planningScenarios?.restore();workbench.commit();workbench.dispatchEvent(new CustomEvent('calculator-edit-team'));workbench.querySelector('#team-editor')?.scrollIntoView({block:'start',behavior:'auto'});});actions.append(apply);
    const save=el('button','保存预设');save.type='button';
    save.addEventListener('click',()=>workbench.dispatchEvent(new CustomEvent('save-preset-candidate',{detail:{draft:result.draft,name:`${recommendationScenarioLabel(result)} · ${direction?.label??`${mode==='gekisou'?'激奏':'普通'}方案 ${i+1}`}`,onSaved:()=>{save.textContent=ui('已保存，可在比较队伍中查看');},onError:message=>{save.textContent=message;}}})));actions.append(save);
    if(planning?.trainingChanges?.length){const adjust=el('button','修改培养目标');adjust.type='button';adjust.addEventListener('click',()=>{workbench.querySelector('[data-planning-training]')?.scrollIntoView({block:'center',behavior:'auto'});workbench.querySelector('[data-planning-count]')?.focus();});actions.append(adjust);}
    if(objective!=='formation_power'){
      const link=el('a','查看分数明细 →');link.href=toolRoute(`/tools/song-calculator/${scoringScenarioSearch(result.draft,mode,result.scenario)}`,window.location.pathname);actions.append(link);
    }
    row.append(actions);
    const detail=el('details',null,'recommendation-details');detail.append(el('summary','查看配对、分段得分与计算条件'));
    // Expensive skill and chart views are created only when requested.
    detail.addEventListener('toggle',()=>{
      if(!detail.open||detail.dataset.loaded)return;detail.dataset.loaded='true';
      if(result.sections?.length)detail.append(scoreComposition(result.sections,result.expectedScore));
      if(objective!=='formation_power')detail.append(el('p',`综合力 ${number(result.power)} · 本次比较范围 ${number(result.minimumScore)} – ${number(result.maximumScore)} 分`,'recommendation-caption'));
      if(result.scoreDistribution)detail.append(el('p',`较低一成位置的分数 ${number(result.scoreDistribution.p10)} · 共 ${result.scoreDistribution.count} 次比较；不是实战保底。`,'recommendation-caption'));
      detail.append(skillActivation(workbench,result.draft,{mode,scenario:result.scenario,conditionsOnly:objective==='formation_power'}));
      if(result.comparison&&!planning?.missingActual){const c=result.comparison;detail.append(el('p',`相对当前养成方案：综合力 ${number(c.powerChangePercent)}%，目标分数 ${number(c.scoreChangePercent)}%。这是整队替换后的变化。`));}
      if(result.sections){
        detail.append(el('p',`名次奖励占总分 ${number(result.rankingBonusShare*100)}% · ${result.sampleCount} 次模拟 · 抽样标准误 ${number(result.standardError)}（不含模型误差）`));
        const table=el('table'),head=el('tr');for(const label of ['激奏段','任务累计','音符分','平均名次','奖励','占整曲']){const th=el('th',label);th.scope='col';head.append(th);}table.append(head);
        for(const s of result.sections){const tr=el('tr');for(const value of [`${s.index} ${['','COMBO','LUCK','JUST'][s.missionType]}`,number(s.missionType===1?s.combo:s.missionType===2?s.luckPoints:s.just),number(s.noteScore),number(s.rank),number(s.rankingBonus),`${number(s.share*100)}%`])tr.append(el('td',value));table.append(tr);}const wrap=el('div',null,'calculator-table-scroll');wrap.tabIndex=0;wrap.setAttribute('aria-label','激奏分段得分，可横向滚动');wrap.append(table);detail.append(wrap);
      }
      const names={member:'成员',support:'留影',typeLink:'属性连携',musicType:'歌曲属性',musicTag:'擅长歌曲',leader:'队长',bandItem:'乐器',characterRank:'角色评级',characterTotalRank:'总评级',tgw:'TGW',memory:'回忆'},dl=el('dl',null,'recommendation-power');
      for(const [key,value] of Object.entries(result.breakdown??{})){const item=el('div');item.append(el('dt',names[key]??key),el('dd',number(value.total)));dl.append(item);}detail.append(dl);
    });
    row.append(detail);root.append(row);
  }
}
