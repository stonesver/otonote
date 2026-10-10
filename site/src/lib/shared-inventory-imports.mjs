import {createTeamDraft} from './team-draft.mjs';

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
 function action(text,run,attribute){
  const button=document.createElement('button');button.type='button';button.textContent=text;button.setAttribute(attribute,'');
  button.addEventListener('click',async()=>{button.disabled=true;try{await run();}catch(error){if(!disposed)feedback(error.message,'error');}finally{button.disabled=false;}});
  actions.append(button);
 }
 action(say('截图导入','Import screenshots'),async()=>{
  const adapter=mount();
  screenshotReady??=import('./card-recognition/ui.mjs').then(({setupScreenshotImport})=>disposed?null:setupScreenshotImport(adapter,{manager,getInventory:()=>getStore().read()?.inventory??manager.empty(),commit:mergeInventory})).catch(error=>{screenshotReady=null;throw error;});
  const flow=await screenshotReady;if(!disposed)await flow.open();
 },'data-workspace-screenshot');
 action(say('账号登录','Account login'),async()=>{
  const adapter=mount();
  loginReady??=import('./account-growth-ui.mjs').then(({setupAccountGrowthImport})=>{if(!disposed)setupAccountGrowthImport(adapter,{getInventory:()=>getStore().read()?.inventory??manager.empty(),replaceInventory:refresh});}).catch(error=>{loginReady=null;throw error;});
  await loginReady;if(!disposed)adapter.querySelector('.tw-inventory-login-panel').hidden=false;
 },'data-workspace-login');
 return {entry,host,hasUnsavedChanges(){return !!workbench&&(!!workbench.querySelector('[data-growth-account]').value||!!workbench.querySelector('[data-growth-password]').value||!workbench.querySelector('[data-growth-preview]').hidden||!!workbench.querySelector('[data-shot-queue]').children.length);},destroy(){disposed=true;workbench?.querySelector('dialog[open]')?.close();host.remove();entry.remove();}};
}
