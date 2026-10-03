import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecognitionEngine} from '../src/lib/card-recognition/engine.mjs';

test('cancel initialization/matching, reject engine errors, then retry with a fresh worker',async t=>{
  const original=new Map(['Worker','OffscreenCanvas','createImageBitmap','isSecureContext','document','Tesseract'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  t.after(()=>{for(const [k,d] of original)if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];});
  let behavior='stall',ocrStops=0,cvStops=0,matchingStarted;
  class FakeWorker{
    postMessage(message){
      if(message.type==='recognize'){matchingStarted();return;}
      queueMicrotask(()=>{
        if(behavior==='ready')this.onmessage({data:{type:'ready'}});
        if(behavior==='error')this.onmessage({data:{type:'error',message:'broken index'}});
      });
    }
    terminate(){cvStops++;}
  }
  Object.assign(globalThis,{Worker:FakeWorker,OffscreenCanvas:class {},isSecureContext:true,
    createImageBitmap:async()=>({width:1280,height:905,close(){}}),
    document:{createElement:()=>({remove(){}}),head:{append:script=>queueMicrotask(()=>script.onload())}},
    Tesseract:{createWorker:async()=>({setParameters:async()=>{},terminate:async()=>{ocrStops++;}})}});
  const config={manifest:{},featuresUrl:'https://test.invalid/features'};
  const first=createRecognitionEngine(config),initializing=first.initialize();first.dispose();
  await assert.rejects(initializing,/取消/);
  behavior='error';const broken=createRecognitionEngine(config);
  await assert.rejects(broken.initialize(),/broken index/);broken.dispose();
  behavior='ready';const retry=createRecognitionEngine(config);await retry.initialize();
  const started=new Promise(resolve=>{matchingStarted=resolve;});
  const processing=retry.recognize({name:'synthetic'},'member-level','id',()=>assert.fail('cancelled recognition must not publish rows'));
  await started;retry.dispose();await assert.rejects(processing,/取消/);
  assert.equal(cvStops,3);assert.equal(ocrStops,1);
});
