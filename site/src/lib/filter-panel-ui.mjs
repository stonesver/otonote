import { selectedControlValues } from './filter-controls.mjs';

const data = document.querySelector('[data-filter-visuals]');
const visuals = data ? JSON.parse(data.textContent || '{}') : {};
const controls = [];
function getVisual(select, option) {
  let kind = select.dataset.filterKind || select.name;
  if (kind.includes('attribute') || kind === 'music-type') kind = 'attribute';
  if (kind.includes('rarity')) kind = 'rarity';
  if (kind.includes('band')) kind = 'band';
  if (kind === 'target') kind = option.value.startsWith('band-') ? 'band' : 'character';
  return (visuals[kind] || []).find(v => v.id === option.value || v.value === option.value || v.label === option.textContent);
}
function enhance(select) {
  const label = select.closest('label');
  if (!label || select.dataset.enhanced) return;
  select.dataset.enhanced = 'true';
  const title = label.querySelector('span')?.textContent || [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
  const group = document.createElement('fieldset');
  group.className = 'facet-group';
  const legend = document.createElement('legend'); legend.textContent = title;
  group.append(legend);
  const body = document.createElement('div'); body.className = 'facet-group-body';
  const list = document.createElement('div'); list.className = 'facet-option-list';
  if (select.options.length > 13) {
    const searchLabel = document.createElement('label'); searchLabel.className = 'facet-option-search';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = `查找${title}…`; search.setAttribute('aria-label', `查找${title}`);
    search.addEventListener('input', event => { event.stopPropagation(); for (const button of list.children) button.hidden = !button.title.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()); });
    search.addEventListener('change', event => event.stopPropagation());
    searchLabel.append(search); body.append(searchLabel);
  }
  const entries = [...select.options].map(option => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'facet-check';
    const name = option.textContent.trim(); button.title = name; button.setAttribute('aria-label', name);
    const visual = getVisual(select, option);
    const iconSrc = visual?.circleIcon || visual?.icon;
    const isRound = Boolean(visual?.circleIcon || visual?.round);
    if (iconSrc) {
      const image = document.createElement('img'); image.src = iconSrc; image.alt = ''; image.loading = 'lazy'; image.className = `filter-option-icon${isRound ? ' filter-option-icon--round' : ''}`;
      const fallback = visual?.fallbackIcon || (visual?.circleIcon ? visual?.icon : '');
      if (fallback) {
        image.addEventListener('error', () => { image.src = fallback; image.classList.remove('filter-option-icon--round'); }, { once: true });
      }
      button.append(image);
    }
    if (iconSrc) button.classList.add('filter-icon-only');
    else button.append(document.createTextNode(name));
    button.addEventListener('click', () => {
      if (select.multiple) {
        if (!option.value || option.value === 'all') for (const item of select.options) item.selected = item === option;
        else {
          option.selected = !option.selected;
          for (const item of select.options) if (!item.value || item.value === 'all') item.selected = false;
        }
      } else select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      refresh();
    });
    list.append(button);
    return { option, button };
  });
  label.replaceWith(group);
  select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-label', title);
  body.append(select, list); group.append(body);
  controls.push({ select, entries });
}
function refresh() {
  for (const {select, entries} of controls) {
    const values = selectedControlValues(select);
    for (const {option, button} of entries) {
      button.setAttribute('aria-pressed', String(option.value && option.value !== 'all' ? values.includes(option.value) : !values.length));
      button.disabled = select.disabled || option.disabled;
    }
  }
  for (const panel of document.querySelectorAll('.filter-panel')) {
    if (panel.matches('filter-drawer')) continue;
    const count = panel.querySelector('[data-panel-count]');
    if (!count) continue;
    const total = panel.querySelectorAll('input[type=checkbox]:checked').length + [...panel.querySelectorAll('[data-inline-filter]')].reduce((sum, select) => sum + selectedControlValues(select).length, 0);
    count.textContent = String(total); count.hidden = !total;
  }
}
function initialize() {
  document.querySelectorAll('select[data-inline-filter]').forEach(enhance);
  for (const form of document.querySelectorAll('form:has(.filter-panel)')) form.addEventListener('submit', event => event.preventDefault());
  refresh();
}
// Run after the existing page controllers have restored their URL state.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
for (const name of ['change', 'input', 'reset', 'click', 'filter-controls-sync']) document.addEventListener(name, () => queueMicrotask(refresh));
window.addEventListener('popstate', () => queueMicrotask(refresh));
