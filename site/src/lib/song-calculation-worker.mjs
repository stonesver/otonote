import {createFormalSongCalculator} from './scoring-rules/formal-song-score.mjs';
import {createGekisouSongCalculator} from './scoring-rules/gekisou-song-score.mjs';
import {createPerformanceSongCalculator} from './scoring-rules/formal-performance-replay.mjs';
import {createScenarioSongCalculator} from '../../../packages/scoring/scoring-rules/performance-scenario-calculator.mjs';
self.addEventListener('message',({data})=>{
  try {
    const performanceScenario=data.performanceScenario??(data.performance?{profile:'explicit',performance:data.performance}:data.draft?.modifiers?.performanceScenario);
    const calculator=performanceScenario?createScenarioSongCalculator(data.rules,data.chart,{mode:data.mode,performanceScenario,scenario:data.scenario}):data.mode==='gekisou'?createGekisouSongCalculator(data.rules,data.chart,{scenario:data.scenario}):data.performance
      ?createPerformanceSongCalculator(data.rules,data.chart,{performance:data.performance}):createFormalSongCalculator(data.rules,data.chart);
    self.postMessage({result:calculator.calculate(data.draft,{includeTrace:true})});
  }catch(error){self.postMessage({error:String(error.message??error)});}
});
