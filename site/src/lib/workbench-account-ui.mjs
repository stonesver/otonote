import {bandItemGroups} from '../../../packages/scoring/scoring-rules/band-item-totals.mjs';
import {maximizeAccount,tgwBonusRanges} from './workbench-account-model.mjs';
import {createWorkbenchDialog,showWorkbenchToast,enhanceNumericInputs} from './workbench-dialog.mjs';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};

export function createAccountEditor(host,apply) {
  const rules=host.data.formalRules??host.data.rules,ranks=host.data.vipRanks??[],panel=createWorkbenchDialog(host,'账号加成',{className:'task-account-dialog'});
  let draft,activeTab='instruments',characterFilter='all',characterQuery='',revealInvalidCharacter;
  const button=(text,action,cls)=>{const b=el('button',text,cls);b.type='button';b.addEventListener('click',action);return b;};

  function number(parent,label,value,min,max,onChange) {
    const row=el('label',null,'task-account-field'),input=el('input');input.type='number';input.min=min;input.max=max;input.step=1;input.value=value;
    row.append(el('span',label),input);input.addEventListener('change',()=>{if(input.checkValidity()&&input.value!=='')onChange(Number(input.value));});parent.append(row);
  }

  function paint() {
    panel.dialog.querySelector(':scope > footer')?.remove();
    panel.body.replaceChildren();

    // Top bar: 3-tab segmented switcher + one-click max button
    const topBar=el('div',null,'acc-topbar');
    const tabBar=el('div',null,'acc-tabs');tabBar.setAttribute('role','tablist');
    const tabDefs=[['instruments','乐队道具'],['characters','角色评级'],['tgw','T.G.W CARD']];
    for(const [key,label] of tabDefs){
      const t=button(label,()=>{activeTab=key;paint();},'acc-tab');
      t.setAttribute('role','tab');t.setAttribute('aria-selected',String(activeTab===key));
      tabBar.append(t);
    }
    const maxAll=button('一键全满',()=>{draft=maximizeAccount(draft,rules,ranks);paint();},'ui-btn-soft acc-max-btn');
    topBar.append(tabBar,maxAll);
    panel.body.append(topBar,el('p','仅影响本次计算，不会修改已保存的个人账号或卡库。','task-account-note'));

    // Tab 1: Band Instruments
    if(activeTab==='instruments'){
      const sec=el('section',null,'acc-section');
      const head=el('div',null,'acc-section-head');
      head.append(el('h3','各乐队道具等级'),button('乐器全满',()=>{draft=maximizeAccount(draft,rules,ranks,'instruments');paint();},'ui-btn-outline'));
      sec.append(head);
      const grid=el('div',null,'acc-band-grid');
      for(const group of bandItemGroups(rules)) {
        const card=el('div',null,'acc-band-card');
        const bandInfo=host.data.bands?.find(b=>Number(b.masterId??String(b.id).replace('band-',''))===group.bandId);
        const name=bandInfo?.name??`乐队 ${group.bandId}`;
        const aggregate=Object.hasOwn(draft.bandItemTotals??{},group.bandId);
        const cardHead=el('div',null,'acc-band-head');
        const titleWrap=el('div',null,'acc-band-title');
        const iconSrc=bandInfo?.circleImage||bandInfo?.icon||bandInfo?.image;
        if(iconSrc){const img=el('img');img.src=iconSrc;img.alt='';img.width=20;img.height=20;img.loading='lazy';titleWrap.append(img);}
        titleWrap.append(el('strong',name));
        cardHead.append(titleWrap);
        if(group.supported){
          const modeSeg=el('div',null,'acc-mini-seg');
          for(const [val,txt] of [['detail','逐件'],['total','总和']]){
            const mb=button(txt,()=>{
              if(val==='total')(draft.bandItemTotals??={})[group.bandId]=group.items.reduce((s,i)=>s+(draft.bandItems?.[i.id]??0),0);
              else delete draft.bandItemTotals?.[group.bandId];
              paint();
            });
            mb.setAttribute('aria-pressed',String((val==='total')===aggregate));
            modeSeg.append(mb);
          }
          cardHead.append(modeSeg);
        }
        card.append(cardHead);
        const body=el('div',null,'acc-band-fields');
        if(aggregate)number(body,'总等级',draft.bandItemTotals[group.bandId],0,group.maxTotal,v=>draft.bandItemTotals[group.bandId]=v);
        else for(const item of group.items){const label=host.data.instruments?.find(i=>i.id===item.id)?.name??`道具 ${item.id}`;number(body,label,draft.bandItems?.[item.id]??0,0,item.maxLevel,v=>(draft.bandItems??={})[item.id]=v);}
        card.append(body);grid.append(card);
      }
      sec.append(grid);panel.body.append(sec);
    }

    // Tab 2: Character Ranks
    if(activeTab==='characters'){
      const sec=el('section',null,'acc-section');
      const head=el('div',null,'acc-section-head');
      head.append(el('h3','角色评级（全员计入总加成）'),button('评级全满',()=>{draft=maximizeAccount(draft,rules,ranks,'characters');paint();},'ui-btn-outline'));
      sec.append(head);

      const selectedCharacters=new Set(host.draft.slots.map(slot=>host.data.memberCards?.find(card=>card.id===slot.memberCardId)?.characterId).filter(Boolean).map(id=>Number(String(id).replace('character-',''))));
      const controls=el('div',null,'acc-char-controls');
      const pills=el('div',null,'acc-filter-pills');
      const filterDefs=[['all','全部'],...(selectedCharacters.size?[['team','当前队伍']]:[])];
      for(const bandId of new Set(rules.tables.Character.map(c=>c._bandID))){
        const band=host.data.bands?.find(b=>Number(b.masterId??String(b.id).replace('band-',''))===bandId);
        filterDefs.push([`band:${bandId}`,band?.name??`乐队 ${bandId}`]);
      }
      for(const [val,txt] of filterDefs){
        const pb=button(txt,()=>{characterFilter=val;filterCharacters();},'acc-pill');
        pb.dataset.filterVal=val;pb.setAttribute('aria-pressed',String(characterFilter===val));
        pills.append(pb);
      }
      const search=el('input',null,'ui-input acc-char-search');search.type='search';search.placeholder='搜索角色…';search.setAttribute('aria-label','搜索角色');search.value=characterQuery;
      controls.append(pills,search);sec.append(controls);

      const rankGrid=el('div',null,'acc-char-grid'),rows=[];
      const maxRank=Math.max(...rules.tables.CharacterRank.map(r=>r._rank));
      for(const c of rules.tables.Character){
        const row=el('div',null,'acc-char-item'),name=host.data.characters?.find(n=>Number(String(n.masterId??n.id).replace('character-',''))===c._id)?.name??`角色 ${c._id}`;
        row.dataset.characterId=String(c._id);
        number(row,name,draft.characterRanks?.[c._id]??1,1,maxRank,v=>(draft.characterRanks??={})[c._id]=v);
        rows.push({row,character:c,name});rankGrid.append(row);
      }
      const empty=el('p','没有匹配的角色','task-character-empty');
      function filterCharacters(){
        const query=characterQuery.trim().toLocaleLowerCase();
        let shown=0;
        for(const {row,character:c,name} of rows){
          const ok=(characterFilter==='all'||(characterFilter==='team'&&selectedCharacters.has(c._id))||characterFilter===`band:${c._bandID}`)&&name.toLocaleLowerCase().includes(query);
          row.hidden=!ok;if(ok)shown++;
        }
        empty.hidden=shown>0;
        pills.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filterVal===characterFilter)));
      }
      search.addEventListener('input',()=>{characterQuery=search.value;filterCharacters();});
      revealInvalidCharacter=input=>{
        if(activeTab!=='characters'){activeTab='characters';paint();}
        characterFilter='all';characterQuery='';filterCharacters();
      };
      filterCharacters();sec.append(rankGrid,empty);panel.body.append(sec);
    }

    // Tab 3: T.G.W CARD
    if(activeTab==='tgw'){
      const sec=el('section',null,'acc-section');
      const head=el('div',null,'acc-section-head');
      head.append(el('h3','T.G.W CARD 等级区间'));
      sec.append(head);
      const options=el('div',null,'acc-tgw-grid');
      for(const range of tgwBonusRanges(ranks)){
        const bonus=range.bonuses.map(b=>`${b.label??b.type} +${b.rawValue/100}%`).join(' · ');
        const b=button('',()=>{draft.tgwCardRank=range.min;paint();},'acc-tgw-card');
        b.setAttribute('aria-pressed',String((draft.tgwCardRank??1)>=range.min&&(draft.tgwCardRank??1)<=range.max));
        b.title=bonus||'无加成';
        b.replaceChildren(el('strong',`Lv.${range.min}${range.max>range.min?`–${range.max}`:''}`),el('small',range.bonuses.map(b=>`+${b.rawValue/100}%`).join(' / ')||'无加成'));
        options.append(b);
      }
      sec.append(options);
      if(ranks.length){
        const exact=el('div',null,'acc-tgw-exact');
        number(exact,'精确等级',draft.tgwCardRank??1,Math.min(...ranks.map(r=>r.rank)),Math.max(...ranks.map(r=>r.rank)),v=>{draft.tgwCardRank=v;});
        sec.append(exact);
      }
      panel.body.append(sec);
    }

    const footer=el('footer',null,'acc-footer');
    footer.append(
      button('取消',()=>panel.close(),'ui-btn-ghost'),
      button('应用加成',()=>{
        const invalid=panel.body.querySelector(':invalid');
        if(invalid){revealInvalidCharacter?.(invalid);invalid.reportValidity();return;}
        apply(draft);panel.close();showWorkbenchToast('已应用本次计算加成');
      },'ui-btn-primary')
    );
    panel.dialog.append(footer);
    enhanceNumericInputs(panel.body);
  }
  return {open(){draft=structuredClone(host.draft.modifiers??{});activeTab='instruments';characterFilter=host.draft.slots.some(slot=>slot.memberCardId)?'team':'all';characterQuery='';paint();panel.open();}};
}
