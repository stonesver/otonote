let pickerSequence = 0;

/** Enhance a real select while preserving change events and a no-JS fallback. */
export function rankingPicker(select, {label, en = false, describe = () => null} = {}) {
  if (!select) return {update() {}};
  const wrapper = document.createElement('div'); wrapper.className = 'pr-picker';
  select.after(wrapper);
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'pr-picker-trigger';
  const list = document.createElement('div'); list.className = 'pr-picker-list'; list.id = `pr-picker-${++pickerSequence}`;
  list.setAttribute('role','listbox'); list.setAttribute('aria-label',label); list.hidden = true;
  trigger.setAttribute('aria-haspopup','listbox'); trigger.setAttribute('aria-controls',list.id); trigger.setAttribute('aria-expanded','false');
  wrapper.append(trigger,list); select.hidden = true;
  const controller = new AbortController(); let choices = [];
  const close = () => {list.hidden = true;trigger.setAttribute('aria-expanded','false');};
  const open = () => {
    if (trigger.disabled) return;
    update();
    list.hidden = false; trigger.setAttribute('aria-expanded','true');
    (choices.find(button => button.getAttribute('aria-selected') === 'true') || choices[0])?.focus();
  };
  trigger.addEventListener('click',()=>list.hidden ? open() : close());
  trigger.addEventListener('keydown',event=>{
    if (['ArrowDown','ArrowUp'].includes(event.key)) {event.preventDefault();open();}
  });
  list.addEventListener('keydown',event=>{
    if (event.key === 'Escape') {event.preventDefault();close();trigger.focus();return;}
    const index = choices.indexOf(document.activeElement);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : event.key === 'ArrowDown' ? (index+1)%choices.length : event.key === 'ArrowUp' ? (index-1+choices.length)%choices.length : null;
    if (target != null) {event.preventDefault();choices[target]?.focus();}
  });
  document.addEventListener('click',event=>{if (!wrapper.contains(event.target)) close();},{signal:controller.signal});
  wrapper.addEventListener('focusout',event=>{if (event.relatedTarget && !wrapper.contains(event.relatedTarget)) close();});
  const update = () => {
    const current = select.selectedOptions[0]; trigger.textContent = current?.textContent || (en ? 'Choose' : '请选择');
    trigger.setAttribute('aria-label',`${label}：${trigger.textContent}`); trigger.disabled = select.disabled;
    if (!list.hidden) return;
    list.replaceChildren();choices = [];
    for (const option of select.options) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'pr-picker-option';
      button.setAttribute('role','option');button.setAttribute('aria-selected',String(option.selected));button.disabled = option.disabled;
      const info = describe(option.value);
      if (info?.image) {
        const image = document.createElement('img');image.src = info.image;image.alt = '';image.loading = 'lazy';image.decoding = 'async';
        if (info.round) image.className = 'pr-picker-icon--round';
        image.addEventListener('error',()=>image.remove(),{once:true});button.append(image);
      }
      const text = document.createElement('span');text.textContent = info?.name || option.textContent;button.append(text);
      if (info?.badge) {const badge = document.createElement('small');badge.textContent = info.badge;badge.dataset.state = info.state || '';button.append(badge);}
      button.addEventListener('click',()=>{
        select.value = option.value;select.dispatchEvent(new Event('change',{bubbles:true}));close();trigger.focus();
      });
      list.append(button);if (!option.disabled) choices.push(button);
    }
  };
  select.addEventListener('change',update);
  update();
  return {update,close};
}
