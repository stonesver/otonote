/* Static-only browser recognition. No upload endpoints or inventory writes. */
let cvReady, db, orb, matcher, shortlist, config;
const notify=(type,payload={})=>self.postMessage({type,...payload});
async function init(){
  if(db)return;
  const start=performance.now();
  notify('progress',{message:'加载本地识别引擎与卡库…'});
  notify('preparation',{stage:'cards',label:'加载卡面识别引擎…'});
  importScripts('opencv.js','shortlist.js');
  // OpenCV's legacy thenable resolves to itself: awaiting it loops forever.
  let cv=self.cv;
  if(cv instanceof Promise)cv=await cv;
  else if(!cv.Mat)await new Promise((resolve,reject)=>{
    cv.onRuntimeInitialized=()=>resolve();cv.onAbort=reason=>reject(Error(String(reason)));
  });
  cvReady=cv;notify('preparation',{stage:'cards',complete:true});
  notify('preparation',{stage:'index',label:'下载卡库特征…'});
  const manifest=config.manifest;
  const response=await fetch(config.featuresUrl,{cache:'force-cache',signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error('卡库特征加载失败');
  const reader=response.body.getReader(),chunks=[];let received=0;
  while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);received+=value.length;
    notify('preparation',{stage:'index',label:'下载卡库特征…',progress:Math.min(received/manifest.compressedBytes,1)});}
  const packed=new Uint8Array(received);let offset=0;for(const chunk of chunks){packed.set(chunk,offset);offset+=chunk.length;}

  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',packed)),b=>b.toString(16).padStart(2,'0')).join('');
  if(digest!==manifest.featuresSha256)throw Error('卡库与特征版本不一致，请重新加载');
  const bytes=await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if(bytes.byteLength!==manifest.decodedBytes)throw Error('特征文件不完整');
  db=manifest.cards.map(card=>({...card,
    descriptors:cv.matFromArray(card.count,32,cv.CV_8UC1,new Uint8Array(bytes,card.descriptorOffset,card.count*32)),
    points:new Float32Array(bytes,card.pointOffset,card.count*2),
  }));
  orb=new cv.ORB();orb.setMaxFeatures(1000);orb.setEdgeThreshold(10);orb.setFastThreshold(7);
  shortlist=new self.FeatureShortlist(db);
  matcher=new cv.BFMatcher(cv.NORM_HAMMING,false);
  notify('preparation',{stage:'index',complete:true});
  notify('ready',{initMs:performance.now()-start,cards:db.length,indexBytes:packed.byteLength});
}

function badge(canvas,kind){
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  const {width:w,height:h}=canvas;
  const data=ctx.getImageData(w-35,h-38,35,38).data;
  const points=kind==='member'?[[16,13],[25,20],[22,29],[9,29],[7,20]]:[[23,10],[32,19],[29,29],[16,29],[13,18]];
  const values=points.map(([x,y])=>{
    const samples=[];
    for(let yy=y-1;yy<=y+1;yy++)for(let xx=x-1;xx<=x+1;xx++){
      const k=(yy*35+xx)*4;samples.push(.299*data[k]+.587*data[k+1]+.114*data[k+2]);
    }
    samples.sort((a,b)=>a-b);return samples[4];
  });
  const count=values.filter(v=>v>145).length;
  return values.every(v=>v<110||v>175)&&count>=1?count:null;
}

