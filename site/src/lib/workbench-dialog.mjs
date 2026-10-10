const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
export function createWorkbenchDialog(host,title,{className='',onClose}={}) {
  const dialog=node('dialog',null,`task-dialog ${className}`),heading=node('header'),label=node('h2',title),close=node('button','关闭 ×');close.type='button';
  const id=`task-dialog-${Math.random().toString(36).slice(2)}`;label.id=id;dialog.setAttribute('aria-labelledby',id);heading.append(label,close);
  const body=node('div',null,'task-dialog-body');dialog.append(heading,body);host.append(dialog);
  let origin,pressed=false;
  const outside=e=>{const r=dialog.getBoundingClientRect();return e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};
  dialog.addEventListener('pointerdown',e=>pressed=outside(e));
  dialog.addEventListener('click',e=>{if(pressed&&outside(e))dialog.close();pressed=false;});
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{for(const body of dialog.querySelectorAll('.activation-body'))body.stopReplay?.();onClose?.();if(origin?.isConnected)origin.focus({preventScroll:true});});
  return {dialog,body,open(){origin=document.activeElement;if(!dialog.open)dialog.showModal();body.scrollTop=0;},close(){dialog.close();}};
}

let notification,timer;
export function showWorkbenchToast(message) {
  if(!message)return;
  if(!notification){notification=node('div',null,'task-toast');notification.setAttribute('role','status');notification.setAttribute('aria-live','polite');document.body.append(notification);}
  notification.textContent=message;notification.hidden=false;clearTimeout(timer);timer=setTimeout(()=>notification.hidden=true,3200);
}

export function enhanceNumericInputs(root) {
  for(const input of root.querySelectorAll('input[type=number]')) {
    if(input.dataset.taskStepper||input.hidden)continue;input.dataset.taskStepper='true';
    const label=input.closest('label'),name=input.getAttribute('aria-label')||[...(label?.childNodes??[])].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ').trim()||label?.querySelector(':scope > span')?.textContent||'数值';
    const control=node('span',null,'task-number-stepper');if(!input.hasAttribute('aria-label'))input.setAttribute('aria-label',name);input.before(control);control.append(input);
    for(const [delta,label] of [[-1,'减少'],[1,'增加']]){const button=node('button',delta<0?'−':'+');button.type='button';button.setAttribute('aria-label',`${label}${name}`);button.addEventListener('click',()=>{if(input.value==='')input.value=input.min||'0';try{delta<0?input.stepDown():input.stepUp();}catch{return;}input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});delta<0?control.prepend(button):control.append(button);}
  }
}

/** Turn an existing detail disclosure into a modal without cloning calculator inputs. */
export function modalizeDetails(host,details) {
  if(!details||details.dataset.taskModal)return;
  details.dataset.taskModal='true';const summary=details.querySelector(':scope > summary');if(!summary)return;
  const title=summary.querySelector('strong')?.textContent||summary.firstChild?.textContent?.trim()||summary.textContent.trim(),placeholder=document.createComment('modal content'),panel=createWorkbenchDialog(host,title,{onClose:()=>{for(const child of [...panel.body.childNodes])details.append(child);details.open=false;placeholder.remove();}});
  // Existing disclosures may append expensive results only after their toggle event.
  const contentObserver=new MutationObserver(()=>{if(panel.dialog.open)for(const child of [...details.childNodes])if(child!==summary&&child!==placeholder)panel.body.append(child);});
  contentObserver.observe(details,{childList:true});
  host.taskDetailPanels??=new Set();const entry={details,destroy(){contentObserver.disconnect();panel.close();panel.dialog.remove();host.taskDetailPanels.delete(entry);}};host.taskDetailPanels.add(entry);
  summary.addEventListener('click',e=>{e.preventDefault();details.append(placeholder);for(const child of [...details.childNodes])if(child!==summary&&child!==placeholder)panel.body.append(child);details.open=true;panel.open();});
}
