import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planningUiText,translateTeamPlanningText} from '../src/lib/team-planning-translations.mjs';
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
