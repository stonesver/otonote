import {createTeamDraft} from './team-draft.mjs';

const SVG_NS='http://www.w3.org/2000/svg';
function importIcon(paths){
 const svg=document.createElementNS(SVG_NS,'svg');
 svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('width','15');svg.setAttribute('height','15');
 svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');
 svg.setAttribute('stroke-width','1.5');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
 svg.setAttribute('aria-hidden','true');
 for(const d of paths){const p=document.createElementNS(SVG_NS,'path');p.setAttribute('d',d);svg.append(p);}
 return svg;
}

/** Mount the existing import flows only when requested, against actual inventory. */
export function setupSharedInventoryImports({root,data,manager,getStore,mergeInventory,refresh,feedback}) {
 const en=String(data.locale??document.documentElement.lang).startsWith('en'),say=(zh,english)=>en?english:zh;
 const entry=document.createElement('div');entry.className='tw-inventory-import-entry';
 const actions=document.createElement('div');actions.className='tw-inventory-import-actions';entry.append(actions);
 const host=document.createElement('div');host.className='tw-inventory-import-host';
 let workbench,loginReady,screenshotReady,disposed=false;
 function mount(){
  if(workbench)return workbench;
  const template=root.closest('[data-team-workspace-shell]')?.querySelector('[data-team-inventory-import-template]');
  if(!template)throw Error(say('导入面板暂不可用，请刷新页面。','Import panel unavailable. Reload the page.'));
  host.append(template.content.cloneNode(true));workbench=host.querySelector('.tw-inventory-import-workbench');
  workbench.data=data;workbench.draft=createTeamDraft();workbench.personalGrowthStore=getStore();
  workbench.commit=refresh;
  workbench.querySelector('[data-inventory-login-close]').addEventListener('click',()=>{workbench.querySelector('.tw-inventory-login-panel').hidden=true;});
  return workbench;
 }
 function action(text,run,attribute,variant,iconPaths){
  const button=document.createElement('button');button.type='button';button.dataset.variant=variant;
  button.append(importIcon(iconPaths),document.createTextNode(text));
  button.setAttribute(attribute,'');
  button.addEventListener('click',async()=>{button.disabled=true;try{await run();}catch(error){if(!disposed)feedback(error.message,'error');}finally{button.disabled=false;}});
  actions.append(button);
 }
 action(say('账号同步导入','Account sync'),async()=>{
  const hub=document.querySelector('[data-account-hub-dialog]');
  if(hub){
   const panel=root.closest('dialog[open]');
   if(panel){
    panel.addEventListener('close',()=>{document.dispatchEvent(new CustomEvent('account-hub:open',{detail:{services:['growth']}}));},{once:true});
    panel.close();
   }else{
    document.dispatchEvent(new CustomEvent('account-hub:open',{detail:{services:['growth']}}));
   }
   return;
  }
  const adapter=mount();
  loginReady??=import('./account-growth-ui.mjs').then(({setupAccountGrowthImport})=>{if(!disposed)setupAccountGrowthImport(adapter,{getInventory:()=>getStore().read()?.inventory??manager.empty(),replaceInventory:refresh});}).catch(error=>{loginReady=null;throw error;});
  await loginReady;if(!disposed)adapter.querySelector('.tw-inventory-login-panel').hidden=false;
 },'data-workspace-login','primary',['M13.5 8a5.5 5.5 0 1 1-1.6-3.9L14 6','M14 2.5V6h-3.5']);
 action(say('截图导入','Import screenshots'),async()=>{
  const adapter=mount();
  screenshotReady??=import('./card-recognition/ui.mjs').then(({setupScreenshotImport})=>disposed?null:setupScreenshotImport(adapter,{manager,getInventory:()=>getStore().read()?.inventory??manager.empty(),commit:mergeInventory})).catch(error=>{screenshotReady=null;throw error;});
  const flow=await screenshotReady;if(!disposed)await flow.open();
 },'data-workspace-screenshot','soft',['M2.5 5a1.5 1.5 0 0 1 1.5-1.5h2l1-1.3h2l1 1.3h2A1.5 1.5 0 0 1 13.5 5v7a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V5Z','M8 10.7a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z']);
 return {entry,host,hasUnsavedChanges(){return !!workbench&&(!!workbench.querySelector('[data-growth-account]')?.value||!!workbench.querySelector('[data-growth-password]')?.value||!workbench.querySelector('[data-growth-preview]')?.hidden||!!workbench.querySelector('[data-shot-queue]')?.children.length);},destroy(){disposed=true;workbench?.querySelector('dialog[open]')?.close();host.remove();entry.remove();}};
}
