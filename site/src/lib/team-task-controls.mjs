import {openTeamWorkspace} from './shared-team-context.mjs';

/** Task selection and mode fields shared by the workbench and saved-team comparison. */
export function setupTeamTaskControls(host) {
  const q = selector => host.querySelector(selector);
  const events = new AbortController();
  const listen = (node, type, callback) => node.addEventListener(type, callback, {signal: events.signal});
  const automatic = q('[data-team-task="automatic"]'), saved = q('[data-team-task="saved"]');
  const savedPanel = q('[data-team-saved]');
  let comparing = false;
  const choices = [...host.querySelectorAll('[data-choices]')].map(group => ({
    select: q(`[data-${group.dataset.choices}]`), buttons: [...group.querySelectorAll('[data-choice]')]
  }));
  const refresh = () => {
    for (const {select,buttons} of choices) for (const button of buttons) button.setAttribute('aria-pressed',String(select.value === button.dataset.choice));
    savedPanel.hidden = !comparing;
    automatic.setAttribute('aria-pressed',String(!comparing));
    saved.setAttribute('aria-pressed',String(comparing));
  };
  for (const {select,buttons} of choices) for (const button of buttons) listen(button,'click',()=>{
    select.value=button.dataset.choice;select.dispatchEvent(new Event('change',{bubbles:true}));
  });
  listen(automatic,'click',()=>{comparing=false;refresh();});
  listen(saved,'click',()=>{comparing=true;refresh();});
  listen(host,'change',refresh);
  listen(host,'calculator-edit-team',()=>openTeamWorkspace());
  listen(host,'calculator-open-inventory',()=>openTeamWorkspace('inventory'));
  listen(host,'calculator-use-inventory',()=>{comparing=false;refresh();});
  if (!host.planningScenarios) q('[data-search-scope]').value=host.draft.slots.every(slot=>slot.memberCardId&&slot.supportCardId)?'selected':(host.cardInventory?.memberCardIds?.length?'owned':'theoretical');
  q('[data-search-scope]').dispatchEvent(new Event('change',{bubbles:true}));
  q('[data-search-effort]').value='practical';
  q('[data-search-effort]').dispatchEvent(new Event('change',{bubbles:true}));
  refresh();
  return {refresh,disconnect:()=>events.abort()};
}
