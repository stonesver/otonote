// Isolate bright glyphs from outlined game labels; geometry is sample-calibrated.
export function isolateGlyphs(rgba,width,height,mode,threshold=185){
  const training=mode==='member-training',support=mode==='support';
  const mask=new Uint8Array(width*height),seen=new Uint8Array(mask.length),components=[];
  for(let i=0;i<mask.length;i++){
    const rgb=rgba.slice(i*4,i*4+3),lo=Math.min(...rgb),hi=Math.max(...rgb);
    mask[i]=lo>threshold&&hi-lo<65?1:0;
  }
  for(let start=0;start<mask.length;start++){
    if(!mask[start]||seen[start])continue;
    const pending=[start],pixels=[];seen[start]=1;let x0=width,x1=0,y0=height,y1=0;
    while(pending.length){
      const i=pending.pop(),x=i%width,y=Math.floor(i/width);pixels.push(i);
      x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const xx=x+dx,yy=y+dy,j=yy*width+xx;
        if(xx>=0&&xx<width&&yy>=0&&yy<height&&!seen[j]&&mask[j]){seen[j]=1;pending.push(j);}
      }
    }
    const w=x1-x0+1,h=y1-y0+1;
    if(h>=12&&h<=20&&w>=2&&w<=13&&pixels.length>=20&&y0>=(support?3:training?11:9)&&y0<=(support?7:14))components.push({x0,x1,y0,y1,pixels});
  }
  // Components must occupy complete consecutive digit positions. No invented defaults.
  const slots=training?[[2,6]]:[[2,6],[15,20],[29,34]];
  const selected=[];
  for(const [lo,hi] of slots){
    const matches=components.filter(c=>c.x0>=lo&&c.x0<=hi);
    if(matches.length!==1)break;
    selected.push(matches[0]);
  }
  if(!selected.length)return null;
  const x0=Math.min(...selected.map(c=>c.x0)),x1=Math.max(...selected.map(c=>c.x1));
  const y0=Math.min(...selected.map(c=>c.y0)),y1=Math.max(...selected.map(c=>c.y1));
  const w=x1-x0+1,h=y1-y0+1,out=new Uint8ClampedArray(w*h*4).fill(255);
  for(const c of selected)for(const i of c.pixels){const p=((Math.floor(i/width)-y0)*w+i%width-x0)*4;out[p]=out[p+1]=out[p+2]=0;}
  return {data:out,width:w,height:h,count:selected.length};
}
