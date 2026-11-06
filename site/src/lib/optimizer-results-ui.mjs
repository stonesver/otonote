import {recommendationScenarioLabel,visibleRecommendations} from './recommendation-result-model.mjs';
import {mountRecommendationOverview,clearOptimizerResults} from './calculation/recommendation-overview.ts';
export {clearOptimizerResults};
import {cardGrowthLabel} from './card-growth-labels.mjs';
import {requestTeamSave,openTeamWorkspace} from './shared-team-context.mjs';
import {planningUiText} from './team-planning-translations.mjs';
import {createRecommendationTeamView} from './recommendation-team-view.mjs';
import {scoreComposition} from './score-visuals.mjs';
import {scoringScenarioSearch} from './scoring-rules/scenario-search.mjs';
import {toolRoute} from './tool-route.mjs';
const ui=text=>planningUiText(text,typeof document==='undefined'?'zh-CN':document.documentElement.lang);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=ui(text);if(cls)n.className=cls;return n;};
const number=n=>n==null?'—':n.toLocaleString(undefined,{maximumFractionDigits:2});
function trainingDescription(change,workbench) {
  const kind=change.type??change.kind??(String(change.id).startsWith('support')?'support':'member');
  const card=workbench.cardFor?.(kind,change.id),name=change.name??card?.shortLabel??change.id;
  const fields=Array.isArray(change.fields)?change.fields:Object.entries(change.fields??change.changes??{}).map(([field,values])=>({field,...values}));
  return `${name}：${fields.map(item=>`${cardGrowthLabel(item.field,kind,typeof document==='undefined'?'zh-CN':document.documentElement.lang)} ${item.from??ui('未记录')} → ${item.to??'—'}`).join('，')}`;
}
/** @param {import("./calculation/optimizer-ui-types.ts").OptimizerWorkbench} workbench
 * @param {import("./calculation/optimizer-types.ts").OptimizerCandidate[]} results
 * @param {{mode?: import("./calculation/optimizer-types.ts").CalculationMode, objective?: import("./calculation/optimizer-types.ts").CalculationObjective, live?: boolean, target?: HTMLElement}} options */
