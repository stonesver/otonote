import {optimizerReadiness} from '../src/lib/optimizer-guidance.mjs';
import {planningSearchStatus} from '../src/lib/inventory-optimizer-ui.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planningUiText,translateTeamPlanningText,translatePlanningSubtree} from '../src/lib/team-planning-translations.mjs';
import {translateUiText} from '../src/lib/ui-text-localizer.ts';
import {localizeHtmlWithStats} from '../src/lib/html-localizer.ts';
import {planningObjectiveForGoal} from '../src/lib/team-planning-scenario-ui.mjs';
test('all static text in the scenario form has an English translation',()=>{
  const source=readFileSync(new URL('../src/components/TeamPlanningScenario.astro',import.meta.url),'utf8');
  for(const match of source.matchAll(/>([^<>{}]+)</g)){
    const text=match[1].trim();if(!/[\u4e00-\u9fff]/.test(text))continue;
    assert.notEqual(translateTeamPlanningText(text),text,`Missing translation: ${text}`);
  }
});
test('build and dynamic scenario labels use the same English and preserve Chinese',()=>{
  const chinese='看看练好后怎么配';
  assert.equal(planningUiText(chinese,'zh-CN'),chinese);
  assert.equal(planningUiText(chinese,'en'),'Plan card upgrades');
  assert.equal(translateUiText(chinese),'Plan card upgrades');
  const html=`<label>${chinese}<input placeholder="卡名、角色或乐队"></label>`;
  assert.match(localizeHtmlWithStats(html,'en').html,/Plan card upgrades/);
  assert.match(localizeHtmlWithStats(html,'en').html,/Card, character, or band name/);
  assert.equal(localizeHtmlWithStats(html,'zh-CN').html,html);
});
test('dynamic training assumptions and limits translate without translating card names',()=>{
  assert.equal(translateTeamPlanningText('培养计划 · 最多练 2 张 · 保持突破、觉醒'),'Upgrade plan · at most 2 cards · keep breakthroughs and awakening');
  assert.equal(translateTeamPlanningText('这套队伍需要练好 2 张卡'),'This team needs 2 card upgrades');
  assert.equal(translateTeamPlanningText('春日影'),'春日影');
});
test('restored recommendation goals choose consistent score objectives',()=>{
  assert.equal(planningObjectiveForGoal('stable'),'minimum_song_score');
  assert.equal(planningObjectiveForGoal('score'),'expected_song_score');
  assert.equal(planningObjectiveForGoal('missions'),'expected_song_score');
});

test('preset controls have English copy and preserve entity text during explicit subtree translation',()=>{
  const source=readFileSync(new URL('../src/components/PresetPortfolio.astro',import.meta.url),'utf8');
  for(const match of source.matchAll(/>([^<>{}]+)</g)){
    const text=match[1].trim();if(!/[\u4e00-\u9fff]/.test(text))continue;
    assert.notEqual(translateTeamPlanningText(text),text,`Missing preset translation: ${text}`);
  }
  assert.equal(translateTeamPlanningText('按当前场景生成候选'),'Generate candidates for this scenario');
  const text=value=>({nodeType:3,nodeValue:value});
  const element=(children,skip=false)=>({nodeType:1,childNodes:children,matches:()=>skip});
  const label=text('  按当前场景生成候选  '),entity=text('当前养成'),code=text('当前养成');
  const root=element([label,element([entity],true),element([code],true)]);
  assert.equal(translatePlanningSubtree(root,'zh-CN'),0);
  assert.equal(translatePlanningSubtree(root,'en'),1);
  assert.equal(label.nodeValue,'  Generate candidates for this scenario  ');
  assert.equal(entity.nodeValue,'当前养成');assert.equal(code.nodeValue,'当前养成');
  assert.equal(translatePlanningSubtree(root,'en'),0);
});
test('preset messages keep embedded song and user names intact',()=>{
  assert.equal(translateTeamPlanningText('首曲对比：春日影 · 我的队伍'),'First-song comparison: 春日影 · 我的队伍');
  assert.equal(translateTeamPlanningText('试用卡 · 培养计划 · 2 张卡'),'Trial cards · Upgrade plan · 2 cards');
  assert.equal(translateTeamPlanningText('本次比较：春日影 · EXPERT。与页面上方选歌保持同步。'),'Comparing: 春日影 · EXPERT. Synced with the song selection above.');
});

test('bounded planning and cancellation never advertise resumable exhaustive searches',()=>{
  assert.equal(planningSearchStatus({status:'budget_exhausted'}),'部分组合尚未比较');
  assert.equal(planningSearchStatus({status:'cancelled'}),'已停止');
  assert.equal(planningSearchStatus({status:'completed'}),'本次比较完成');
  const source=readFileSync(new URL('../src/components/TeamDraftWorkbench.astro',import.meta.url),'utf8');
  const effort=source.match(/<select data-search-effort[^>]*>(.*?)<\/select>/s)?.[1];
  assert.ok(effort);assert.doesNotMatch(effort,/value="complete"|value="custom"|value="20"/);
  assert.match(source, /data-resume-pairing hidden disabled/);
});

test('main journey controls and runtime readiness remain English after updates',()=>{
  const controls=['帮我配一队','比较队伍 / 换卡','选择歌曲与难度','用哪些卡来配？','这次想打普通，还是激奏？','普通自由演出','激奏演出','账号加成：乐器、角色评级与 TGW','限定乐队、属性或调整目标（可选）','比较这首歌的出分','推荐编成','等待开始','搜索详情与计算条件','配队攻略与计算说明'];
  for(const label of controls)assert.doesNotMatch(planningUiText(label,'en'),/[\u4e00-\u9fff]/,label);
  const empty={slots:Array.from({length:5},()=>({}))};
  const waiting=optimizerReadiness({draft:empty,locale:'en'});assert.equal(waiting.ready,false);assert.match(waiting.message,/Choose a song/);
  const owned=optimizerReadiness({draft:{...empty,selectedSongId:'song',selectedDifficulty:'expert'},scope:'owned',inventory:{memberCardIds:[],supportCardIds:[]},locale:'en'});assert.doesNotMatch(owned.message,/[\u4e00-\u9fff]/);assert.match(owned.message,/reference teams/);
  for(const status of ['卡库已更新，请重新搜索。','准备计算…','正在寻找更好的编成','准备卡片与技能 · 1/5','完整复算领先队伍：待开始',' 未找到满足约束的队伍。'])assert.doesNotMatch(planningUiText(status,'en'),/[\u4e00-\u9fff]/,status);
});
