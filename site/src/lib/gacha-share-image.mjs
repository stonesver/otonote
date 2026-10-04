/** A local, fixed-width scorecard. No screenshot service or external image fetches. */
export const GACHA_COLORS = {SSR:'#b77816', EX:'#188b87', BD:'#b95183', SR:'#8663b6', R:'#6687ab', '道具':'#75858a', '未识别':'#a0a8b3'};

export async function createGachaShareImage(data) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('当前浏览器无法生成图片。');
  const font = '"Avenir Next", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const mono = '"SFMono-Regular", "Roboto Mono", monospace';
  const width = 540, pad = 36, inner = width - pad * 2;
  const fit = (text, max, size = 13) => {
    ctx.font = `${size}px ${font}`;
    const chars = [...String(text)]; let value = '';
    for (const char of chars) { if (ctx.measureText(value + char + '…').width > max) return value + '…'; value += char; }
    return value;
  };
  const poolRows = data.pools.slice(0, 5);
  if (data.pools.length > 5) poolRows.push({name:`其他 ${data.pools.length - 5} 个卡池`, total:data.pools.slice(5).reduce((n,p) => n+p.total,0)});
  const height = 712 + poolRows.length * 49;
  canvas.width = width * 2; canvas.height = height * 2; ctx.scale(2,2);
  const text = (value,x,y,size=13,color='#24344d',weight='400',family=font) => {
    ctx.fillStyle=color;ctx.font=`${weight} ${size}px ${family}`;ctx.textBaseline='top';ctx.fillText(String(value),x,y);
  };
  const rect = (x,y,w,h,color,radius=0) => {ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,radius);ctx.fill();};
  const rule = y => {ctx.save();ctx.strokeStyle='#dce4ee';ctx.setLineDash([4,5]);ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(width-pad,y);ctx.stroke();ctx.restore();};
  try {
    rect(0,0,width,height,'#f5f8fc');rect(16,16,width-32,height-32,'#fff',18);
    rect(16,16,width-32,246,'#24344d',[18,18,0,0]);
    text('OTONOTE  /  抽卡成绩单',pad,39,12,'#c4d4e8','600');
    text(fit(data.poolName,inner,17),pad,76,17,'#fff','600');
    text(data.title,pad,120,42,'#f2cd79','800');
    text(data.caption,pad,181,13,'#d5e0ef');
    text('这次的手气，值得留个纪念。',pad,221,11,'#9cafc9');
    // Ticket notches separate the title from actual statistics.
    for (const x of [16,width-16]) {ctx.beginPath();ctx.arc(x,262,9,0,Math.PI*2);ctx.fillStyle='#f5f8fc';ctx.fill();}
    text('本次记录',pad,289,12,'#65768b');text(data.total,pad,309,36,'#24344d','700',mono);
    text('SSR / 特别卡',208,289,12,'#65768b');text(data.high,208,309,36,'#b77816','700',mono);
    text(data.unknown ? '已确认占比' : '高稀有卡占比',370,289,12,'#65768b');
    text(data.rate === null ? '—' : `${data.rate.toFixed(1)}%`,370,315,25,'#188b87','700',mono);
    text(`SSR ${data.ssr} · EX / BD ${data.special} · UP ${data.pickup}${data.pickupUnknown ? '（部分未判定）' : ''}`,pad,364,12,'#65768b');
    rule(396);
    text('每一份闪光',pad,418,17,'#24344d','700');
    let x=pad;
    for (const row of data.distribution) {
      const w=inner*row.count/Math.max(1,data.total);rect(x,451,w,14,GACHA_COLORS[row.label]);x+=w;
    }
    data.distribution.forEach((row,i) => {
      const x=pad+(i%4)*118,y=484+Math.floor(i/4)*24;
      rect(x,y+3,7,7,GACHA_COLORS[row.label],2);text(`${row.label}  ${row.count}`,x+13,y,11);
    });
    let y=552;
    text('卡池足迹',pad,y,17,'#24344d','700');y+=37;
    const max=Math.max(1,...poolRows.map(p=>p.total));
    for (const pool of poolRows) {
      text(fit(pool.name,inner-65),pad,y,12);text(`${pool.total} 抽`,width-pad-55,y,12,'#65768b','600',mono);
      rect(pad,y+23,inner,5,'#edf2f7',2);rect(pad,y+23,inner*pool.total/max,5,'#6687ab',2);y+=49;
    }
    rule(y+1);
    text(data.from ? `${data.from} — ${data.to} · UTC+8` : '记录时间未提供',pad,y+19,11,'#65768b');
    text(`仅含本次官方返回记录${data.undated ? ` · ${data.undated} 条时间未知` : ''}`,pad,y+39,10,'#65768b');
    text(data.unknown ? '部分奖品未识别，未进行欧非定级。' : '趣味评语含保证抽取，不是概率预测或玩家排名。',pad,y+57,10,'#65768b');
    text(`OtoNote · ${data.queriedDay}`,pad,y+79,10,'#65768b');
    const blob = await new Promise((resolve,reject) => canvas.toBlob(value => value ? resolve(value) : reject(Error('图片生成失败，请重试。')), 'image/png'));
    return {blob,width:canvas.width,height:canvas.height};
  } finally { canvas.width=canvas.height=1; }
}
