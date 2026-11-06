import { DEFAULT_THEME, THEME_PRESETS } from './theme-presets.mjs';

export const THEME_PICKER_COPY = {
  'zh-CN': {
    open: '外观',
    title: '网站外观',
    close: '关闭外观设置',
    current: '当前配色',
    automatic: '跟随活动',
    automaticDescription: '按活动日程切换，也可在下方固定配色。',
    following: '跟随活动 · {name}',
    manual: '已固定配色 · {name}',
    saved: '已保存到此浏览器。',
    saveUnavailable: '本次已切换，但此浏览器无法保存配色。',
    filterLabel: '筛选配色',
    all: '全部',
    groups: { everyday: '日常配色', attribute: '活动属性', occasion: '节日纪念', dark: '深色备选' }
  },
  en: {
    open: 'Appearance',
    title: 'Site appearance',
    close: 'Close appearance settings',
    current: 'Current palette',
    automatic: 'Follow events',
    automaticDescription: 'Use the event schedule, or keep a palette below.',
    following: 'Following events · {name}',
    manual: 'Fixed palette · {name}',
    saved: 'Saved in this browser.',
    saveUnavailable: 'Applied for now. This browser could not save your palette.',
    filterLabel: 'Filter palettes',
    all: 'All',
    groups: { everyday: 'Everyday', attribute: 'Event attributes', occasion: 'Celebrations', dark: 'Dark' }
  }
};

const escape = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const svg = content => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
const paletteIcon = svg('<path d="M12 3a9 9 0 1 0 0 18h1.2a2.3 2.3 0 0 0 1.7-3.8 1.3 1.3 0 0 1 1-2.2H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z"/><circle cx="7.5" cy="10" r=".9"/><circle cx="11" cy="6.8" r=".9"/><circle cx="16" cy="8" r=".9"/><circle cx="6.8" cy="14.5" r=".9"/>');
const eventIcon = svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-11 4h2m2 0h2m-6 3h2"/>');
const checkIcon = svg('<path d="m6 12 4 4 8-8"/>');
const closeIcon = svg('<path d="m6 6 12 12M18 6 6 18"/>');

/** Shared markup for rendered pages and the content-independent loading shell. */
export function renderThemePicker(locale = 'zh-CN', { loading = false } = {}) {
  const language = locale === 'en' ? 'en' : 'zh-CN';
  const copy = THEME_PICKER_COPY[language];
  const english = THEME_PICKER_COPY.en;
  const text = (value, englishValue, attributes = '') => `<span${attributes}${loading ? ` data-loading-en="${escape(englishValue)}"` : ''}>${escape(value)}</span>`;
  const defaultPreset = THEME_PRESETS.find(preset => preset.id === DEFAULT_THEME);
  const currentName = defaultPreset.name[language];
  const groups = ['everyday', 'attribute', 'occasion', 'dark'];
  const card = preset => {
    const preview = ['canvas', 'surface', 'accent', 'secondary', 'text'].map(key => `--preview-${key}:${preset.tokens[key]}`).join(';');
    return `<button class="theme-picker-card" type="button" data-theme-choice="${escape(preset.id)}" aria-pressed="${preset.id === DEFAULT_THEME}">
      <span class="theme-picker-preview" data-preview-theme="${escape(preset.id)}" style="${escape(preview)}" aria-hidden="true">
        <span class="theme-picker-preview__nav"><b>O</b><i></i><i></i><i></i></span>
        <span class="theme-picker-preview__content"><span class="theme-picker-preview__header">OtoNote</span><span class="theme-picker-preview__panels"><i></i><i></i></span></span>
      </span>
      <span class="theme-picker-card__copy"><span class="theme-picker-card__name">${text(preset.name[language], preset.name.en)}</span>${text(preset.description[language], preset.description.en, ' class="theme-picker-card__description"')}</span>
      <span class="theme-picker-check" aria-hidden="true">${checkIcon}</span>
    </button>`;
  };
  return `<button class="theme-picker-trigger" type="button" data-theme-picker-open aria-haspopup="dialog" aria-controls="theme-picker-dialog" aria-label="${escape(copy.title)}" title="${escape(copy.title)}">${paletteIcon}${text(copy.open, english.open, ' class="theme-picker-trigger__label"')}</button>
    <dialog class="theme-picker-dialog" id="theme-picker-dialog" data-theme-picker-panel aria-labelledby="theme-picker-title">
      <header class="theme-picker-heading">
        <div><h2 id="theme-picker-title">${text(copy.title, english.title)}</h2><p>${text(copy.current, english.current)}<span aria-hidden="true"> · </span>${text(currentName, defaultPreset.name.en, ' data-theme-current')}</p></div>
        <button class="theme-picker-close" type="button" data-theme-picker-close aria-label="${escape(copy.close)}" title="${escape(copy.close)}">${closeIcon}</button>
      </header>
      <div class="theme-picker-filters" role="group" aria-label="${escape(copy.filterLabel)}" data-theme-filters>
        <button type="button" data-theme-filter="all" aria-pressed="true">${text(copy.all, english.all)}</button>
        ${groups.map(group => `<button type="button" data-theme-filter="${group}" aria-pressed="false">${text(copy.groups[group], english.groups[group])}</button>`).join('')}
      </div>
      <div class="theme-picker-body">
        <button class="theme-picker-auto" type="button" data-theme-choice="auto" aria-pressed="false">
          <span class="theme-picker-auto__icon" aria-hidden="true">${eventIcon}</span>
          <span class="theme-picker-auto__copy">${text(copy.automatic, english.automatic, ' class="theme-picker-auto__name"')}${text(copy.automaticDescription, english.automaticDescription, ' class="theme-picker-auto__description"')}</span>
          <span class="theme-picker-check" aria-hidden="true">${checkIcon}</span>
        </button>
        ${groups.map(group => `<section class="theme-picker-group" data-theme-group="${group}" aria-labelledby="theme-picker-${group}"><h3 id="theme-picker-${group}">${text(copy.groups[group], english.groups[group])}</h3><div class="theme-picker-grid">${THEME_PRESETS.filter(preset => preset.group === group).map(card).join('')}</div></section>`).join('')}
      </div>
      <footer class="theme-picker-footer"><p data-theme-status role="status">${text(copy.manual.replace('{name}', currentName), english.manual.replace('{name}', defaultPreset.name.en))}</p><p data-theme-storage-status aria-live="polite" aria-atomic="true"></p></footer>
    </dialog>`;
}