export function renderOptimizerResults(workbench,results,{mode,objective,live=false,target}={}) {
  const root=target??workbench.querySelector('[data-pairing-results]');clearOptimizerResults(workbench,root);
  workbench.querySelector('[data-results-empty]').hidden=Boolean(results.length);
  const candidates=visibleRecommendations(results),tabs=el('div',null,'task-candidate-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','推荐候选');if(candidates.length>1)root.append(tabs);const rows=[],buttons=[];
  for(const [i,result] of candidates.entries()) {
    const row=el('li',null,'recommendation'),direction=result.direction;
    const planning=result.planning;
    mountRecommendationOverview(workbench,root,row,{result,mode,objective,live,index:i,
      scenarioLabel:recommendationScenarioLabel(result),locale:document.documentElement.lang,
      trainingDescriptions:(planning?.trainingChanges??[]).map(change=>trainingDescription(change,workbench)),
      createTeamView:()=>createRecommendationTeamView(workbench,result.draft,{hideGrowthNote:true,mode,scenario:result.scenario,conditionsOnly:objective==='formation_power',summary:result})});

    const actions=el('div',null,'recommendation-actions'),apply=el('button','编辑队伍');apply.type='button';
    apply.addEventListener('click',()=>{workbench.draft=structuredClone(result.draft);workbench.planningScenarios?.restore();workbench.commit();openTeamWorkspace('editor');});actions.append(apply);
    const save=el('button','保存队伍','team-save-result');save.type='button';
    save.addEventListener('click',()=>requestTeamSave(result.draft,`${recommendationScenarioLabel(result)} · ${direction?.label??`${mode==='gekisou'?'激奏':'普通'}方案 ${i+1}`}`));actions.append(save);
    if(planning?.trainingChanges?.length){const adjust=el('button','修改培养目标');adjust.type='button';adjust.addEventListener('click',()=>{workbench.dispatchEvent(new CustomEvent('calculator-edit-planning'));});actions.append(adjust);}
    if(objective!=='formation_power'){
      const link=el('a','分数明细');link.href=toolRoute(`/tools/song-calculator/${scoringScenarioSearch(result.draft,mode,result.scenario)}`,window.location.pathname);actions.append(link);
    }
    row.append(actions);
    const detail=el('details',null,'recommendation-details');detail.append(el('summary','计算详情'));
    // Expensive skill and chart views are created only when requested.
    detail.addEventListener('toggle',()=>{
      if(!detail.open||detail.dataset.loaded)return;detail.dataset.loaded='true';
      if(direction?.tradeoff)detail.append(el('p',direction.tradeoff));
      detail.append(el('p',`目标值 ${number(result.value)}`));
      if(direction?.reason)detail.append(el('p',direction.reason));
      if(result.performanceSummary)detail.append(el('p',typeof result.performanceSummary==='string'?result.performanceSummary:result.performanceSummary.label??''));
      if(result.sections?.length)detail.append(scoreComposition(result.sections,result.expectedScore));
      if(objective!=='formation_power')detail.append(el('p',`综合力 ${number(result.power)} · 本次比较范围 ${number(result.minimumScore)} – ${number(result.maximumScore)} 分`,'recommendation-caption'));
      if(result.scoreDistribution)detail.append(el('p',`较低一成位置的分数 ${number(result.scoreDistribution.p10)} · 共 ${result.scoreDistribution.count} 次比较；不是实战保底。`,'recommendation-caption'));
      if(result.comparison&&!planning?.missingActual){const c=result.comparison;detail.append(el('p',`相对当前养成方案：综合力 ${number(c.powerChangePercent)}%，目标分数 ${number(c.scoreChangePercent)}%。这是整队替换后的变化。`));}
      if(result.sections){
        detail.append(el('p',`名次奖励占总分 ${number(result.rankingBonusShare*100)}% · ${result.sampleCount} 次模拟 · 抽样标准误 ${number(result.standardError)}（不含模型误差）`));
        const table=el('table'),head=el('tr');for(const label of ['激奏段','任务累计','音符分','平均名次','奖励','占整曲']){const th=el('th',label);th.scope='col';head.append(th);}table.append(head);
        for(const s of result.sections){const tr=el('tr');for(const value of [`${s.index} ${['','COMBO','LUCK','JUST'][s.missionType]}`,number(s.missionType===1?s.combo:s.missionType===2?s.luckPoints:s.just),number(s.noteScore),number(s.rank),number(s.rankingBonus),`${number(s.share*100)}%`])tr.append(el('td',value));table.append(tr);}const wrap=el('div',null,'calculator-table-scroll');wrap.tabIndex=0;wrap.setAttribute('aria-label','激奏分段得分，可横向滚动');wrap.append(table);detail.append(wrap);
      }
      const names={member:'成员',support:'留影',typeLink:'属性连携',musicType:'歌曲属性',musicTag:'擅长歌曲',leader:'队长',bandItem:'乐器',bandItems:'乐器',characterRank:'角色评级',characterTotalRank:'总评级',tgw:'TGW'},dl=el('dl',null,'recommendation-power');
      for(const [key,value] of Object.entries(result.breakdown??{})){if(key==='memory')continue;const item=el('div');item.append(el('dt',names[key]??key),el('dd',number(value.total)));dl.append(item);}detail.append(dl);
    });
    row.append(detail);root.append(row);rows.push(row);row.hidden=i!==0;const tab=el('button',direction?.label??(i?'另一种配对':'推荐方案'));tab.type='button';tab.setAttribute('aria-pressed',String(i===0));tab.addEventListener('click',()=>{rows.forEach((r,j)=>r.hidden=j!==i);buttons.forEach((b,j)=>b.setAttribute('aria-pressed',String(j===i)));});buttons.push(tab);tabs.append(tab);
  }
}
