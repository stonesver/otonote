import {setupTeamPlanningScenarios} from './team-planning-scenario-ui.mjs';
import {resolveSearchInput} from './scoring-rules/formation-input.mjs';
import {summarizeSearchSpace,formatCombinationCount,readOptimizerConstraints} from './optimizer-search-summary.mjs';
import {optimizerReadiness,recommendedWorkerCount,searchEvaluationBudget} from './optimizer-guidance.mjs';
import {renderOptimizerResults} from './optimizer-results-ui.mjs';
import { readGekisouOpponentInputs } from './gekisou-opponent-inputs.mjs';
import {setupInventoryEditor} from './inventory-editor-ui.mjs';
import { createFormationCalculator } from './scoring-rules/formation-power.mjs';
const format = n => n == null ? '—' : n.toLocaleString(undefined, {maximumFractionDigits: 2});
function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)], {type:'application/json'}));
  const a = document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function setupInventoryOptimizer(workbench) {
  const q = s => workbench.querySelector(s), rules=workbench.data.formalRules;
  if(!q('[data-optimize-pairing]')) return null;
  const calculator=createFormationCalculator(rules);
  let worker, request=0, checkpoint, lastResult, activeMethod, scenarios;
  const progress=q('[data-pairing-progress]');
  const editor=setupInventoryEditor(workbench,{
    onChange:()=>{scenarios?.refreshInventory();invalidate();workbench.dispatchEvent(new CustomEvent('preset-inventory-changed'));progress.textContent='卡库已更新，请重新搜索。';},
    onUse:()=>{q('[data-search-scope]').value='owned';invalidate();workbench.dispatchEvent(new CustomEvent('calculator-use-inventory'));q('[data-calculator-guidance]').scrollIntoView({block:'center'});}
  });
  scenarios=setupTeamPlanningScenarios(workbench,{getInventory:()=>editor.inventory,onChange:()=>{invalidate();progress.textContent='条件已更新，请重新比较。';}});
  workbench.planningScenarios=scenarios;
  function publish(extra={}) {workbench.optimizerState={...workbench.optimizerState,...extra};workbench.dispatchEvent(new CustomEvent('optimizer-ui-state',{detail:workbench.optimizerState}));}
  function stop() {publish({running:false});q('[data-search-state]').dataset.running='false';request++;worker?.terminate();worker=null;q('[data-optimize-pairing]').disabled=false;q('[data-cancel-pairing]').disabled=true;}
  function guide() {
    scenarios?.sync();
    let inventory=editor.inventory;
    if(scenarios?.kind==='trial'){
      try {const s=scenarios.read().planningScenario;inventory={...inventory,memberCardIds:[...new Set([...inventory.memberCardIds,...(s.selectedCardIds?.memberCardIds??[]),...s.trialCardIds.memberCardIds])],supportCardIds:[...new Set([...inventory.supportCardIds,...(s.selectedCardIds?.supportCardIds??[]),...s.trialCardIds.supportCardIds])]};}catch{}
    }
    const state=optimizerReadiness({draft:workbench.draft,scope:q('[data-search-scope]').value,inventory,objective:q('[data-pairing-objective]').value,
      characterFor:id=>calculator.card(id,'member')._characterID});
    try {scenarios?.read();} catch(error){state.ready=false;state.message=error.message;}
    let space=null;
    if(state.ready) {
      try {
        const draft=structuredClone(workbench.draft);
        if(q('[data-search-scope]').value==='owned')draft.modifiers.growth={...draft.modifiers.growth,...inventory.growth};
        const input=resolveSearchInput(rules,draft,{scope:q('[data-search-scope]').value,inventory:editor.inventory,planningScenario:scenarios?.read().planningScenario,constraints:readOptimizerConstraints(workbench)});
        space=summarizeSearchSpace(rules,input);
      }catch(error){state.ready=false;state.message=error.message;}
    }
    q('[data-search-space]').textContent=space
      ?`本次候选：${space.members} 张成员（${space.characters} 个角色）＋ ${space.supports} 张留影。包含配对与队长选择，组合规模最多 ${formatCombinationCount(space.combinations)} 种；筛选成员乐队不会同时筛掉其他留影。${q('[data-pairing-mode]').value==='gekisou'?'激奏还会比较站位。':''}`
      :'选好歌曲和卡片范围后，这里会说明本次比较哪些卡。';
    q('[data-calculator-guidance]').textContent=state.message;
    q('[data-calculator-guidance]').dataset.ready=String(state.ready);
    q('[data-optimize-pairing]').disabled=Boolean(worker)||!state.ready;
    q('[data-inventory-scope-note]').textContent=q('[data-search-scope]').value==='owned'
      ?`已保存 ${inventory.memberCardIds.length} 张成员、${inventory.supportCardIds.length} 张留影。展开下方卡库修改养成。`
      :q('[data-search-scope]').value==='theoretical'?'无需手动选卡。参考卡片按满养成搜索，账号加成单独设置。':'只比较下方选中的成员与留影；不会自动加入其他卡。';
    publish({...state,hasResults:Boolean(lastResult?.results.length),finished:Boolean(lastResult),running:Boolean(worker),space});
  }
  function invalidate() {stop();q('[data-practical-progress]').replaceChildren();q('[data-practical-progress]').hidden=true;q('[data-practical-summary]').hidden=true;checkpoint=null;lastResult=null;q('[data-resume-pairing]').disabled=true;q('[data-export-pairing]').disabled=true;q('[data-pairing-results]').replaceChildren();q('[data-results-empty]').hidden=false;q('[data-search-state]').textContent='等待开始';guide();}

  q('[data-pairing-mode]').addEventListener('change',()=>{q('[data-gekisou-settings]').hidden=q('[data-pairing-mode]').value!=='gekisou';if(q('[data-gekisou-rank-note]'))q('[data-gekisou-rank-note]').hidden=q('[data-pairing-mode]').value!=='gekisou';});
  for(const selector of ['[data-search-scope]','[data-pairing-objective]','[data-search-constraints]','[data-search-band]','[data-search-attribute]','[data-search-support-attribute]','[data-pairing-mode]','[data-gekisou-settings]','[data-planning-window-limit]','[data-planning-variant-limit]'])q(selector).addEventListener('change',()=>{invalidate();q('[data-pairing-results]').replaceChildren();progress.textContent='输入已更新，请重新搜索。';});
  q('[data-cancel-pairing]').addEventListener('click',()=>{worker?.postMessage({type:'cancel'});q('[data-cancel-pairing]').disabled=true;progress.textContent=activeMethod==='practical'?'正在停止；未完成的阶段不会标记完成，已完成的精算结果会保留。':'正在暂停；搜索阶段的进度会保留在本页…';});
  q('[data-export-pairing]').addEventListener('click',()=>{if(lastResult)download('otonote-pairing-result.json',lastResult);});
  async function run(resume=false) {
    stop();const current=request;const previous=resume?checkpoint:null;checkpoint=null;q('[data-resume-pairing]').disabled=true;q('[data-export-pairing]').disabled=true;
    q('[data-pairing-results]').replaceChildren();
    try {
      const settings=scenarios?.persist()??{};
      const scope=q('[data-search-scope]').value,objective=q('[data-pairing-objective]').value;
      const mode=q('[data-pairing-mode]').value,gekisouScenario={
        frameRate:Number(q('[data-gekisou-fps]').value),opponents:readGekisouOpponentInputs(workbench),
        timingOffsetMs:Number(q('[data-gekisou-offset]').value),batches:Number(q('[data-gekisou-batches]').value),seed:Number(q('[data-gekisou-seed]').value),
        ranks:[...workbench.querySelectorAll('[data-gekisou-rank]')].map(n=>Number(n.value))};
      activeMethod=q('[data-search-effort]').value==='practical'?'practical':'complete';
      q('[data-practical-progress]').replaceChildren();q('[data-practical-progress]').hidden=activeMethod!=='practical';q('[data-practical-summary]').hidden=true;
      q('[data-cancel-pairing]').textContent=activeMethod==='practical'?'停止本次推荐':'暂停搜索';
      const maxEvaluations=searchEvaluationBudget(q('[data-search-effort]').value,q('[data-search-budget]').value);
      const inventory=editor.validate(editor.inventory);
      const constraints=readOptimizerConstraints(workbench),draft=structuredClone(workbench.draft);
      if(scope==='owned')draft.modifiers.growth={...draft.modifiers.growth,...inventory.growth};
      q('[data-optimize-pairing]').disabled=true;progress.textContent='准备计算…';q('[data-search-state]').textContent='正在寻找更好的编成';q('[data-search-state]').dataset.running='true';publish({running:true,finished:false});
      let chart;
      if(objective!=='formation_power') {
        const summary=workbench.data.charts?.find(c=>c.trackId===draft.selectedSongId&&c.difficulty===draft.selectedDifficulty);
        if(!summary?.analysisDataUrl)throw new Error('请先选择歌曲和难度');
        const response=await fetch(summary.analysisDataUrl);if(!response.ok)throw new Error('谱面加载失败');
        chart={...await response.json(),sourceReleaseId:rules.sourceReleaseId};if(current!==request)return;
      }
      worker=new Worker(new URL('./production-optimizer-worker.mjs',import.meta.url),{type:'module'});q('[data-cancel-pairing]').disabled=false;
      worker.onerror=()=>{stop();progress.textContent='后台计算失败，请重试。';publish({finished:true});};
      worker.onmessage=({data})=>{
        if(data.requestId!==current||request!==current)return;
        if(data.type==='error'){stop();progress.textContent=data.error;publish({finished:true});return;}
        if(data.type==='progress') {
          const p=data.progress;
          if(p.phase==='planning'){progress.textContent=p.message??`已比较 ${p.completed} 组培养范围`;return;}
          if(p.phase==='practical'){
            progress.textContent=`${p.stage} · ${p.completed}/${p.total}`;
            const stages=q('[data-practical-progress]');stages.replaceChildren();
            for(const stage of p.stages){const item=document.createElement('li');item.dataset.complete=String(stage.total!=null&&stage.completed===stage.total);item.textContent=`${stage.label}：${stage.total==null?'待开始':`${stage.completed} / ${stage.total}`}`;stages.append(item);}return;
          }
          if(p.phase==='practical-result'){if(p.bestCandidate)renderOptimizerResults(workbench,[p.bestCandidate],{mode,objective,live:true});return;}

          if(p.phase==='fallback'){progress.textContent=p.message;return;}
          progress.textContent=p.phase==='search'?`已比较 ${p.completed} 组 · 当前最佳 ${format(p.best)}`:p.phase==='placements'?`正在比较候选站位 ${p.completed}/${p.total}`:`准备${p.phase==='pair_weights'?'卡片配对':'队长加成'} ${p.completed}/${p.total}`;
          if(p.phase==='search')q('[data-search-diagnostics]').textContent=`已评估 ${p.completed} 组，待排查分支 ${format(p.frontier)}，剩余上界 ${format(p.upperBound)}，并行任务 ${p.concurrency}。分支会继续拆分，这不是剩余计算次数。`;
          if(p.bestCandidate)renderOptimizerResults(workbench,[p.bestCandidate],{mode,objective,live:true});
          return;
        }
        if(data.type!=='result')return;
        stop();lastResult=data.result;checkpoint=data.result.checkpoint;q('[data-resume-pairing]').disabled=!checkpoint;q('[data-export-pairing]').disabled=false;
        const r=data.result;
        progress.textContent=`${r.optimality==='proven_within_model'?'已证明当前规则与范围内最优':r.optimality==='best_within_simulation'?'搜索完成：当前模拟情景及抽样下最佳，非实战最优保证':r.optimality==='infeasible'?'当前约束下不存在合法队伍':'搜索未完成，以下是目前最佳候选'}；已比较 ${r.evaluated} 组。`;
        if(r.searchMethod==='planning'){
          progress.textContent=r.status==='completed'?'本次比较完成，可查看不同方向的搭配。':r.status==='cancelled'?'已停止，下面保留已经算完的方案。':'本轮比较完成；仍有部分培养组合未检查。可以限定愿意培养的卡后再比较。';
          const summary=q('[data-practical-summary]');summary.hidden=false;summary.textContent=`已检查 ${r.planning?.completedVariants??0} 组养成范围${r.planning?.truncated?'；未检查全部组合':''}。结果只代表本次已检查的方案。`;
          q('[data-search-diagnostics]').textContent=(r.planning?.excludedCardIds?.length?`有 ${r.planning.excludedCardIds.length} 张卡因养成资料缺失未参与。`:'')+(r.planning?.totalVariants?` 培养范围组合共 ${r.planning.totalVariants} 组。`:'');
        }
        if(r.searchMethod==='practical'){
          progress.textContent=r.status==='completed'?'实用推荐的固定阶段已完成；这是已检查候选中的较好队伍，不代表全局最优。':'实用推荐已停止，部分阶段尚未完成。';
          const summary=q('[data-practical-summary]');summary.hidden=false;
          summary.textContent=`检查 ${r.practical.neighbourChecks} 个合法换卡／配对方案（特征粗筛），快速模拟 ${r.practical.screened} 队，完整复算 ${r.practical.finalists} 队。`;
          if(r.closeness?.kind==='close')summary.textContent+=' 前两名分差处于抽样误差范围内，视为接近，不建议仅凭这次分差换卡。';
          if(r.closeness?.kind==='unknown')summary.textContent+=' 当前抽样不足以估计前两名差距的稳定性。';
          q('[data-search-diagnostics]').textContent=(r.practical.directions??[]).map(d=>`${d.label}：${d.status==='generated'?'已生成起点':'受持卡或约束限制，未生成'}`).join('；');
        }
        if(!r.results.length)progress.textContent+=r.status==='cancelled'?' 尚未完成任何队伍的精算；请重新开始。':' 未找到满足约束的队伍。';
        if(!['practical','planning'].includes(r.searchMethod))q('[data-search-diagnostics]').textContent=`剩余上界 ${format(r.upperBound)}，与当前最佳差 ${format(r.optimalityGap)}；待排查分支 ${r.checkpoint?.frontier?.length??0}。`;
        q('[data-search-limits]').textContent=(r.warnings??[]).join(' ');
        renderOptimizerResults(workbench,r.results,{mode,objective});
        q('[data-search-state]').textContent=r.status==='completed'?(r.searchMethod==='practical'?'实用检查完成':'搜索完成'):r.status==='cancelled'?(r.searchMethod==='practical'?'已停止':'已暂停'):'本轮已完成，可继续深入';
        q('[data-search-state]').dataset.running='false';
        guide();

      };
      worker.postMessage({type:'optimize',requestId:current,payload:{...settings,variantLimit:Number(q('[data-planning-variant-limit]')?.value??24),maxWindowCards:Number(q('[data-planning-window-limit]')?.value??5),searchMethod:activeMethod,topN:3,concurrency:recommendedWorkerCount(navigator.hardwareConcurrency),rules,draft,scope,inventory,constraints,objective,mode,gekisouScenario,chart,maxEvaluations,checkpoint:previous}});
    }catch(error){if(current!==request)return;stop();progress.textContent=error.message;publish({finished:true});}
  }
  q('[data-optimize-pairing]').addEventListener('click',()=>run());q('[data-resume-pairing]').addEventListener('click',()=>run(true));
  function updateEffort() {
    const preset=q('[data-search-effort]').value,budget=q('[data-search-budget]');
    budget.disabled=preset==='complete'||preset==='practical';
    if(preset!=='custom'&&preset!=='complete'&&preset!=='practical')budget.value=preset;
    q('[data-optimize-pairing]').textContent=preset==='practical'?'生成实用推荐':'开始寻找配队';
    q('[data-search-effort-note]').textContent=preset==='practical'?'按固定阶段完成，不按时间停止：技能特征粗筛、10 种顺序快速模拟，最多 6 队完整复算（120 种顺序；LUCK 至少 2 批）。按所选养成与发挥比较；不穷举全部技能组合或站位，不保证最优。':preset==='complete'
      ?'不限组数，直到找到当前规则与筛选范围内的最佳配法。全卡库可能需要很久；可暂停续算，刷新或关闭页面会丢失进度。激奏仍受模拟条件与抽样限制。'
      :'只比较本轮指定数量的候选，不保证全局最优。可以随时切换完整搜索，再点“继续搜索”沿用当前进度。';
  }
  q('[data-search-effort]').addEventListener('change',updateEffort);
  q('[data-search-budget]').addEventListener('change',()=>{q('[data-search-effort]').value='custom';updateEffort();});
  updateEffort();
  guide();
  return {invalidate};
}
