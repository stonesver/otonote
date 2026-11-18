import {optimizeTeamPlanning} from './team-planning-optimizer.mjs';
import {optimizePractical} from './practical-optimizer.mjs';

self.addEventListener('message',async({data:{id,task}})=>{
  try{
    let reportedAt=-Infinity;
    const onProgress=progress=>{
      const now=performance.now();if(now-reportedAt<120)return;reportedAt=now;
      self.postMessage({id,type:'progress',progress});
    };
    const optimize=task.planningScenario||task.performanceScenario?optimizeTeamPlanning:optimizePractical;
    const result=await optimize({...task,onProgress});
    self.postMessage({id,type:'result',result});
  }catch(error){self.postMessage({id,type:'error',message:String(error.message??error)});}
});
