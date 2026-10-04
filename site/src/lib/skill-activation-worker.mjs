import {createFormalSongCalculator} from './scoring-rules/formal-song-score.mjs';
import {createGekisouSongCalculator} from './scoring-rules/gekisou-song-score.mjs';
import {createFormalSkillResolver} from './scoring-rules/formal-skills.mjs';
import {createEventEfficiency} from './scoring-rules/event-efficiency.mjs';
import {calculateSongSkillReplay} from './song-skill-replay.mjs';
import {checkedJson} from '../runtime/content.mjs';
import {createScenarioSongCalculator} from '../../../packages/scoring/scoring-rules/performance-scenario-calculator.mjs';

self.addEventListener('message', async ({data}) => {
  try {
    let {rules, chart, draft, mode, eventId, scenario, ranking} = data;
    if (ranking) {
      const source = ranking.replaySource;
      const [r, c] = await Promise.all([checkedJson(source.rules.url, source.rules.sha256), checkedJson(source.chart.url, source.chart.sha256)]);
      if (r.sourceReleaseId !== source.releaseId || c.sourceReleaseId && c.sourceReleaseId !== source.releaseId || c.id !== ranking.sourceId
        || c.trackId !== ranking.trackId.replace(/^(global|jp)--/, '') || c.difficulty !== ranking.difficulty) throw Error('谱面或规则版本不一致');
      if (mode === 'gekisou') {
        const profile = ranking.benchmark;
        const result = createGekisouSongCalculator(r, {...c,sourceReleaseId:source.releaseId}, {scenario: profile.scenario, referenceProfile:profile})
          .calculate({selectedSongId:c.trackId, selectedDifficulty:c.difficulty, modifiers:{}}, {includeTrace:true});
        self.postMessage({result}); return;
      }
      self.postMessage({result:calculateSongSkillReplay({rules:r,chart:{...c,sourceReleaseId:source.releaseId},skills:ranking.skills,power:ranking.benchmark.power,frameRate:ranking.frameRate,includeTrace:true})}); return;
    }
    if (!chart && draft?.selectedSongId && !data.conditionsOnly) throw Error('未找到对应谱面，无法生成发动记录');
    if (!chart) { self.postMessage({result:{skills:createFormalSkillResolver(rules)(draft)}}); return; }
    if (!chart.notes) {
      const response = await fetch(chart.analysisDataUrl);
      if (!response.ok) throw Error('谱面读取失败，请重试');
      const raw = await response.json();
      if (raw.trackId !== draft.selectedSongId || raw.difficulty !== draft.selectedDifficulty || raw.sourceReleaseId && raw.sourceReleaseId !== rules.sourceReleaseId) throw Error('谱面与队伍或版本不一致');
      chart = {...raw, sourceReleaseId:rules.sourceReleaseId};
    }
    draft.modifiers ??= {};
    let eventAdapters = [];
    if (mode === 'challenge') {
      const model = createEventEfficiency({tables:rules.tables,sourceReleaseId:rules.sourceReleaseId,eventId});
      draft.modifiers.event = {id:eventId, sourceReleaseId:rules.sourceReleaseId};
      eventAdapters = [model.challengeAdapter(rules)];
    } else delete draft.modifiers.event;
    const performanceScenario = draft.modifiers?.performanceScenario;
    const calculator = performanceScenario ? createScenarioSongCalculator(rules,chart,{mode:mode==='gekisou'?'gekisou':'ordinary',performanceScenario,scenario,eventAdapters})
      : mode === 'gekisou' ? createGekisouSongCalculator(rules,chart,{scenario,eventAdapters}) : createFormalSongCalculator(rules,chart,{eventAdapters});
    self.postMessage({result:calculator.calculate(draft,{includeTrace:true})});
  } catch (error) { self.postMessage({error:String(error.message ?? error)}); }
});
