import {createPersonalGrowthStore, applyPersonalGrowth} from './personal-growth-store.mjs';
import {currentServerContext, assertAccountServer} from './game-servers.mjs';
import {filterCalculatorCards} from './calculator-card-model.mjs';
import {skillPeek,cardIdentity,setupAttributeFilter} from './calculator-card-ui.mjs';
import {createInventoryManager,growthFields} from './inventory-manager.mjs';
import {setupAccountGrowthImport} from './account-growth-ui.mjs';
import {setupInventoryCardEdit} from './inventory-card-edit-ui.mjs';
import {setupQuickOptions} from './tool-quick-options.mjs';

const el=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;};
function download(name,text,type) {
  const url=URL.createObjectURL(new Blob([text],{type})),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const describeGrowth=g=>`Lv.${g.level} · ${g.awake?'觉醒':'突破'} ${g.rank}${g.awake?` · 突破（特训） ${g.awake} · 技能 ${g.skillLevel}/${g.gekisouSkillLevel}`:''}`;

export function setupInventoryEditor(workbench,{onChange,onUse}) {
  const q=s=>workbench.querySelector(s),cards=[...workbench.data.memberCards,...workbench.data.supportCards];
  const album=q('[data-inventory-editor]').classList.contains('inventory-editor--album');
  const manager=createInventoryManager(workbench.data.formalRules,cards);
  const store=workbench.personalGrowthStore ??= createPersonalGrowthStore({rules:workbench.data.formalRules,vipRanks:workbench.data.vipRanks});
  let inventory=manager.empty(),undo=null,page=0,preview=null,fileRequest=0;
  const selected=new Set(),pageSize=12,status=q('[data-inventory-status]');
  let screenshotImport;
  q('[data-inventory-screenshot]').addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{
      screenshotImport??=(await import('./card-recognition/ui.mjs')).setupScreenshotImport(workbench,{manager,getInventory:()=>inventory,commit});
      await screenshotImport.open();
    }catch(error){status.textContent=`截图导入未打开：${error.message}`;}
    finally{button.disabled=false;}
  });
  const cardEditor=setupInventoryCardEdit(workbench,{manager,getInventory:()=>inventory,commit});
  try{const saved=store.read();if(saved){inventory=saved.inventory;applyPersonalGrowth(workbench.draft,saved);}}
  catch(error){status.textContent=`卡库未载入：${error.message}。原备份仍保留在浏览器中。`;}
  const kind=()=>q('[data-inventory-kind]').value;
  function clearPreview(){preview=null;q('[data-inventory-apply]').disabled=true;q('[data-inventory-preview-results]').replaceChildren();}
  const attributes=setupAttributeFilter(q('[data-inventory-attributes]'),()=>{page=0;render();});
  const filterKeys=['query','rarity','owned','band','character','mission','effect','normal','sort'];
  for(const option of workbench.data.skillFilterFacets?.find(f=>f.name==='gekisou-effect')?.options??[]){const o=el('option',option.label);o.value=option.value;q('[data-inventory-effect]').append(o);}
  const shortcuts=setupQuickOptions(q('[data-inventory-editor]'));
  function filtered() { return filterCalculatorCards(cards,{kind:kind(),attributes:attributes.values,...Object.fromEntries(filterKeys.map(k=>[k,q(`[data-inventory-${k}]`).value]))},inventory); }
  function selectionStatus() {
    const visible=new Set(filtered().map(card=>card.id)),outside=[...selected].filter(id=>!visible.has(id)).length;
    q('[data-inventory-selection-count]').textContent=`已选 ${selected.size} 张${kind()==='member'?'成员':'留影'}${outside?`（含 ${outside} 张筛选外卡片）`:''}`;
    for(const selector of ['[data-inventory-add]','[data-inventory-remove]','[data-inventory-clear-selection]','[data-inventory-edit-selected]'])q(selector).disabled=!selected.size;
    q('[data-inventory-edit-selected]').textContent=selected.size?`批量修改 ${selected.size} 张`:'批量修改';
    q('.inventory-selection').dataset.active=String(selected.size>0);
    if(album){
      for(const selector of ['[data-inventory-add]','[data-inventory-remove]','[data-inventory-clear-selection]','[data-inventory-edit-selected]'])q(selector).hidden=!selected.size;
    }
  }
  function selectionChanged() {
    q('.inventory-selection').querySelectorAll('.inventory-edit-feedback').forEach(node=>node.remove());
    selectionStatus();
  }
  function render() {
    shortcuts.sync();
    workbench.quickOptions?.sync();
    workbench.cardInventory=inventory;
    q('[data-inventory-count]').textContent=`${inventory.memberCardIds.length} 张成员 · ${inventory.supportCardIds.length} 张留影`;
    for(const button of workbench.querySelectorAll('[data-inventory-kind-tab]'))button.setAttribute('aria-pressed',String(button.dataset.inventoryKindTab===kind()));
    for(const button of workbench.querySelectorAll('[data-inventory-owned-tab]'))button.setAttribute('aria-pressed',String(button.dataset.inventoryOwnedTab===q('[data-inventory-owned]').value));
    const list=filtered(),pages=Math.max(1,Math.ceil(list.length/pageSize));page=Math.min(page,pages-1);
    const root=q('[data-inventory-cards]');root.replaceChildren();
    for(const card of list.slice(page*pageSize,(page+1)*pageSize)) {
      const owned=inventory[`${card.kind}CardIds`].includes(card.id),tile=el('article','','inventory-card');tile.dataset.owned=String(owned);tile.dataset.selected=String(selected.has(card.id));
      const label=el('label','','inventory-card-select'),check=el('input');check.type='checkbox';check.checked=selected.has(card.id);check.setAttribute('aria-label',`选择 ${card.shortLabel} ${card.relationLabel??''}`);
      check.addEventListener('change',()=>{if(check.checked)selected.add(card.id);else selected.delete(card.id);tile.dataset.selected=String(check.checked);selectionChanged();});
      tile.dataset.kind=card.kind;
      if(album){
        label.append(check,el('span','选择'));tile.append(label);
        const open=el('button','','inventory-card-open');open.type='button';open.setAttribute('aria-label',`${owned?'修改':'录入'} ${card.shortLabel} 的养成`);open.setAttribute('aria-haspopup','dialog');open.dataset.inventoryEdit=card.id;
        const art=el('div','','inventory-card-art'),url=card.artUrl??card.imageUrl;
        if(url){const image=el('img');image.src=url;image.alt='';image.loading='lazy';image.addEventListener('error',()=>{image.hidden=true;art.classList.add('is-missing');});art.append(image);}else art.classList.add('is-missing');
        art.append(el('span',card.rarityLabel??'','inventory-rarity'),el('span',owned?`Lv.${inventory.growth[card.id].level}`:'未录入','inventory-level'));
        const copy=el('div','','inventory-card-copy');copy.append(el('strong',card.shortLabel),el('span',card.relationLabel??''));
        open.append(art,copy);open.addEventListener('click',()=>cardEditor.open(card));tile.append(open);
        const values=el('dl','','inventory-card-stats'),growth=inventory.growth[card.id];
        const fields=card.kind==='member'?[['特训',growth?.awake],['觉醒',growth?.rank],['技能',growth?`${growth.skillLevel}/${growth.gekisouSkillLevel}`:null]]:[['突破',growth?.rank]];
        for(const [name,value] of fields){const cell=el('div');cell.append(el('dt',name),el('dd',value??'—'));values.append(cell);}tile.append(values);
        const edit=el('button',owned?'编辑养成':'＋ 录入养成','inventory-card-edit');edit.type='button';edit.addEventListener('click',()=>cardEditor.open(card));tile.append(edit);
      }else{
        label.append(check,cardIdentity(workbench,card));tile.append(label,el('span',owned?'已拥有':'未录入','card-selection-state'),el('span',owned?describeGrowth(inventory.growth[card.id]):'尚未记录养成','inventory-card-growth'));
        const edit=el('button',owned?'修改养成':'录入养成','inventory-card-edit');edit.type='button';edit.dataset.inventoryEdit=card.id;edit.setAttribute('aria-label',`${owned?'修改':'录入'} ${card.shortLabel} 的养成`);edit.addEventListener('click',()=>cardEditor.open(card));tile.append(edit);
      }
      tile.append(skillPeek(workbench,card,{growth:inventory.growth[card.id],maximum:!owned,hover:!album},album?undefined:tile));root.append(tile);
    }
    if(!list.length){const empty=el('div','','inventory-empty');empty.append(el('strong',q('[data-inventory-owned]').value==='owned'?'还没有符合条件的持有卡牌':'没有找到匹配的卡牌'),el('p','试试其他关键词，或切换到「全部」添加卡牌。'));root.append(empty);}
    q('[data-inventory-filter-count]').textContent=`${list.length} 张${kind()==='member'?'成员卡':'留影'}`;
    q('[data-inventory-page]').textContent=`${list.length} 张卡 · 第 ${page+1} / ${pages} 页`;
    q('[data-inventory-prev]').disabled=page===0;q('[data-inventory-next]').disabled=page>=pages-1;
    q('[data-inventory-undo]').disabled=!undo;
    selectionStatus();
  }
  function commit(next,message,{persist=true,remember=true}={}) {
    assertAccountServer(currentServerContext().serverId);
    next=manager.validate(next);if(persist)store.saveInventory(next);undo=remember?structuredClone(inventory):null;inventory=next;clearPreview();
    status.textContent=message;workbench.cardInventory=inventory;onChange(inventory);render();selectionChanged();
  }
  function action(fn){try{fn();}catch(error){status.textContent=`未修改卡库：${error.message}`;}}
  function preparePreview() {
    clearPreview();
    try {
      const context=currentServerContext();
      if(!context.serverId)throw new Error('请先选择卡库所属区服');
      const raw=q('[data-inventory-paste]').value.trim().replace(/^\uFEFF/,'');
      if(raw.startsWith('{')) {
        const parsed=JSON.parse(raw);
        if(parsed.format==='otonote-personal-growth'||parsed.format==='ournotes-growth-snapshot') {
          workbench.dispatchEvent(new CustomEvent('personal-growth-preview',{detail:parsed}));
          q('[data-inventory-preview-results]').textContent='已在上方“导入个人养成”中展开完整备份预览，请在那里确认。';return;
        }
        assertAccountServer(parsed.serverId,context);
      }
      const rows=manager.preview(q('[data-inventory-paste]').value,{kind:q('[data-inventory-import-kind]').value});
      const errors=rows.filter(r=>r.error),root=q('[data-inventory-preview-results]');
      if(errors.length){for(const r of errors)root.append(el('p',`第 ${r.line} 条：${r.error}`));return;}
      preview=manager.merge(inventory,rows,{updateExisting:q('[data-inventory-overwrite]').checked,presetMode:q('[data-inventory-import-preset]').value});
      const counts=preview.changes.reduce((acc,r)=>(acc[r.action]=(acc[r.action]??0)+1,acc),{});
      root.append(el('p',Object.entries(counts).map(([k,v])=>`${k} ${v} 张`).join(' · ')+'。确认后写入卡库。'));
      const list=el('ul');for(const r of preview.changes)list.append(el('li',`${r.action} · ${r.name} (${r.id}) · ${describeGrowth(r.growth)}`));root.append(list);
      q('[data-inventory-apply]').disabled=false;
    }catch(error){q('[data-inventory-preview-results]').textContent=`不能导入：${error.message}`;}
  }
  q('[data-inventory-editor]').addEventListener('toggle',()=>{if(q('[data-inventory-editor]').open)render();});
  for(const field of ['kind','owned'])for(const button of workbench.querySelectorAll(`[data-inventory-${field}-tab]`))button.addEventListener('click',()=>{
    const control=q(`[data-inventory-${field}]`);control.value=button.dataset[field==='kind'?'inventoryKindTab':'inventoryOwnedTab'];control.dispatchEvent(new Event('change',{bubbles:true}));
  });
  for(const key of ['kind',...filterKeys])q(`[data-inventory-${key}]`).addEventListener(key==='query'?'input':'change',()=>{
    if(key==='kind'){selected.clear();q('[data-inventory-normal]').value='';selectionChanged();}
    if(key==='band'){q('[data-inventory-character]').value='';q('[data-inventory-character]').querySelectorAll('option').forEach(o=>o.hidden=Boolean(o.value&&q('[data-inventory-band]').value&&o.dataset.band!==q('[data-inventory-band]').value));}
    if(key==='mission'){q('[data-inventory-effect]').value='';q('[data-inventory-effect]').querySelectorAll('option').forEach(o=>o.hidden=Boolean(o.value&&q('[data-inventory-mission]').value&&!o.value.startsWith(q('[data-inventory-mission]').value+':')));}
    page=0;render();
  });
  q('[data-inventory-reset]').addEventListener('click',()=>{for(const key of filterKeys)q(`[data-inventory-${key}]`).value=key==='sort'?'rarity':'';for(const key of ['character','effect'])q(`[data-inventory-${key}]`).querySelectorAll('option').forEach(o=>o.hidden=false);attributes.reset();page=0;render();});
  q('[data-inventory-select-visible]').addEventListener('click',()=>{filtered().forEach(c=>selected.add(c.id));render();selectionChanged();});
  q('[data-inventory-select-page]').addEventListener('click',()=>{filtered().slice(page*pageSize,(page+1)*pageSize).forEach(c=>selected.add(c.id));render();selectionChanged();});
  q('[data-inventory-edit-selected]').addEventListener('click',()=>action(()=>cardEditor.openBatch(cards.filter(card=>selected.has(card.id)))));
  q('[data-inventory-clear-selection]').addEventListener('click',()=>{selected.clear();render();selectionChanged();});
  q('[data-inventory-prev]').addEventListener('click',()=>{page--;render();});
  q('[data-inventory-next]').addEventListener('click',()=>{page++;render();});
  q('[data-inventory-add]').addEventListener('click',()=>action(()=>commit(manager.batch(inventory,[...selected]),`已将所选 ${selected.size} 张卡加入卡库；已有养成保留。`)));
  q('[data-inventory-remove]').addEventListener('click',()=>action(()=>{
    const next=structuredClone(inventory);for(const k of ['member','support'])next[`${k}CardIds`]=next[`${k}CardIds`].filter(id=>!selected.has(id));
    commit(next,'已移出所选卡片，可撤销。');selected.clear();render();
  }));
  q('[data-inventory-undo]').addEventListener('click',()=>action(()=>{if(!undo)return;store.saveInventory(undo);inventory=undo;undo=null;clearPreview();status.textContent='已撤销上次修改。';workbench.cardInventory=inventory;onChange(inventory);render();selectionChanged();}));
  q('[data-inventory-use]').addEventListener('click',()=>onUse());
  q('[data-inventory-from-draft]').addEventListener('click',()=>action(()=>{
    const rows=[];
    for(const k of ['member','support'])for(const slot of workbench.draft.slots) {
      const id=slot[`${k}CardId`];if(!id||rows.some(r=>r.id===id))continue;
      const raw=Object.fromEntries(Object.entries(workbench.draft.modifiers.growth?.[id]??{}).filter(([field,value])=>growthFields.includes(field)&&value!==undefined));
      const g=manager.preset(id,k,'level',{...manager.preset(id,k),...raw});
      rows.push({id,kind:k,patch:{...g,...raw}});
    }
    if(!rows.length)throw new Error('当前编成还没有卡片');
    commit(manager.merge(inventory,rows).inventory,'已加入当前编成，已有卡的养成保留。');
  }));
  q('[data-inventory-export]').addEventListener('click',()=>action(()=>download('otonote-personal-growth.json',JSON.stringify(store.read()??store.empty(),null,2),'application/json')));
  q('[data-inventory-template]').addEventListener('click',()=>download('otonote-inventory-template.csv','\uFEFF类型,卡片ID,等级,阶数（成员觉醒／留影突破）,突破（特训）阶数,演出技能,激奏技能\n成员,member-card-1,1,1,1,1,1\n留影,support-card-1,1,1,,,\n','text/csv;charset=utf-8'));
  q('[data-inventory-preview]').addEventListener('click',preparePreview);
  q('[data-inventory-apply]').addEventListener('click',()=>action(()=>{if(!preview)return;commit(preview.inventory,'导入完成，已有卡库已合并。可撤销上次修改。');}));
  for(const selector of ['[data-inventory-paste]','[data-inventory-import-kind]','[data-inventory-import-preset]','[data-inventory-overwrite]'])q(selector).addEventListener('input',()=>{fileRequest++;clearPreview();});
  q('[data-inventory-import]').addEventListener('change',async event=>{
    const current=++fileRequest;clearPreview();
    try{const file=event.target.files[0];if(!file)return;if(file.size>2_000_000)throw new Error('文件过大（最多 2 MB）');const text=await file.text();if(current!==fileRequest)return;q('[data-inventory-paste]').value=text;preparePreview();}
    catch(error){if(current===fileRequest)status.textContent=`读取失败：${error.message}`;}finally{event.target.value='';}
  });
  setupAccountGrowthImport(workbench,{getInventory:()=>inventory,replaceInventory:commit});
  render();return {get inventory(){return inventory;},validate:manager.validate,replace:commit};
}
