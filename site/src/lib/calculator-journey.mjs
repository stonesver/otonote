import {planningUiText} from './team-planning-translations.mjs';
/** Bind the single current layout; the template owns all controls and panels. */
export function setupCalculatorJourney(workbench) {
  const q = selector => workbench.querySelector(selector);
  const ui=text=>planningUiText(text,workbench.data.locale);
  const root = q('.calculator-journey');
  if (!root) return null;
  const events = new AbortController();
  const listen = (node, type, callback) => node.addEventListener(type, callback, {signal: events.signal});
  const automatic = q('[data-journey-task="automatic"]'), saved = q('[data-journey-task="saved"]');
  const panels = [...root.querySelectorAll('.journey-step')];
  const savedPanel = q('.journey-saved'), manual = q('.journey-manual');
  const choices = [...root.querySelectorAll('[data-choices]')].map(group => ({
    select: q(`[data-${group.dataset.choices}]`), buttons: [...group.querySelectorAll('[data-choice]')]
  }));
  let savedMode = false, manualRequested = false;
  for (const {select, buttons} of choices) for (const button of buttons) {
    listen(button, 'click', () => {
      select.value = button.dataset.choice;
      select.dispatchEvent(new Event('change', {bubbles: true}));
      if (select === q('[data-search-scope]') && select.value === 'owned') q('[data-inventory-editor]').open = true;
    });
  }
  function refresh() {
    const state = workbench.optimizerState ?? {};
    q('.journey-context').textContent = state.songReady
      ? `${q('[data-song-selection]').textContent} · ${q(savedMode ? '[data-preset-mode]' : '[data-pairing-mode]').value === 'gekisou' ? ui('激奏演出') : ui('普通自由演出')}`
      : ui('先选歌，再选择卡片和这次想比较的条件。');
    for (const {select, buttons} of choices) for (const button of buttons) {
      button.setAttribute('aria-pressed', String(select.value === button.dataset.choice));
    }
    const scope = q('[data-search-scope]').value;
    q('[data-inventory-editor]').hidden = scope !== 'owned';
    manual.hidden = scope !== 'selected' && !manualRequested && workbench.planningScenarios?.kind !== 'trial';
    if (scope === 'selected') manual.open = true;
    savedPanel.hidden = !savedMode;
    panels.forEach(panel => { panel.hidden = savedMode; });
    automatic.setAttribute('aria-pressed', String(!savedMode));
    saved.setAttribute('aria-pressed', String(savedMode));
  }
  function editInventory(scope) {
    savedMode = false;
    q('[data-search-scope]').value = scope;
    q('[data-search-scope]').dispatchEvent(new Event('change', {bubbles: true}));
    panels[1].scrollIntoView({block: 'start', behavior: 'auto'});
  }
  listen(automatic, 'click', () => { savedMode = false; refresh(); });
  listen(saved, 'click', () => { savedMode = true; refresh(); });
  listen(q('[data-team-slots]'), 'click', () => { q('.journey-card-picker').open = true; });
  listen(workbench, 'optimizer-ui-state', refresh);
  listen(workbench, 'change', refresh);
  listen(workbench, 'calculator-edit-team', () => {
    if(workbench.planningScenarios){savedMode=false;manualRequested=true;refresh();manual.open=true;panels[1].scrollIntoView({block:'start',behavior:'auto'});}
    else editInventory('selected');
  });
  listen(workbench, 'calculator-open-inventory', () => editInventory('owned'));
  listen(workbench, 'calculator-use-inventory', () => {
    savedMode = false; refresh(); panels[2].scrollIntoView({block: 'start', behavior: 'auto'});
  });
  if (!workbench.planningScenarios) q('[data-search-scope]').value = workbench.draft.slots.every(slot => slot.memberCardId && slot.supportCardId) ? 'selected' : (workbench.cardInventory?.memberCardIds?.length ? 'owned' : 'theoretical');
  q('[data-search-scope]').dispatchEvent(new Event('change', {bubbles: true}));
  q('[data-search-effort]').value = 'practical';
  q('[data-search-effort]').dispatchEvent(new Event('change', {bubbles: true}));
  refresh();
  return {refresh, disconnect: () => events.abort()};
}
