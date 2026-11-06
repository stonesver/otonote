import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {THEME_PRESETS, DEFAULT_THEME} from '../src/lib/theme-presets.mjs';
import {THEME_CAMPAIGNS} from '../src/lib/theme-campaigns.mjs';
import {resolveThemePreference} from '../src/lib/theme-preference-state.mjs';
import {installThemePreferences, createThemePreferencesScript} from '../src/lib/theme-preferences.mjs';
import {THEME_PICKER_COPY, renderThemePicker} from '../src/lib/theme-picker-view.mjs';

const future = Date.now() + 60_000;
const config = {key:'otonote-theme-v1', themes:THEME_PRESETS, defaultTheme:DEFAULT_THEME, campaigns:[{...THEME_CAMPAIGNS[0],startsAt:new Date(future).toISOString(),endsAt:new Date(future + 60_000).toISOString()}], copy:THEME_PICKER_COPY};
const at = (preference, time, campaigns = THEME_CAMPAIGNS) => resolveThemePreference(preference, THEME_PRESETS, campaigns, DEFAULT_THEME, Date.parse(time));

test('activity windows respect their timezone, start inclusively and end exclusively', () => {
  assert.equal(at('auto', '2026-12-23T15:59:59Z').theme.id, 'classic');
  assert.equal(at('auto', '2026-12-23T16:00:00Z').theme.id, 'christmas');
  assert.equal(at('auto', '2026-12-26T16:00:00Z').theme.id, 'classic');
  assert.equal(at('auto', '2026-12-31T16:00:00Z').theme.id, 'new-year');
  assert.equal(at('auto', '2027-01-03T16:00:00Z').theme.id, 'classic');
});

test('manual themes persist during campaigns; overlapping events pick the latest start', () => {
  const event = {id:'anniversary-test',theme:'anniversary',name:{'zh-CN':'周年',en:'Anniversary'},startsAt:'2026-12-25T00:00:00+08:00',endsAt:'2026-12-26T00:00:00+08:00'};
  const campaigns = [...THEME_CAMPAIGNS, event];
  assert.equal(at('auto','2026-12-25T12:00:00+08:00', campaigns).theme.id,'anniversary');
  assert.equal(at('auto','2026-12-26T00:00:00+08:00', campaigns).theme.id,'christmas');
  const manual = at('apricot','2026-12-25T12:00:00+08:00',campaigns);
  assert.equal(manual.theme.id,'apricot');
  assert.equal(manual.campaign,null);
  assert.equal(manual.nextChangeAt,null);
  assert.equal(at('retired-theme','2026-12-25T12:00:00+08:00').preference,'auto');
});

test('campaign attributes choose their matching palette; an explicit theme takes priority', () => {
  const event = {id:'attribute-event',attribute:3,name:{'zh-CN':'活动',en:'Event'},startsAt:'2026-11-01T00:00:00+08:00',endsAt:'2026-11-08T00:00:00+08:00'};
  const now = '2026-11-06T12:00:00+08:00';
  assert.equal(at('auto', now, [event]).theme.id, 'attribute-jade');
  assert.equal(at('auto', now, [{...event, theme:'anniversary'}]).theme.id, 'anniversary');
  assert.equal(at('apricot', now, [event]).theme.id, 'apricot');
  assert.equal(at('auto', now, [{...event, attribute:99}]).theme.id, 'classic');
  assert.equal(at('auto', event.endsAt, [event]).theme.id, 'classic');
});

function browser(preference = 'night') {
  const values = new Map([['otonote-theme-v1',preference]]), properties = new Map([['--attribute-color','#f03']]);
  let denied = false, writesDenied = false;
  const root = {lang:'zh-CN', dataset:{}, style:{getPropertyValue:key=>properties.get(key)??'',setProperty:(key,value)=>properties.set(key,value)}};
  const doc = new EventTarget();
  Object.assign(doc,{documentElement:root,querySelector:()=>null,querySelectorAll:()=>[],hidden:false});
  const win = new EventTarget(), timers = new Map();
  Object.assign(win,{document:doc,location:{pathname:'/global/zh-CN/'},AbortController,
    localStorage:{getItem(key){if(denied)throw Error('blocked');return values.get(key)??null;},setItem(key,value){if(denied || writesDenied)throw Error('blocked');values.set(key,value);}},
    setTimeout(callback,delay){const id=timers.size+1;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id)});
  return {win,doc,root,values,properties,timers,denyStorage:()=>{denied=true;},denyWrites:()=>{writesDenied=true;}};
}

test('saved choices apply before page content; choosing a palette never changes game variables', () => {
  const env = browser();
  const controller = installThemePreferences(config,resolveThemePreference,env.win);
  assert.equal(env.root.dataset.theme,'night');
  controller.choose('new-year');
  assert.equal(env.values.get(config.key),'new-year');
  assert.equal(env.root.dataset.theme,'new-year');
  assert.equal(env.properties.get('--attribute-color'),'#f03');
  controller.destroy();
});

