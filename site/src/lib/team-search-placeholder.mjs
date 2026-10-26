/** Shared first-team waiting view. Controllers retain ownership of progress and results. */
export function createTeamSearchPlaceholder({caption='首个方案生成后会自动显示。'}={}) {
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
 const element=el('section',null,'team-search-placeholder'),heading=el('div',null,'team-search-heading'),title=el('h2'),equalizer=el('div',null,'team-search-equalizer');
 element.hidden=true;equalizer.setAttribute('aria-hidden','true');
 for(let i=0;i<5;i++){const bar=el('i');bar.style.setProperty('--beat',`${i*-.19}s`);equalizer.append(bar);}
 heading.append(equalizer,title);
 const roster=el('div',null,'team-search-roster');roster.setAttribute('aria-hidden','true');
 for(let i=0;i<5;i++){
  const pair=el('div',null,'team-search-pair'),member=el('div',null,'team-search-member');pair.style.setProperty('--beat',`${i*-.45}s`);
  member.append(el('span',i%2?'♫':'♪'));pair.append(member,el('div',null,'team-search-support'),el('div',null,'team-search-line'));roster.append(pair);
 }
 element.append(heading,el('p',caption,'team-search-caption'),roster);
 return {element,update({running=false,hasResults=false,active=true,title:label='' }={}){
  element.hidden=!active||!running||hasResults;
  if(title.textContent!==label)title.textContent=label;
 }};
}
