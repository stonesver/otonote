import {arenaDeckTrend} from './arena-trends.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export function arenaTrendView({data,context,musicId,visuals,t,base,time,kind='all',compact=false,expanded=false,modal=false,previewLimit=6,now=Date.now()}) {
 if(compact&&!['leaders','members','supports'].includes(kind))kind='leaders';
 const result=arenaDeckTrend(data,context,musicId,{now});
 const labels={leaders:t('队长','Leaders'),members:t('成员','Members'),supports:t('留影','Supports')};
 const messages={
  'select-server':t('先选择账号区服，查看对应区服的官方趋势。','Choose an account server to see its official trends.'),
  'select-season':t('请选择已收录赛季。','Choose a recorded season.'),
  'select-band':t('请选择乐队。','Choose a band.'),
  'select-song':t('选择歌曲，查看队长、成员和留影趋势。','Choose a song to view leader, member and support trends.'),
  'not-collected':t('此条件的官方趋势快照尚未收录。','No official trend snapshot has been recorded for this selection.'),
  invalid:t('这份趋势资料未通过校验，其他舞台资料仍可查询。','Trend data could not be verified. Other arena information remains available.')
 };
 const songs=(visuals.songs??[]).filter(song=>song.bandIds.includes(context.league?.bandId));
 for(const observation of Array.isArray(data?.deckTrends)?data.deckTrends:[]){
  if(observation?.serverId===context.serverId&&observation.seasonId===context.season?.id&&observation.bandId===context.league?.bandId&&!songs.some(s=>s.id===observation.musicId))
   songs.push((visuals.songs??[]).find(s=>s.id===observation.musicId)??{id:observation.musicId,title:t(`歌曲 #${observation.musicId}（资料未收录）`,`Song #${observation.musicId} (details unavailable)`)});
 }
 if(musicId&&!songs.some(s=>s.id===musicId))songs.push({id:musicId,title:t(`歌曲 #${musicId}（资料未收录）`,`Song #${musicId} (details unavailable)`)});
 const select=`<label class="arena-trend-song">${t('查询歌曲','Song')}<select data-field="music" ${!context.season||!context.league?'disabled':''}><option value="">${t('选择歌曲','Choose a song')}</option>${songs.map(s=>`<option value="${escape(s.id)}"${s.id===musicId?' selected':''}>${escape(s.title)}</option>`).join('')}</select></label>`;
 const selectedSong=songs.find(s=>s.id===musicId);
 const songArtwork=selectedSong?.image?`<img class="arena-song-jacket" src="${escape(selectedSong.image)}" alt="" loading="lazy">`:'';
 const snapshot=result.snapshot;
 function cards(group){
  const full=snapshot[group],list=compact&&!expanded?full.slice(0,previewLimit):full;
  const records=group==='supports'?(visuals.supports??[]):(visuals.members??[]);
  return `<section class="arena-trend-group" style="--arena-trend-count:${Math.max(1,Math.min(list.length,6))}"><h3>${labels[group]}${t('趋势',' trends')} <small>${full.length}${t(' 项',' items')}</small></h3>${list.length?`<ol>${list.map((id,index)=>{
   const card=records.find(c=>c.id===id),tag=card?'a':'div';
   const href=card?` href="${escape(base+'cards/'+(group==='supports'?'supports/':'members/')+encodeURIComponent(card.href)+'/')}${context.serverId?'?server='+encodeURIComponent(context.serverId):''}"`:'';
   return `<li><${tag}${href} class="arena-trend-card"><span class="arena-trend-order" aria-label="${escape(t(`官方返回第 ${index+1} 项`,`Official response item ${index+1}`))}">${index+1}</span><span class="arena-trend-image">${card?.image?`<img src="${escape(card.image)}" alt="" loading="lazy" decoding="async"><span aria-hidden="true">♪</span>`:'<span aria-hidden="true">♪</span>'}</span><span class="arena-trend-name" title="${escape(card?.name??id)}">${card?.attribute&&visuals.attribute?.find(a=>Number(a.value)===card.attribute)?.icon?`<img class="arena-card-attribute" src="${escape(visuals.attribute.find(a=>Number(a.value)===card.attribute).icon)}" alt="${escape(visuals.attribute.find(a=>Number(a.value)===card.attribute).label)}">`:''}${escape(card?.name??t(`${group==='supports'?'留影':'成员卡'} #${id}（资料未收录）`,`${group==='supports'?'Support':'Member card'} #${id} (details unavailable)`))}</span></${tag}></li>`;
  }).join('')}</ol>`:`<p class="arena-trend-empty-group">${t('官方响应未返回这一组条目。','The official response returned no entries for this group.')}</p>`}</section>`;
 }
 return `<section class="arena-section arena-trends${compact?' arena-trend-compact':''}" data-trend-state="${result.status}" aria-labelledby="${modal?'arena-dialog-trends-title':'arena-trends-title'}"><header class="arena-section-header"><div>${!compact?`<span class="arena-kicker">${t('按歌曲查阅','BY SONG')}</span>`:''}<h2 id="${modal?'arena-dialog-trends-title':'arena-trends-title'}">${t('官方配对趋势','Official team trends')}</h2></div><span class="arena-source-tag">${snapshot?t('采集快照','Captured snapshot'):t('尚未收录','Not yet available')}</span></header>
  <div class="arena-song-selection">${songArtwork}${select}</div>
  ${snapshot?`<p class="arena-meta">${escape(t('快照观察时间：','Observed at: ')+time(snapshot.observedAt)+' '+t('北京时间','UTC+8'))}${!compact?' · '+escape(t('统计周期与样本量未提供','Statistical period and sample size not provided')):''}</p>
   ${result.future?`<p class="arena-notice">${t('快照时间晚于设备时间，请检查时间设置。','The snapshot is dated after device time. Check your clock.')}</p>`:''}
   ${result.period==='before-period'||result.period==='after-period'?`<p class="arena-notice">${t('这份快照采集于所选条件时段之外，不能视为当前条件的实时趋势。','This snapshot was observed outside the selected condition period. It does not establish live trends for these conditions.')}</p>`:''}
   <div class="arena-trend-filters" role="group" aria-label="${t('趋势卡牌类型','Trend card type')}">${[...(!compact?[['all',t('全部','All')]]:[]),...Object.entries(labels)].map(([key,label])=>`<button type="button" data-action="trend-kind" data-value="${key}" aria-pressed="${kind===key}">${label}</button>`).join('')}</div>
   <div class="arena-trend-groups">${Object.keys(labels).filter(k=>kind==='all'||kind===k).map(cards).join('')}</div>
   ${compact&&!modal?`<button type="button" data-action="trend-more" aria-haspopup="dialog">${t('查看完整趋势','View full trends')}</button>`:''}
   <details class="arena-trend-notes"><summary>${t('趋势说明','About trends')}</summary><p class="arena-meta">${t('官方未提供入选规则、统计周期、样本量和使用率。','The official response does not provide selection rules, statistical period, sample size or usage rates.')} ${t('按官方返回顺序分别展示，序号不代表使用率；成员与留影不表示一一配对，也不构成最优队伍或胜率预测。','Groups retain official response order. Item numbers are not usage rates; members and supports are not linked as pairs. Trends do not establish an optimal team or win rate.')}</p></details>`:
   `<div class="arena-empty"><div><h3>${escape(messages[result.status])}</h3><p>${t('官方趋势按歌曲提供队长、成员与留影三组卡牌。','Official trends list leaders, members and supports for each song.')}</p></div></div>`}
 </section>`;
}
