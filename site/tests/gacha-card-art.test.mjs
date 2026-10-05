import test from 'node:test';
import assert from 'node:assert/strict';
import {shareArtworkUrl,loadShareArtwork} from '../src/lib/gacha-card-art.mjs';

test('share artwork accepts only credential-free HTTP images on the current origin',()=>{
  const base='https://example.test/global/zh-CN/tools/gacha-history/';
  assert.equal(shareArtworkUrl('/content/releases/abc/public/card.webp',base),'https://example.test/content/releases/abc/public/card.webp');
  const credentialFixture=new URL('/a',base);
  credentialFixture.username='fixture-user';credentialFixture.password='fixture-password';
  for(const value of ['javascript:alert(1)','data:image/png;base64,abc','file:///tmp/card.png','https://remote.test/a','//remote.test/a',credentialFixture.href,null]){
    assert.equal(shareArtworkUrl(value,base),null);
  }
});

test('export falls back to the thumbnail, tolerates missing art, and cancels pending loads',async()=>{
  const savedImage=globalThis.Image,savedLocation=globalThis.location,requested=[];
  globalThis.location={href:'https://example.test/tools/'};
  globalThis.Image=class {
    naturalWidth=300;naturalHeight=400;
    set src(value){
      if(!value)return;requested.push(value);
      if(value.endsWith('/pending'))return;
      queueMicrotask(()=>value.endsWith('/ok')?this.onload?.():this.onerror?.());
    }
  };
  try {
    const image=await loadShareArtwork({artwork:'/missing',image:'/ok'});
    assert.equal(image.naturalWidth,300);assert.equal(image.crossOrigin,'anonymous');
    assert.deepEqual(requested,['https://example.test/missing','https://example.test/ok']);
    assert.equal(await loadShareArtwork({artwork:'/missing'}),null);
    assert.equal(await loadShareArtwork({artwork:'https://remote.test/ok'}),null);
    const controller=new AbortController(),pending=loadShareArtwork({artwork:'/pending'},{signal:controller.signal});
    controller.abort();await assert.rejects(pending,{name:'AbortError'});
    await assert.rejects(loadShareArtwork({artwork:'/ok'},{signal:controller.signal}),{name:'AbortError'});
  }finally{
    if(savedImage===undefined)delete globalThis.Image;else globalThis.Image=savedImage;
    if(savedLocation===undefined)delete globalThis.location;else globalThis.location=savedLocation;
  }
});
