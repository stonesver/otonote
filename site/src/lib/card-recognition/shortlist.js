/* Approximate retrieval only. A candidate still needs geometric verification. */
self.FeatureShortlist=class {
  constructor(cards){
    this.cards=cards;this.offsets=[0,8,16,24];
    const total=cards.reduce((n,c)=>n+c.descriptors.rows,0);
    this.data=new Uint8Array(total*32);this.words=new Uint32Array(this.data.buffer);
    this.owners=new Uint16Array(total);this.head=new Int32Array(4*65536).fill(-1);this.next=new Int32Array(4*total).fill(-1);this.total=total;
    let base=0;
    cards.forEach((card,owner)=>{
      const data=card.descriptors.data;this.data.set(data,base*32);
      for(let j=0;j<card.descriptors.rows;j++){
        const id=base+j;this.owners[id]=owner;
        for(let t=0;t<4;t++){
          const at=j*32+this.offsets[t],key=t*65536+data[at]+(data[at+1]<<8);
          this.next[t*total+id]=this.head[key];this.head[key]=id;
        }
      }
      base+=card.descriptors.rows;
    });
    this.seen=new Uint32Array(total);this.stamp=0;
  }
  find(des,kind,limit=6){
    const scores=new Uint32Array(this.cards.length),q=des.data;
    // Copy: OpenCV's view may be unaligned or backed by a changing WASM heap.
    const words=new Uint32Array(new Uint8Array(q).buffer);
    const pop=x=>{x-=(x>>>1)&0x55555555;x=(x&0x33333333)+((x>>>2)&0x33333333);return (((x+(x>>>4))&0x0f0f0f0f)*0x01010101)>>>24;};
    for(let j=0;j<des.rows;j+=2){
      if(++this.stamp===0xffffffff){this.seen.fill(0);this.stamp=1;}
      let best=-1,distance=65;
      for(let t=0;t<4;t++){
        const at=j*32+this.offsets[t],hash=q[at]+(q[at+1]<<8);
        for(let bit=-1;bit<16;bit++){
          const key=t*65536+(hash^(bit<0?0:1<<bit));
          for(let id=this.head[key];id!==-1;id=this.next[t*this.total+id]){
            if(this.seen[id]===this.stamp)continue;this.seen[id]=this.stamp;
            const owner=this.owners[id];if(this.cards[owner].kind!==kind)continue;
            let d=0;
            for(let k=0;k<8&&d<distance;k++)d+=pop(words[j*8+k]^this.words[id*8+k]);
            if(d<distance){best=owner;distance=d;}
          }
        }
      }
      if(best>=0)scores[best]+=65-distance;
    }
    return this.cards.map((card,i)=>({card,score:scores[i]})).filter(x=>x.card.kind===kind).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>x.card);
  }
};
