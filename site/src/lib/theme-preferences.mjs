import {DEFAULT_THEME, THEME_PRESETS} from './theme-presets.mjs';
import {THEME_CAMPAIGNS} from './theme-campaigns.mjs';
import {resolveThemePreference} from './theme-preference-state.mjs';
import {THEME_PICKER_COPY} from './theme-picker-view.mjs';

/** Self-contained so both HTML shells can apply a saved palette before first paint. */
export function installThemePreferences(config, resolve, win = window) {
  const doc = win.document, root = doc.documentElement;
  const previous = win.__otonoteThemePreferences;
  const previousState = previous?.getState();
  previous?.destroy();
  const events = new win.AbortController();
  let preference = previousState?.preference ?? 'auto', state, timer, saved = false;
  let pendingSave = previousState?.pendingSave ?? false, storageAvailable = !pendingSave;
  const readPreference = (externalChange = false) => {
    if (pendingSave && !externalChange) return;
    try { preference = win.localStorage.getItem(config.key) ?? 'auto'; storageAvailable = true; pendingSave = false; }
    catch { storageAvailable = false; }
  };
  const locale = () => /\/(?:global|jp)\/en(?:\/|$)/.test(win.location.pathname) || root.lang === 'en' ? 'en' : 'zh-CN';
  const query = selector => doc.querySelector(selector);
  const sync = () => {
    const lang = locale(), copy = config.copy[lang], name = state.theme.name[lang];
    for (const node of doc.querySelectorAll('[data-theme-current]')) node.textContent = name;
    for (const button of doc.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === state.preference));
    const trigger = query('[data-theme-picker-open]');
    trigger?.setAttribute('aria-label', `${copy.open} · ${name}`);
    trigger?.setAttribute('title', `${copy.open} · ${name}`);
    trigger?.setAttribute('aria-expanded', String(Boolean(query('[data-theme-picker-panel]')?.open)));
    query('[data-theme-picker-close]')?.setAttribute('aria-label', copy.close);
    const status = query('[data-theme-status]');
    if (status) status.textContent = (state.preference === 'auto' ? copy.following : copy.manual).replace('{name}', name)
      + (state.campaign ? ` · ${state.campaign.name[lang]}` : '');
    const storage = query('[data-theme-storage-status]');
    if (storage) storage.textContent = !storageAvailable ? copy.saveUnavailable : saved ? copy.saved : '';
  };
  const apply = () => {
    state = resolve(preference, config.themes, config.campaigns, config.defaultTheme);
    preference = state.preference;
    // Only UI palette variables change; game identity variables are never touched.
    for (const [key, value] of Object.entries(state.theme.tokens)) {
      if (root.style.getPropertyValue(`--theme-${key}`) !== value) root.style.setProperty(`--theme-${key}`, value);
    }
    root.dataset.theme = state.theme.id;
    root.dataset.themePreference = state.preference;
    if (state.campaign) root.dataset.themeCampaign = state.campaign.id;
    else delete root.dataset.themeCampaign;
    sync();
    win.clearTimeout(timer);
    if (state.nextChangeAt !== null) timer = win.setTimeout(apply, Math.min(2147483647, Math.max(1, state.nextChangeAt - Date.now() + 1)));
  };
  const choose = value => {
    preference = value; saved = true;
    // Normalize stale/unknown identifiers before saving them.
    preference = resolve(preference, config.themes, config.campaigns, config.defaultTheme).preference;
    try { win.localStorage.setItem(config.key, preference); storageAvailable = true; pendingSave = false; }
    catch { storageAvailable = false; pendingSave = true; }
    apply();
  };
  const close = () => {
    query('[data-theme-picker-panel]')?.close();
    query('[data-theme-picker-open]')?.focus({preventScroll:true});
    sync();
  };
  doc.addEventListener('click', event => {
    const target = event.target;
    if (target.closest?.('[data-theme-picker-open]')) {
      const dialog = query('[data-theme-picker-panel]');
      dialog.showModal(); sync();
      dialog.querySelector('[data-theme-picker-close]')?.focus({preventScroll:true});
      dialog.querySelector('.theme-picker-body').scrollTop = 0;
    } else if (target.closest?.('[data-theme-picker-close]')) close();
    else if (target.closest?.('[data-theme-choice]')) choose(target.closest('[data-theme-choice]').dataset.themeChoice);
    else if (target.matches?.('[data-theme-picker-panel]')) {
      const rect = target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    }
  }, {signal:events.signal});
  doc.addEventListener('close', event => {if (event.target.matches?.('[data-theme-picker-panel]')) sync();}, {capture:true, signal:events.signal});
  doc.addEventListener('DOMContentLoaded', sync, {once:true, signal:events.signal});
  doc.addEventListener('astro:page-load', sync, {signal:events.signal});
  doc.addEventListener('visibilitychange', () => {if (!doc.hidden) apply();}, {signal:events.signal});
  win.addEventListener('pageshow', () => {readPreference(); apply();}, {signal:events.signal});
  win.addEventListener('storage', event => {
    if (event.key === config.key || event.key === null) {readPreference(true); saved = false; apply();}
  }, {signal:events.signal});
  const destroy = () => {events.abort(); win.clearTimeout(timer);};
  doc.addEventListener('ournotes:shell-dispose', destroy, {once:true, signal:events.signal});
  readPreference(); apply();
  const controller = {getState:() => ({...state, pendingSave}), choose, destroy};
  win.__otonoteThemePreferences = controller;
  return controller;
}

export function createThemePreferencesScript() {
  const config = {key:'otonote-theme-v1', defaultTheme:DEFAULT_THEME, themes:THEME_PRESETS, campaigns:THEME_CAMPAIGNS, copy:THEME_PICKER_COPY};
  return `(${installThemePreferences.toString()})(${JSON.stringify(config).replace(/</g, '\\u003c')}, ${resolveThemePreference.toString()});`;
}
