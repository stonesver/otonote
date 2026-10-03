import {teamLineup,scoreComposition} from './score-visuals.mjs';
import {scoringScenarioSearch} from './scoring-rules/scenario-search.mjs';
import {toolRoute} from './tool-route.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const number=n=>n==null?'—':n.toLocaleString(undefined,{maximumFractionDigits:2});
export function renderOptimizerResults(workbench,results,{mode,objective,live=false}={}) {
  const root=workbench.querySelector('[data-pairing-results]');root.replaceChildren();
  workbench.querySelector('[data-results-empty]').hidden=Boolean(results.length);
  for(const [i,result] of results.entries()) {
    const row=el('li',null,'recommendation');
    const header=el('div',null,'recommendation-heading');
    header.append(el('span',i?`备选 ${i+1}`:live?'当前最佳 · 搜索中':'推荐编成','recommendation-label'),
      el('span',mode==='gekisou'?'激奏 · 条件模拟':'普通自由演出','recommendation-mode'));
    row.append(header);
    const score=el('div',null,'recommendation-score');
    score.append(el('strong',number(result.value)),el('span',objective==='formation_power'?'综合能力':objective==='expected_song_score'?'AP 平均分':objective==='minimum_song_score'?'最低分情景':'最高分情景'));
    if(result.delta!=null)score.append(el('em',`${result.delta>=0?'+':''}${number(result.delta)} 较原队`,result.delta>=0?'is-positive':'is-negative'));
    row.append(score);
    row.append(teamLineup(workbench,result.draft));
    if(result.sections?.length)row.append(scoreComposition(result.sections,result.expectedScore));
    if(objective!=='formation_power')row.append(el('p',`综合力 ${number(result.power)} · ${mode==='gekisou'?'抽样':'技能顺序'}范围 ${number(result.minimumScore)} – ${number(result.maximumScore)}`,'recommendation-caption'));
    if(result.scoreDistribution)row.append(el('p',`${result.scoreDistribution.kind==='seed_samples'?'样本':'技能顺序'} P10 ${number(result.scoreDistribution.p10)} 分 · ${result.scoreDistribution.count} 次 · 条件估算，非实战保底`,'recommendation-caption'));
    const actions=el('div',null,'recommendation-actions'),apply=el('button','应用这支队伍');apply.type='button';
    // Applying changes the input and invalidates any active search.
    apply.addEventListener('click',()=>{workbench.draft=structuredClone(result.draft);workbench.commit();workbench.dispatchEvent(new CustomEvent('calculator-edit-team'));workbench.querySelector('#team-editor')?.scrollIntoView({block:'start',behavior:'auto'});});actions.append(apply);
    const save=el('button','保存这支队伍');save.type='button';
    save.addEventListener('click',()=>workbench.dispatchEvent(new CustomEvent('save-preset-candidate',{detail:{draft:result.draft,name:`${mode==='gekisou'?'激奏':'普通'}推荐 ${i+1}`,onSaved:()=>{save.textContent='已保存，可在比较队伍中查看';},onError:message=>{save.textContent=message;}}})));actions.append(save);
    if(objective!=='formation_power'){
      const link=el('a','查看分数明细 →');link.href=toolRoute(`/tools/song-calculator/${scoringScenarioSearch(result.draft,mode,result.scenario)}`,window.location.pathname);actions.append(link);
    }
    row.append(actions);
    const detail=el('details',null,'recommendation-details');detail.append(el('summary','为什么推荐这支队伍？'));
    if(result.comparison){const c=result.comparison;detail.append(el('p',`相对原队：综合力 ${number(c.powerChangePercent)}%，目标分数 ${number(c.scoreChangePercent)}%。这是整队替换后的净变化。`));}
    if(result.sections){
      detail.append(el('p',`名次奖励占总分 ${number(result.rankingBonusShare*100)}% · ${result.sampleCount} 次模拟 · 抽样标准误 ${number(result.standardError)}（不含模型误差）`));
      const table=el('table'),head=el('tr');for(const label of ['激奏段','任务累计','音符分','平均名次','奖励','占整曲'])head.append(el('th',label));table.append(head);
      for(const s of result.sections){const tr=el('tr');for(const value of [`${s.index} ${['','COMBO','LUCK','JUST'][s.missionType]}`,number(s.missionType===1?s.combo:s.missionType===2?s.luckPoints:s.just),number(s.noteScore),number(s.rank),number(s.rankingBonus),`${number(s.share*100)}%`])tr.append(el('td',value));table.append(tr);}const wrap=el('div',null,'calculator-table-scroll');wrap.append(table);detail.append(wrap);
    }
    const names={member:'成员',support:'留影',typeLink:'属性连携',musicType:'歌曲属性',musicTag:'擅长歌曲',leader:'队长',bandItem:'乐器',characterRank:'角色等级',characterTotalRank:'总等级',tgw:'TGW',memory:'回忆'},dl=el('dl',null,'recommendation-power');
    for(const [key,value] of Object.entries(result.breakdown??{})){const item=el('div');item.append(el('dt',names[key]??key),el('dd',number(value.total)));dl.append(item);}detail.append(dl);row.append(detail);
    if(i){const content=el('details',null,'recommendation-alternative');content.append(el('summary',`备选 ${i+1} · ${number(result.value)} 分`));while(row.firstChild)content.append(row.firstChild);row.append(content);}
    root.append(row);
  }
}
