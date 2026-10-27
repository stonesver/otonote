/** Reuse the calculator's rendered catalog without loading card or scoring tables. */
export function playlistPresentation(data,host) {
 const rows=new Map([...host.querySelectorAll('[data-song-row]')].map(n=>[n.dataset.songRow,n]));
 return {...data,tracks:data.tracks.map(t=>{const row=rows.get(t.id);if(!row)return t;return {...t,
  jacketUrl:row.querySelector('img.song-picker-jacket')?.src??t.jacketUrl,
  audioDuration:t.audioDuration??(Number(row.dataset.songDuration)||undefined),
  bandLabels:t.bandLabels??[row.querySelector('.song-picker-info > span')?.textContent??''],
  bandIds:t.bandIds??row.dataset.bands?.split(' '),musicType:t.musicType??Number(row.dataset.attribute),
  attributeIcon:row.querySelector('.card-attribute-badge img')?.src,
  attributeLabel:row.querySelector('.card-attribute-badge')?.textContent?.trim()??t.musicTypeLabel,
  missions:row.dataset.missions?.split(',').map(Number)};}),
 charts:data.charts.map(c=>{const choice=rows.get(c.trackId)?.querySelector(`[data-difficulty="${c.difficulty}"]`);return {...c,level:c.level??(Number(choice?.dataset.level)||undefined)};})};
}
export const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
export function songArtwork(track,cls='song-picker-jacket') {
 if(!track?.jacketUrl)return node('span','♪',`${cls} playlist-art-placeholder`);
 const img=node('img',null,cls);img.src=track.jacketUrl;img.alt='';img.loading='lazy';img.width=64;img.height=64;
 img.addEventListener('error',()=>img.replaceWith(node('span','♪',`${cls} playlist-art-placeholder`)),{once:true});return img;
}
export function songIdentity(track,data) {
 const info=node('div',null,'song-picker-info'),title=node('div',null,'song-title-line');title.append(node('strong',track.title??track.id));
 const visual=data.attributeVisuals?.find(a=>String(a.code)===String(track.musicType)),attribute=node('span',visual?.name??track.attributeLabel??track.musicTypeLabel??(track.musicType?`属性 ${track.musicType}`:'属性资料暂缺'),'playlist-attribute');
 if(visual?.iconUrl||track.attributeIcon){const icon=node('img');icon.src=visual?.iconUrl??track.attributeIcon;icon.alt='';icon.width=18;icon.height=18;attribute.prepend(icon);}title.append(attribute);
 info.append(title,node('span',track.bandLabels?.filter(Boolean).join(' / ')||'乐队资料暂缺'));
 const extras=[];if(track.audioDuration)extras.push(`${Math.floor(track.audioDuration/60)}:${String(Math.floor(track.audioDuration%60)).padStart(2,'0')}`);
 if(track.missions?.some(Boolean))extras.push(track.missions.map(m=>['—','COMBO','LUCK','JUST'][m]??'—').join(' · '));
 if(extras.length)info.append(node('small',extras.join(' · '),'playlist-song-meta'));return info;
}
export function playlistArtwork(playlist,tracks) {
 const art=node('div',null,'playlist-art-grid');art.setAttribute('aria-hidden','true');
 for(const entry of playlist.entries.slice(0,4))art.append(songArtwork(tracks.find(t=>t.id===entry.trackId),'playlist-cover'));
 if(!playlist.entries.length)art.append(node('span','♪','playlist-art-placeholder'));return art;
}
