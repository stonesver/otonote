import {RARITIES} from './gacha-history.mjs';
import {loadShareArtwork} from './gacha-card-art.mjs';

/** Query-local Canvas album. Receives only shareSummary's allowlisted facts. */
export async function createGachaShareImage(data, {signal} = {}) {
  signal?.throwIfAborted();
  await document.fonts.ready;
  signal?.throwIfAborted();
  const artwork = await Promise.all(data.highlights.map(card => loadShareArtwork(card,{signal})));
  signal?.throwIfAborted();
  const missingArtwork = artwork.filter(image => !image).length;
  const images = new Map(data.highlights.map((card,i) => [card,artwork[i]]));
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  if (!ctx) throw Error('当前浏览器无法生成图片。');
  const font = '"Avenir Next", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const mono = '"SFMono-Regular", "Roboto Mono", monospace';
  const colors = {ink:'#293e59', muted:'#748399', line:'#e0e7ef', member:'#597bac', support:'#529d96', up:'#c79540', unknown:'#a8b2c1'};
  const width=720, pad=32, inner=width-pad*2, gap=16, cardWidth=(inner-gap*2)/3;
  const sections=data.kinds.map(k=>{
    const cards=data.highlights.filter(card=>card.kind===k.kind);
    const imageHeight=cardWidth*(k.kind==='member'?4/3:9/16),rowHeight=imageHeight+87;
    return {...k,cards,imageHeight,rowHeight,height:cards.length?52+Math.ceil(cards.length/3)*rowHeight+22:98};
  });
  const chartHeight=135+Math.max(...data.kinds.map(k=>k.distribution.length))*28;
  const chartY=325+sections.reduce((n,s)=>n+s.height,0),footerY=chartY+chartHeight+30;
  const footnotes=[
    '仅含本次官方返回的记录，包含保证抽取。',
    '当期 UP 按抽取时所属卡池判定；资料不全时显示未判定。',
    ...(data.unknown?[`${data.unknown} 条奖品未识别，未计入 SSR / EX / BD。`]:[]),
    ...(data.other?[`${data.other} 条道具或类型未识别的记录，未并入两类图表。`]:[]),
    ...(data.undated?[`${data.undated} 条记录时间未知。`]:[]),
    ...(missingArtwork?[`${missingArtwork} 张卡图未能加载，已保留卡名和数量。`]:[]),
  ];
  const height=Math.ceil(footerY+80+footnotes.length*19);
  canvas.width=width*2;canvas.height=height*2;ctx.scale(2,2);
  const text=(value,x,y,size=12,color=colors.ink,weight='400',family=font)=>{
    ctx.fillStyle=color;ctx.font=`${weight} ${size}px ${family}`;ctx.textBaseline='top';ctx.fillText(String(value),x,y);
  };
  const rect=(x,y,w,h,color,radius=0)=>{ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,radius);ctx.fill();};
  const rule=y=>rect(pad,y,inner,1,colors.line);
  const fit=(value,max,size=12,weight='400')=>{
    ctx.font=`${weight} ${size}px ${font}`;
    const source=String(value);if(ctx.measureText(source).width<=max)return source;
    let result='';for(const char of source){if(ctx.measureText(result+char+'…').width>max)break;result+=char;}return result+'…';
  };
  const wrapped=(value,x,y,max,size=12,color=colors.ink)=>{
    ctx.font=`600 ${size}px ${font}`;
    let first='',rest=String(value);
    while(rest && ctx.measureText(first+rest[0]).width<=max){first+=rest[0];rest=rest.slice(1);}
    text(first,x,y,size,color,'600');
    if(rest)text(fit(rest,max,size,'600'),x,y+size*1.65,size,color,'600');
  };
  const badge=(value,x,y,up=false)=>{
    ctx.font=`600 10px ${font}`;const w=ctx.measureText(value).width+14;
    rect(x,y,w,22,up?'#efdbab':'#fffffff0',4);text(value,x+7,y+6,10,up?'#71521f':'#354b66','600');return w;
  };
  try {
    rect(0,0,width,height,'#f0f4f9');rect(14,14,width-28,height-28,'#fff',12);
    text('OTONOTE / GACHA COLLECTION',pad,36,10,colors.muted,'600',mono);
    text('抽卡记录',pad,70,32,colors.ink,'700');
    text(fit(data.poolName,inner,14),pad,120,14,colors.muted);
    text(data.from?`${data.from} — ${data.to} · UTC+8`:'记录时间未提供',pad,149,11,colors.muted);
    rule(180);
    const metrics=[['本次抽数',data.total,colors.ink],['SSR 角色卡',data.kinds[0].ssr,colors.member],['SSR 留影',data.kinds[1].ssr,colors.support],['当期 UP',data.pickup,'#a57d38']];
    metrics.forEach(([label,value,color],i)=>{const x=pad+i*inner/4;text(label,x,203,11,colors.muted);text(value,x,230,34,color,'500',mono);});
    if(data.pickupUnknown)text(`另有 ${data.pickupUnknown} 条 UP 未判定`,pad+inner*.75,273,9,colors.muted);
    rule(299);
    let y=325;
    for(const section of sections){
      text(section.label,pad,y,18,colors.ink,'600');
      const totals=`SSR ${section.ssr}${section.special?` · EX / BD ${section.special}`:''} · UP ${section.pickup}`;
      text(totals,pad+110,y+6,11,colors.muted);
      if(!section.cards.length){text('当前范围内没有已识别的 SSR、EX、BD 或 UP 卡牌。',pad,y+40,11,colors.muted);y+=section.height;continue;}
      section.cards.forEach((card,index)=>{
        const x=pad+(index%3)*(cardWidth+gap),top=y+39+Math.floor(index/3)*section.rowHeight;
        rect(x,top,cardWidth,section.imageHeight,'#eaf0f6',6);
        const image=images.get(card);
        if(image){
          const scale=Math.max(cardWidth/image.naturalWidth,section.imageHeight/image.naturalHeight);
          const sw=cardWidth/scale,sh=section.imageHeight/scale;
          ctx.save();ctx.beginPath();ctx.roundRect(x,top,cardWidth,section.imageHeight,6);ctx.clip();
          ctx.drawImage(image,(image.naturalWidth-sw)/2,(image.naturalHeight-sh)/2,sw,sh,x,top,cardWidth,section.imageHeight);ctx.restore();
        }else text('暂无卡图',x+cardWidth/2-24,top+section.imageHeight/2,12,colors.muted);
        badge(RARITIES[card.rarity]??'—',x+7,top+7);
        if(card.pickup)badge(`UP ×${card.pickup}`,x+cardWidth-82,top+7,true);
        ctx.font=`600 10px ${font}`;const countWidth=ctx.measureText(`×${card.count}`).width+14;
        badge(`×${card.count}`,x+cardWidth-countWidth-7,top+section.imageHeight-29);
        wrapped(card.name,x,top+section.imageHeight+12,cardWidth,12);
        text(fit(card.pickupUnknown?`UP ${card.pickup} · 未判定 ${card.pickupUnknown}`:card.pickup?`其中 ${card.pickup} 张为当期 UP`:'非 UP',cardWidth,10),x,top+section.imageHeight+56,10,colors.muted);
      });
      y+=section.height;
      if(section.highlightCount>section.cards.length)text(`另有 ${section.highlightCount-section.cards.length} 种${section.label}未展示，数量已计入统计。`,pad,y-22,10,colors.muted);
    }
    const panelWidth=(inner-gap)/2;
    data.kinds.forEach((k,index)=>{
      const x=pad+index*(panelWidth+gap),color=colors[k.kind];
      rect(x,chartY,panelWidth,chartHeight,'#f3f6fa',8);
      rect(x+16,chartY+23,6,6,color,3);text(k.label,x+29,chartY+18,13,colors.ink,'600');
      text(`${k.total} 张`,x+panelWidth-80,chartY+20,12,colors.muted);
      text(`SSR ${k.ssr}`,x+16,chartY+49,17,color,'600');
      text(k.rate===null?'暂无记录':`${k.unknown?'已确认 ':''}${k.rate.toFixed(2)}%`,x+panelWidth-112,chartY+54,10,colors.muted);
      k.distribution.forEach((row,i)=>{
        const top=chartY+89+i*28,barX=x+58,barW=panelWidth-143;
        text(row.label,x+16,top,10,colors.muted);rect(barX,top+3,barW,8,'#e1e7ef',2);
        let offset=barX;
        for(const [key,fill] of [['nonPickup',color],['pickup',colors.up],['pickupUnknown',colors.unknown]]){
          const w=barW*row[key]/Math.max(1,k.total);if(w)rect(offset,top+3,w,8,fill);offset+=w;
        }
        text(row.count,x+panelWidth-73,top,10,colors.ink,'500',mono);
        text(k.total?`${(row.count/k.total*100).toFixed(1)}%`:'—',x+panelWidth-45,top+1,8,colors.muted,'400',mono);
      });
      text(`当期 UP ${k.pickup} 张`,x+16,chartY+chartHeight-30,11,'#a17b39');
      if(k.pickupUnknown)text(`未判定 ${k.pickupUnknown}`,x+panelWidth-112,chartY+chartHeight-29,10,colors.muted);
    });
    rule(footerY);footnotes.forEach((line,i)=>text(line,pad,footerY+20+i*19,10,colors.muted));
    text(`OtoNote · ${data.queriedDay}`,pad,height-42,10,colors.muted);
    signal?.throwIfAborted();
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('图片生成失败，请重试。')),'image/png'));
    signal?.throwIfAborted();
    return {blob,width:canvas.width,height:canvas.height,missingArtwork};
  } finally {canvas.width=canvas.height=1;for(const image of artwork)if(image)image.src='';}
}
