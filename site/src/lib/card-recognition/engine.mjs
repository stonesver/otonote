import {MODES,regions,numericValue} from './observations.mjs';
import {isolateGlyphs} from './numeric.mjs';
const runtime=new URL('../recognition/',import.meta.url);
let library;
function loadOCR(){
  return library??=new Promise((resolve,reject)=>{
    const script=document.createElement('script'),timer=setTimeout(()=>fail(),60000);
    const fail=()=>{clearTimeout(timer);script.remove();library=null;reject(Error('数字识别引擎加载失败，请重试'));};
    script.src=new URL('tesseract.min.js',runtime).href;
    script.onload=()=>{clearTimeout(timer);resolve(globalThis.Tesseract);};script.onerror=fail;document.head.append(script);
  });
}
export function createRecognitionEngine({manifest,featuresUrl,onProgress=()=>{},onPreparation=()=>{}}){
  if(!isSecureContext||!globalThis.Worker||!globalThis.OffscreenCanvas||!globalThis.createImageBitmap||!globalThis.DecompressionStream)throw Error('请使用支持本地识别的新版浏览器，通过 HTTPS 访问');
  const controller=new AbortController(),{signal}=controller;
  let worker,ocr,pending,readyResolve,readyReject;
  function bounded(promise,ms=90000){
    return new Promise((resolve,reject)=>{
      let timer;
      const finish=(callback,value)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);callback(value);};
      const abort=()=>finish(reject,Error('已取消'));
      timer=setTimeout(()=>finish(reject,Error('识别超时，请重试或减少图片数量')),ms);
      signal.addEventListener('abort',abort,{once:true});
      promise.then(value=>finish(resolve,value),error=>finish(reject,error));
      if(signal.aborted)abort();
    });
  }
  async function initialize(){
    worker=new Worker(new URL('worker.js',runtime));
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    worker.onmessage=({data})=>{
      if(data.type==='preparation')onPreparation(data);
      if(data.type==='detected'&&pending?.id===data.id){pending.resolve(data);pending=null;}
      if(data.type==='progress')onProgress(data.message);
      if(data.type==='ready')readyResolve();
      if(data.type==='row'&&pending?.id===data.id)pending.rows.push(data);
      if(data.type==='complete'&&pending?.id===data.id){pending.resolve(pending.rows);pending=null;}
      if(data.type==='error'){readyReject(Error(data.message));pending?.reject(Error(data.message));pending=null;}
    };
    worker.onerror=e=>{const error=Error(e.message||'卡面识别引擎异常');readyReject(error);pending?.reject(error);};
    worker.postMessage({type:'init',config:{manifest,featuresUrl}});
    await bounded(ready);
    const Tesseract=await bounded(loadOCR());
    onPreparation({stage:'numbers',label:'加载数字识别模型…'});
    const created=Tesseract.createWorker('eng',1,{workerPath:new URL('worker.min.js',runtime).href,
      corePath:new URL('core/',runtime).href,langPath:new URL('lang/',runtime).href,workerBlobURL:false,logger:m=>onPreparation({stage:'numbers',label:({'loading tesseract core':'加载数字识别引擎…','loading language traineddata':'加载数字模型…','initializing api':'初始化数字识别…'})[m.status]??'准备数字识别…',progress:m.progress}),
      errorHandler:error=>pending?.reject(Error(String(error)))});
    created.then(w=>{if(signal.aborted)w.terminate().catch(()=>{});},()=>{});
    ocr=await bounded(created);
    await bounded(ocr.setParameters({tessedit_char_whitelist:'0123456789',tessedit_pageseg_mode:'7',user_defined_dpi:'300'}));
    onPreparation({stage:'numbers',complete:true});
  }
  async function recognize(file,mode,id,onRow){
    const decoding=createImageBitmap(file);
    decoding.then(bitmap=>{if(signal.aborted)bitmap.close();},()=>{});
    const bitmap=await bounded(decoding);
    let boxes;
    try{
      if(bitmap.width*bitmap.height>20_000_000)throw Error('图片超过 2000 万像素，请缩小后重试');
      boxes=regions(bitmap.width,bitmap.height,mode);
      if(!boxes.length)throw Error('未找到完整卡牌区域，请使用原始列表截图');
    }catch(error){bitmap.close();throw error;}
    const results=await bounded(new Promise((resolve,reject)=>{
      pending={id,resolve,reject,rows:[]};worker.postMessage({type:'recognize',id,bitmap,regions:boxes,kind:MODES[mode].kind},[bitmap]);
    }));
    for(const [index,row] of results.entries()){
      if(signal.aborted)throw Error('已取消');
      onProgress(`${file.name}：读取数字 ${index+1} / ${results.length}`);
      const number=await bounded(readNumber(row.crop,mode,ocr)),kind=MODES[mode].kind;
      onRow({key:`${id}:${index}`,imageName:file.name,index,kind,mode,crop:row.crop,
        cardId:row.match.accepted?row.match.candidates[0].id:'',selected:row.match.accepted,
        observations:{[kind==='member'?'awakeningStars':'supportPetals']:row.badge,[mode==='member-training'?'training':'level']:number.value}});
    }
  }
  async function detect(file,id){
    const bitmap=await bounded(createImageBitmap(file));
    let boxes;
    try{
      if(bitmap.width*bitmap.height>20_000_000)throw Error('图片超过 2000 万像素');
      boxes={member:regions(bitmap.width,bitmap.height,'member-level'),support:regions(bitmap.width,bitmap.height,'support')};
    }catch(error){bitmap.close();throw error;}
    const result=await bounded(new Promise((resolve,reject)=>{
      pending={id,resolve,reject};worker.postMessage({type:'detect',id,bitmap,regions:boxes},[bitmap]);
    }));
    if(result.kind==='support')return 'support';
    if(result.kind!=='member')return null;
    const votes={'member-level':0,'member-training':0};
    for(const crop of result.crops)for(const mode of Object.keys(votes)){
      const value=await bounded(readNumber(crop,mode,ocr));if(value.value!==null)votes[mode]++;
    }
    const [best,other]=Object.keys(votes).sort((a,b)=>votes[b]-votes[a]);
    return votes[best]>=2&&votes[best]-votes[other]>=2?best:null;
  }
  function dispose(){controller.abort();readyReject?.(Error('已取消'));pending?.reject(Error('已取消'));pending=null;worker?.terminate();ocr?.terminate().catch(()=>{});ocr=null;}
  return {initialize,recognize,detect,dispose};
}

