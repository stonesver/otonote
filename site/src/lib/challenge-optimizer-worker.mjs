import {optimizeChallenge} from './challenge-optimizer.mjs';
self.addEventListener('message',async({data})=>{
  try{
    const {analysisDataUrl,...input}=data;
    const response=await fetch(analysisDataUrl,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`谱面加载失败（${response.status}）`);
    const chart=await response.json();
    const result=await optimizeChallenge({...input,chart,onProgress:p=>{
      if(p.phase==='event-exact')self.postMessage({type:'progress',stage:'验证配对与分数上界',completed:p.completed});
      if(p.phase==='practical')self.postMessage({type:'progress',stage:p.stage,completed:p.completed,total:p.total});
    }});
    self.postMessage({type:'result',result});
  }catch(error){self.postMessage({type:'error',message:error.message});}
});