test('cross-tab changes and reset synchronize; a storage failure still allows session switching', () => {
  const env = browser();
  const controller = installThemePreferences(config,resolveThemePreference,env.win);
  env.values.set(config.key,'anniversary');
  const event = new Event('storage');event.key=config.key;env.win.dispatchEvent(event);
  assert.equal(env.root.dataset.theme,'anniversary');
  env.values.clear();
  const reset = new Event('storage');reset.key=null;env.win.dispatchEvent(reset);
  assert.equal(controller.getState().preference,'classic');
  assert.equal(env.timers.size,0);
  controller.choose('auto');
  assert.equal(env.values.get(config.key),'auto');
  assert.ok(env.timers.size > 0);
  env.denyStorage();controller.choose('christmas');
  assert.equal(env.root.dataset.theme,'christmas');
  assert.equal(env.timers.size,0);
  const next=installThemePreferences(config,resolveThemePreference,env.win);
  assert.equal(next.getState().preference,'christmas','cold-shell replacement retains an unsaved session choice');
  next.destroy();
});

test('inline bootstrap runs independently and disposes scheduled updates with its shell', () => {
  const env = browser('auto');
  class TestDate extends Date { static now() { return Date.parse('2026-11-06T00:00:00Z'); } }
  vm.runInNewContext(createThemePreferencesScript(), {window:env.win, Date:TestDate});
  assert.equal(env.root.dataset.themePreference,'auto');
  assert.ok(env.timers.size > 0);
  env.doc.dispatchEvent(new Event('ournotes:shell-dispose'));
  assert.equal(env.timers.size,0);
});

test('inline first paint uses classic for new visits while saved choices and explicit auto stay effective', () => {
  class TestDate extends Date { static now() { return Date.parse('2026-12-24T00:00:00Z'); } }
  for (const [saved, expected, denied] of [
    [null, 'classic', false],
    [null, 'classic', true],
    ['paper', 'paper', false],
    ['night', 'night', false],
    ['auto', 'christmas', false],
  ]) {
    const env = browser(saved);
    if (saved === null) env.values.clear();
    if (denied) env.denyStorage();
    vm.runInNewContext(createThemePreferencesScript(), {window:env.win, Date:TestDate});
    assert.equal(env.root.dataset.themePreference, saved ?? 'classic');
    assert.equal(env.root.dataset.theme, expected);
    const palette = THEME_PRESETS.find(theme => theme.id === expected).tokens;
    for (const key of ['canvas', 'surface', 'accent', 'secondary']) {
      assert.equal(env.properties.get(`--theme-${key}`), palette[key]);
    }
    assert.equal(env.values.get(config.key), saved ?? undefined, 'startup never overwrites a saved choice');
    assert.equal(env.properties.get('--attribute-color'), '#f03');
    env.win.__otonoteThemePreferences.destroy();
  }
});

test('a saved retired mist choice follows automatic defaults and active campaigns on first paint', () => {
  for (const [now, expected] of [
    ['2026-11-06T00:00:00Z', DEFAULT_THEME],
    ['2026-12-24T00:00:00Z', 'christmas'],
  ]) {
    const env = browser('mist');
    class TestDate extends Date { static now() { return Date.parse(now); } }
    vm.runInNewContext(createThemePreferencesScript(), {window:env.win, Date:TestDate});
    assert.equal(env.win.__otonoteThemePreferences.getState().preference, 'auto');
    assert.equal(env.root.dataset.themePreference, 'auto');
    assert.equal(env.root.dataset.theme, expected);
    assert.equal(env.properties.get('--theme-accent'), THEME_PRESETS.find(theme => theme.id === expected).tokens.accent);
    env.win.__otonoteThemePreferences.destroy();
  }
});

test('a quota failure retains the new session choice across pageshow and shell replacement', () => {
  const env = browser('paper');env.denyWrites();
  const controller = installThemePreferences(config,resolveThemePreference,env.win);
  controller.choose('night');
  assert.equal(env.values.get(config.key),'paper');
  env.win.dispatchEvent(new Event('pageshow'));
  assert.equal(env.root.dataset.theme,'night');
  const next = installThemePreferences(config,resolveThemePreference,env.win);
  assert.equal(env.root.dataset.theme,'night');
  assert.equal(next.getState().pendingSave,true);
  env.values.set(config.key,'apricot');
  const external = new Event('storage');external.key=config.key;env.win.dispatchEvent(external);
  assert.equal(env.root.dataset.theme,'apricot');
  assert.equal(next.getState().pendingSave,false);
  next.destroy();
});

test('normal and cold selectors expose the same choices and English translations', () => {
  for(const html of [renderThemePicker('en'),renderThemePicker('zh-CN',{loading:true})]){
    for(const id of ['auto',...THEME_PRESETS.map(theme=>theme.id)]) assert.ok(html.includes(`data-theme-choice="${id}"`));
    assert.ok(!html.includes('data-theme-choice="mist"'));
    assert.match(html,/data-theme-choice="classic" aria-pressed="true"/);
    assert.match(html,/data-theme-choice="auto" aria-pressed="false"/);
    assert.match(html,/aria-haspopup="dialog"/);
    assert.match(html,/data-theme-storage-status aria-live="polite"/);
  }
  assert.ok(renderThemePicker('zh-CN',{loading:true}).includes('data-loading-en="Appearance"'));
  assert.ok(renderThemePicker('zh-CN').includes('已固定配色 · 原版'));
  assert.ok(renderThemePicker('en').includes('Fixed palette · Classic'));
});
