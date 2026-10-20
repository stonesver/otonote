// Logical pages only: the public client adds the reader's edition and language.
export const NOTICE_PAGES = [
  ['常用页面', [['首页','/'],['版本记录','/updates/'],['关于本站','/about/'],['我的养成','/my-growth/'],['活动','/events/'],['招募','/recruitment/'],['任务','/missions/'],['玩家排行榜','/rankings/']]],
  ['资料查询', [['资料目录','/catalog/'],['角色档案','/characters/'],['服装','/costumes/'],['卡牌','/cards/'],['成员卡','/cards/members/'],['留影','/cards/supports/'],['音乐','/music/'],['背景音乐','/music/bgm/'],['沉浸式主页','/immersive/'],['漫画','/comics/'],['表情','/stamps/'],['名片装饰','/profile-decorations/'],['技能','/database/skills/'],['道具','/database/items/'],['乐队道具','/database/band-items/'],['系统资料','/database/global-systems/']]],
  ['剧情', [['所有剧情','/stories/'],['乐队主线','/stories/main/'],['乐队额外故事','/stories/extra/'],['视角故事','/stories/viewpoint/'],['角色羁绊故事','/stories/friendship/'],['活动故事','/stories/events/']]],
  ['游戏工具', [['所有工具','/tools/'],['卡组配队','/tools/deck-builder/'],['歌曲计算','/tools/song-calculator/'],['歌曲排行榜','/tools/song-ranking/'],['队伍 AP 估分','/tools/ap-grade/'],['活动收益计算','/tools/event-efficiency/'],['抽卡记录','/tools/gacha-history/'],['Live2D 预览','/tools/live2d/'],['账号导入说明','/tools/account-export/']]]
];
const pageLabels=new Map(NOTICE_PAGES.flatMap(([,pages])=>pages.map(([label,path])=>[path,label])));
export function normalizeNoticePaths(paths) {
  return paths.includes('/')?['/']:[...new Set(paths)];
}
export function noticePlacement({region,paths,path,href}) {
  const scopes=paths??(path?[path]:[]);
  if(!scopes.length)return '请选择至少一个公告展示范围。';
  const edition={all:'全部区服',global:'国际服',jp:'日服'}[region]??region;
  const location=scopes.includes('/')?'所有页面':scopes.map(path=>`「${pageLabels.get(path)??path}」`).join('、')+'及其子页面';
  const destination=href?`详情面板中的“查看详情”前往「${pageLabels.get(href)??href}」。`:'点击公告仍可阅读完整内容，不显示“查看详情”跳转链接。';
  return `在${edition}的${location}展示。${destination}`;
}
export const noticeDatetime = seconds => seconds == null ? '' : new Date(seconds*1000+8*3600000).toISOString().slice(0,16);
export function noticeTimestamp(value) {
  if (!value) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) return NaN;
  const seconds=Date.parse(value+'+08:00')/1000;
  return Number.isFinite(seconds) && noticeDatetime(seconds)===value ? seconds : NaN;
}
const pad = value => String(value).padStart(2,'0');
const dayString = date => date.toISOString().slice(0,10);
export function calendarDays(year, month) {
  const first=new Date(Date.UTC(year,month,1)), monday=(first.getUTCDay()+6)%7;
  return Array.from({length:42},(_,i)=>{
    const date=new Date(Date.UTC(year,month,1-monday+i));
    return {value:dayString(date),day:date.getUTCDate(),current:date.getUTCMonth()===month};
  });
}

