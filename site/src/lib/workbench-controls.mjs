/** Compact choices operate the original selects, preserving validation and saved values. */
export function setupWorkbenchControls(host) {
 const groups=[];
 for(const selector of ['[data-mode]','[data-pool]','[data-yield-songs]','[data-pairing-mode]','[data-scoring-mode]']) {
  const field=host.querySelector(selector);if(!field||field.options.length!==2)continue;
  const label=field.closest('label'),group=document.createElement('div');group.className='ds-segments';
  group.setAttribute('role','group');group.setAttribute('aria-label',field.getAttribute('aria-label')||[...label.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' '));
  const previousHidden=field.hidden;field.hidden=true;label.classList.add('ds-segment-field');
  const buttons=[...field.options].map(option=>{
   const button=document.createElement('button');button.type='button';button.textContent=option.textContent.trim();
   button.addEventListener('click',()=>{field.value=option.value;field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));sync();});group.append(button);return {button,option};
  });field.after(group);groups.push({field,label,group,buttons,previousHidden});
 }
 function sync(){for(const {field,buttons} of groups)for(const {button,option} of buttons){button.setAttribute('aria-pressed',String(option.value===field.value));button.disabled=field.disabled||option.disabled;button.hidden=option.hidden;}}
 host.addEventListener('change',sync);sync();
 return {sync,destroy(){host.removeEventListener('change',sync);for(const {field,label,group,previousHidden} of groups){group.remove();field.hidden=previousHidden;label.classList.remove('ds-segment-field');}}};
}