function matchCard(canvas,kind){
  const cv=cvReady, rgba=cv.matFromImageData(canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height));
  const gray=new cv.Mat(),mask=new cv.Mat(canvas.height,canvas.width,cv.CV_8UC1,new cv.Scalar(255));
  const kp=new cv.KeyPointVector(),des=new cv.Mat();
  try{
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY);
    cv.rectangle(mask,new cv.Point(0,0),new cv.Point(canvas.width,22),new cv.Scalar(0),-1);
    cv.rectangle(mask,new cv.Point(0,canvas.height-28),new cv.Point(canvas.width,canvas.height),new cv.Scalar(0),-1);
    orb.detectAndCompute(gray,mask,kp,des);
    if(des.rows<4)return {accepted:false,candidates:[]};
    const ranked=[];
    for(const card of shortlist.find(des,kind)){
      const matches=new cv.DMatchVectorVector(),good=[];
      try{
        matcher.knnMatch(des,card.descriptors,matches,2);
        for(let i=0;i<matches.size();i++){
          const pair=matches.get(i);
          try{if(pair.size()>=2){const a=pair.get(0),b=pair.get(1);if(a.distance<.75*b.distance)good.push(a);}}
          finally{pair.delete();}
        }
      }finally{matches.delete();}
      let inliers=0;
      if(good.length>=4){
        const src=[],dst=[];
        for(const m of good){const pt=kp.get(m.queryIdx).pt;src.push(pt.x,pt.y);dst.push(card.points[m.trainIdx*2],card.points[m.trainIdx*2+1]);}
        const a=cv.matFromArray(good.length,1,cv.CV_32FC2,src),b=cv.matFromArray(good.length,1,cv.CV_32FC2,dst),keep=new cv.Mat();let H;
        try{H=cv.findHomography(a,b,cv.RANSAC,5,keep);if(!H.empty())inliers=cv.countNonZero(keep);}
        finally{a.delete();b.delete();keep.delete();H?.delete();}
      }
      ranked.push({id:card.id,name:card.name,thumbnail:card.thumbnail,inliers});
    }
    ranked.sort((a,b)=>b.inliers-a.inliers);
    const unique=ranked.filter((v,i)=>ranked.findIndex(x=>x.id===v.id)===i),best=unique[0],second=unique[1];
    return {accepted:!!best&&best.inliers>=18&&best.inliers>=(second?.inliers??0)*1.8&&best.inliers-(second?.inliers??0)>=8,candidates:unique.slice(0,3)};
  }finally{rgba.delete();gray.delete();mask.delete();kp.delete();des.delete();}
}

function crop(normalized,rect){
  const canvas=new OffscreenCanvas(rect.w,rect.h);
  canvas.getContext('2d').drawImage(normalized,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);return canvas;
}
self.onmessage=async({data})=>{
  try{
    if(data.type==='init'){config=data.config;await init();return;}
    if(!['recognize','detect'].includes(data.type))return;
    await init();
    const {bitmap,regions,kind,id}=data,start=performance.now();
    const normalized=new OffscreenCanvas(1280,Math.round(bitmap.height*1280/bitmap.width));
    normalized.getContext('2d').drawImage(bitmap,0,0,normalized.width,normalized.height);bitmap.close();
    if(data.type==='detect'){
      const scores={},samples={};
      for(const [candidate,boxes] of Object.entries(regions)){
        scores[candidate]=0;samples[candidate]=[];
        for(const rect of boxes.slice(0,4)){
          const canvas=crop(normalized,rect),match=matchCard(canvas,candidate);
          if(match.accepted)scores[candidate]++;
          samples[candidate].push(canvas);
        }
      }
      const best=scores.member>=2&&scores.support===0?'member':scores.support>=2&&scores.member===0?'support':null;
      const crops=best==='member'?await Promise.all(samples.member.map(c=>c.convertToBlob({type:'image/png'}))):[];
      notify('detected',{id,kind:best,crops});return;
    }
    for(let i=0;i<regions.length;i++){
      const rect=regions[i],canvas=crop(normalized,rect);
      const match=matchCard(canvas,kind),count=badge(canvas,kind);
      const blob=await canvas.convertToBlob({type:'image/png'});
      notify('row',{id,index:i,rect,match,badge:count,crop:blob});
      notify('progress',{message:`匹配卡面 ${i+1} / ${regions.length}`,done:i+1,total:regions.length});
    }
    notify('complete',{id,matchMs:performance.now()-start});
  }catch(error){notify('error',{message:error?.message||String(error)});}
};