export function installNoticeControls(form) {
  const doc=form.ownerDocument;
  const make=(tag,text='')=>{const node=doc.createElement(tag);node.textContent=text;return node;};
  const input=name=>form.elements.namedItem(name);
  const changed=node=>node.dispatchEvent(new Event('input',{bubbles:true}));
  const scopes=installScopePicker(form);
  const paths=new Set(NOTICE_PAGES.flatMap(([,items])=>items.map(([,path])=>path)));
  for(const select of form.querySelectorAll('[data-notice-page]')) {
    const name=select.dataset.noticePage;
    if(name==='href')select.append(new Option('不设置详情链接',''));
    for(const [group,items] of NOTICE_PAGES) {
      const optgroup=make('optgroup');optgroup.label=group;
      for(const [label,path] of items)optgroup.append(new Option(label,path));
      select.append(optgroup);
    }
    select.append(new Option('自定义页面路径…','__custom__'));
    select.addEventListener('change',()=>{
      const custom=select.value==='__custom__', field=input(name);
      field.hidden=!custom;field.required=custom;
      if(!custom)field.value=select.value;
      else {field.value='';field.focus();}
      updatePageHint(name,custom);changed(field);
    });
  }
  function updatePageHint(name,custom) {
    const hint=form.querySelector(`[data-notice-page-hint="${name}"]`);
    hint.textContent=custom?'填写站内路径，以 / 开头和结尾，不包含区服或语言。'
      :input(name).value?`链接到 ${input(name).value}，保留当前区服和语言。`:'不显示“查看详情”链接。';
  }
  const dialog=make('dialog');dialog.className='notice-calendar';dialog.setAttribute('aria-labelledby','notice-calendar-title');
  const heading=make('div');heading.className='notice-calendar-heading';
  const title=make('h2');title.id='notice-calendar-title';
  const close=make('button','×');close.type='button';close.setAttribute('aria-label','关闭时间选择器');
  heading.append(title,close);
  const note=make('p','北京时间 · 选择后点击确定');note.className='notice-calendar-note';
  const shortcuts=make('div');shortcuts.className='notice-calendar-shortcuts';
  const nav=make('div');nav.className='notice-calendar-nav';
  const previous=make('button','‹'), next=make('button','›');
  previous.type=next.type='button';previous.setAttribute('aria-label','上个月');next.setAttribute('aria-label','下个月');
  const yearInput=make('input');yearInput.type='number';yearInput.min='1970';yearInput.max='9999';yearInput.setAttribute('aria-label','年份');
  const monthSelect=make('select');monthSelect.setAttribute('aria-label','月份');
  for(let i=0;i<12;i++)monthSelect.append(new Option(`${i+1}月`,i));
  nav.append(previous,yearInput,monthSelect,next);
  const weekdays=make('div');weekdays.className='notice-calendar-weekdays';
  for(const day of ['一','二','三','四','五','六','日'])weekdays.append(make('span',day));
  const grid=make('div');grid.className='notice-calendar-grid';grid.setAttribute('role','grid');
  const time=make('div');time.className='notice-calendar-time';
  const timeLabel=make('span','时间');
  const hour=make('select'), minute=make('select');hour.setAttribute('aria-label','小时');minute.setAttribute('aria-label','分钟');
  for(let i=0;i<24;i++)hour.append(new Option(pad(i),pad(i)));
  for(let i=0;i<60;i++)minute.append(new Option(pad(i),pad(i)));
  time.append(timeLabel,hour,make('span',':'),minute);
  const selection=make('p');selection.className='notice-calendar-selection';selection.setAttribute('role','status');
  const actions=make('div');actions.className='notice-calendar-actions';
  const clear=make('button','清空时间'), cancel=make('button','取消'), confirm=make('button','确定');
  for(const button of [clear,cancel,confirm])button.type='button';
  confirm.className='notice-calendar-confirm';actions.append(clear,cancel,confirm);
  dialog.append(heading,note,shortcuts,nav,weekdays,grid,time,selection,actions);doc.body.append(dialog);
  let fieldName='', trigger=null, selectedDay='', focusedDay='', year=0, month=0;
  const nowLocal=()=>noticeDatetime(Date.now()/1000);
  function preview() {selection.textContent=`已选 ${selectedDay} ${hour.value}:${minute.value}（北京时间）`;}
  function renderCalendar(focus=false) {
    yearInput.value=year;monthSelect.value=month;grid.setAttribute('aria-label',`${year}年${month+1}月`);
    const today=nowLocal().slice(0,10), days=calendarDays(year,month);
    if(!days.some(day=>day.value===focusedDay))focusedDay=days.find(day=>day.current).value;
    grid.replaceChildren();
    for(let row=0;row<6;row++) {
      const week=make('div');week.setAttribute('role','row');
      for(const day of days.slice(row*7,row*7+7)) {
        const cell=make('div');cell.setAttribute('role','gridcell');cell.setAttribute('aria-selected',String(day.value===selectedDay));
        const button=make('button',String(day.day));button.type='button';button.dataset.day=day.value;button.dataset.outside=String(!day.current);
        button.setAttribute('aria-label',day.value);button.tabIndex=day.value===focusedDay?0:-1;
        if(day.value===today)button.setAttribute('aria-current','date');
        button.addEventListener('click',()=>{selectedDay=focusedDay=day.value;year=Number(day.value.slice(0,4));month=Number(day.value.slice(5,7))-1;renderCalendar(true);});
        cell.append(button);week.append(cell);
      }
      grid.append(week);
    }
    preview();if(focus)grid.querySelector(`[data-day="${focusedDay}"]`)?.focus();
  }
  function choose(value) {
    selectedDay=focusedDay=value.slice(0,10);year=Number(value.slice(0,4));month=Number(value.slice(5,7))-1;
    hour.value=value.slice(11,13);minute.value=value.slice(14,16);renderCalendar();
  }
  function shiftMonth(offset) {
    const date=new Date(Date.UTC(year,month+offset,1));
    if(date.getUTCFullYear()<1970||date.getUTCFullYear()>9999)return;
    year=date.getUTCFullYear();month=date.getUTCMonth();focusedDay=`${year}-${pad(month+1)}-01`;renderCalendar();
  }
  previous.addEventListener('click',()=>shiftMonth(-1));next.addEventListener('click',()=>shiftMonth(1));
  monthSelect.addEventListener('change',()=>{month=Number(monthSelect.value);renderCalendar();});
  yearInput.addEventListener('change',()=>{if(yearInput.checkValidity()&&yearInput.value){year=Number(yearInput.value);renderCalendar();}else yearInput.value=year;});
  grid.addEventListener('keydown',event=>{
    const step={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];
    if(step===undefined)return;
    event.preventDefault();const date=new Date(focusedDay+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+step);
    if(date.getUTCFullYear()<1970||date.getUTCFullYear()>9999)return;
    focusedDay=dayString(date);year=date.getUTCFullYear();month=date.getUTCMonth();renderCalendar(true);
  });
  for(const [label,offset] of [['现在',0],['1小时后',3600000],['明天此时',86400000]]) {
    const button=make('button',label);button.type='button';button.addEventListener('click',()=>choose(noticeDatetime((Date.now()+offset)/1000)));shortcuts.append(button);
  }
  hour.addEventListener('change',preview);minute.addEventListener('change',preview);
  close.addEventListener('click',()=>dialog.close());cancel.addEventListener('click',()=>dialog.close());
  function commit(value) {const field=input(fieldName);field.value=value;sync();changed(field);dialog.close();}
  clear.addEventListener('click',()=>commit(''));
  confirm.addEventListener('click',()=>{
    const value=`${selectedDay}T${hour.value}:${minute.value}`;
    if(Number.isFinite(noticeTimestamp(value)))commit(value);
  });
  for(const button of form.querySelectorAll('[data-notice-time]'))button.addEventListener('click',()=>{
    fieldName=button.dataset.noticeTime;trigger=button;
    title.textContent=fieldName==='startsAt'?'选择生效时间':'选择结束时间';
    clear.textContent=fieldName==='startsAt'?'改为立即生效':'改为不自动结束';
    choose(input(fieldName).value||nowLocal());dialog.showModal();
    grid.querySelector(`[data-day="${focusedDay}"]`)?.focus();
  });
  dialog.addEventListener('close',()=>{if(trigger?.isConnected&&!trigger.disabled)trigger.focus();});
  dialog.addEventListener('click',event=>{
    if(event.target!==dialog)return;
    const rect=dialog.getBoundingClientRect();
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();
  });
  function sync() {
    for(const name of ['href']) {
      const value=input(name).value,custom=!(paths.has(value)||name==='href'&&value==='');
      form.querySelector(`[data-notice-page="${name}"]`).value=custom?'__custom__':value;
      input(name).hidden=!custom;input(name).required=custom;updatePageHint(name,custom);
    }
    for(const name of ['startsAt','endsAt']) {
      const value=input(name).value,button=form.querySelector(`[data-notice-time="${name}"]`);
      form.querySelector(`[data-notice-time-value="${name}"]`).textContent=value?value.replace('T',' '):name==='startsAt'?'立即生效':'不自动结束';
      button.dataset.empty=String(!value);
    }
    const start=noticeTimestamp(input('startsAt').value),end=noticeTimestamp(input('endsAt').value);
    const invalid=start!==null&&end!==null&&end<=start;
    const error=form.querySelector('[data-notice-schedule-error]');
    error.hidden=!invalid;error.textContent=invalid?'结束时间必须晚于生效时间，请调整后再保存。':'';
    form.querySelector('[data-notice-time="endsAt"]').setAttribute('aria-invalid',String(invalid));
  }
  sync();
  return {sync,getPaths:scopes.getPaths,setPaths:scopes.setPaths,setDisabled(disabled){scopes.setDisabled(disabled);for(const button of form.querySelectorAll('[data-notice-time]'))button.disabled=disabled;if(disabled&&dialog.open)dialog.close();}};
}