async function readNumber(blob,mode,ocrWorker){
  const bitmap=await createImageBitmap(blob),training=mode==='member-training';
  const sx=training?35:29,sw=training?17:48,sh=28;
  const source=document.createElement('canvas');source.width=sw;source.height=sh;
  const sourceCtx=source.getContext('2d',{willReadFrequently:true});sourceCtx.drawImage(bitmap,sx,bitmap.height-30,sw,sh,0,0,sw,sh);bitmap.close();
  const pixels=sourceCtx.getImageData(0,0,sw,sh).data;
  const attempts=[];
  for(const threshold of [185,205,165]){
    const glyphs=isolateGlyphs(pixels,sw,sh,mode,threshold);
    if(!glyphs){attempts.push({value:null,text:'',confidence:0});continue;}
    const small=document.createElement('canvas');small.width=glyphs.width;small.height=glyphs.height;
    small.getContext('2d').putImageData(new ImageData(glyphs.data,glyphs.width,glyphs.height),0,0);
    const canvas=document.createElement('canvas');canvas.width=small.width*5+40;canvas.height=small.height*5+40;
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(small,20,20,small.width*5,small.height*5);
    const result=await ocrWorker.recognize(canvas),text=result.data.text.trim(),confidence=result.data.confidence;
    const value=text.length===glyphs.count?numericValue(text,mode,confidence):null;
    attempts.push({value,text,confidence});
    if(threshold===185&&value!==null&&confidence>=80)return {value,text,confidence};
  }
  const reliable=attempts.filter(a=>a.value!==null&&a.confidence>=80);
  const agreed=reliable.filter(a=>attempts.filter(b=>b.value===a.value).length>=2);
  if(agreed.length&&new Set(reliable.map(a=>a.value)).size===1)return agreed[0];
  const best=attempts.sort((a,b)=>b.confidence-a.confidence)[0];return {...best,value:null};
}