function installScopePicker(form) {
  const doc=form.ownerDocument;
  const make=(tag,text='')=>{const node=doc.createElement(tag);node.textContent=text;return node;};
  const button=(text,action)=>{const node=make('button',text);node.type='button';node.addEventListener('click',action);return node;};
  const trigger=form.querySelector('[data-notice-scopes]'), value=form.querySelector('#notice-scopes-value');
  let chosen=['/'],pending=new Set(),customs=new Set();
  const dialog=make('dialog');dialog.className='notice-scope-dialog';dialog.setAttribute('aria-labelledby','notice-scope-title');
  const header=make('div');header.className='notice-calendar-heading';
  const title=make('h2','选择展示页面');title.id='notice-scope-title';
  const close=button('×',()=>dialog.close());close.setAttribute('aria-label','关闭展示范围选择');header.append(title,close);
  const note=make('p','可多选，包含子页面；选“全站”时覆盖所有页面。');note.className='notice-calendar-note';
  const search=make('input');search.type='search';search.placeholder='搜索页面，如招募、活动';search.setAttribute('aria-label','搜索展示页面');
  const allLabel=make('label');allLabel.className='notice-scope-all';
  const all=make('input');all.type='checkbox';all.value='/';all.setAttribute('aria-label','全站（所有页面）');allLabel.append(all,make('span','全站（所有页面）'));
  const options=make('div');options.className='notice-scope-options';
  const customLine=make('div');customLine.className='notice-scope-custom';
  const custom=make('input');custom.type='text';custom.maxLength=200;custom.placeholder='自定义路径，如 /events/123/';custom.setAttribute('aria-label','添加自定义展示路径');
  const counter=make('p');counter.className='notice-calendar-selection';counter.setAttribute('role','status');
  const confirm=button('确定',()=>{chosen=normalizeNoticePaths([...pending]);renderValue();form.dispatchEvent(new Event('input',{bubbles:true}));dialog.close();});confirm.className='notice-calendar-confirm';
  const add=button('添加',()=>{
    const path=custom.value.trim();
    if(!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(path)){counter.textContent='请填写以 / 开头和结尾的站内路径。';custom.focus();return;}
    if(path!=='/'&&!pending.has(path)&&!pending.has('/')&&pending.size>=32){counter.textContent='最多选择 32 个展示范围。';return;}
    if(!pageLabels.has(path))customs.add(path);
    update(path,true);custom.value='';renderOptions();
  });customLine.append(custom,add);
  const actions=make('div');actions.className='notice-calendar-actions';
  actions.append(counter,button('取消',()=>dialog.close()),confirm);
  dialog.append(header,note,search,allLabel,options,customLine,actions);doc.body.append(dialog);
  function refreshChecks() {
    all.checked=pending.has('/');
    for(const checkbox of options.querySelectorAll('input'))checkbox.checked=pending.has(checkbox.value);
    counter.textContent=pending.has('/')?'全站展示':`已选 ${pending.size} 个范围`;
    confirm.disabled=!pending.size;
  }
  function update(path,checked) {
    if(checked) {
      if(path==='/')pending.clear();
      else pending.delete('/');
      if(!pending.has(path)&&pending.size>=32){refreshChecks();counter.textContent='最多选择 32 个展示范围。';return;}
      pending.add(path);
    }else pending.delete(path);
    refreshChecks();
  }
  function renderOptions() {
    const query=search.value.trim().toLowerCase(),scroll=options.scrollTop;
    options.replaceChildren();
    for(const [group,pages] of [...NOTICE_PAGES,['自定义范围',[...customs].map(path=>[path,path])]]) {
      const filtered=pages.filter(([label,path])=>path!=='/'&&(!query||`${label} ${path}`.toLowerCase().includes(query)));
      if(!filtered.length)continue;
      const section=make('section');section.append(make('h3',group));
      for(const [name,path] of filtered) {
        const label=make('label'),checkbox=make('input');checkbox.type='checkbox';checkbox.value=path;checkbox.setAttribute('aria-label',name);
        const copy=make('span');copy.append(make('span',name),make('small',path));
        checkbox.addEventListener('change',()=>update(path,checkbox.checked));label.append(checkbox,copy);section.append(label);
      }
      options.append(section);
    }
    if(!options.children.length)options.append(make('p','没有匹配的页面，可添加自定义路径。'));
    options.scrollTop=scroll;refreshChecks();
  }
  all.addEventListener('change',()=>update('/',all.checked));search.addEventListener('input',renderOptions);
  custom.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();add.click();}});
  function renderValue() {
    const labels=chosen.map(path=>path==='/'?'全站（所有页面）':pageLabels.get(path)??path);
    value.textContent=labels.length<=2?labels.join('、'):`${labels.slice(0,2).join('、')} 等 ${labels.length} 处`;
    trigger.title=labels.join('、');
    form.querySelector('[data-notice-scopes-hint]').textContent=chosen.includes('/')?'全站显示，包含所有页面。':`已选 ${chosen.length} 个范围，匹配任意一项即可显示，包含子页面。`;
  }
  trigger.addEventListener('click',()=>{
    pending=new Set(chosen);customs=new Set(chosen.filter(path=>!pageLabels.has(path)));search.value='';custom.value='';renderOptions();dialog.showModal();all.focus();
  });
  dialog.addEventListener('close',()=>{if(trigger.isConnected&&!trigger.disabled)trigger.focus();});
  renderValue();
  return {getPaths:()=>[...chosen],setPaths(paths){chosen=normalizeNoticePaths(paths);renderValue();},setDisabled(disabled){trigger.disabled=disabled;if(disabled&&dialog.open)dialog.close();}};
}
