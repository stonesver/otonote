import {presenceLabel} from './edition-library.mjs';
import { modelLabel } from './live2d-labels.mjs';

export function lookKind(model) {
  const name = model.modelPath.split('/').at(-1);
  if (/_(child|virtual|silhouette|still|detective|soundonly)(_|$)/.test(name)) return 'special';
  if (name.includes('_school_')) return 'school';
  if (name.includes('_live_')) return 'stage';
  if (/_(casual|roomwear|arbeit)(_|$)/.test(name)) return 'daily';
  return 'special';
}

export function filterCharacters(characters, models, group, search) {
  const term = search.trim().toLowerCase();
  return characters.filter(c => (group === 'all' || c.group === group)
    && [c.name, c.id, ...(c.aliases || []), ...models.filter(m => String(m.characterId) === String(c.id)).map(m => m.modelPath)]
      .some(value => String(value).toLowerCase().includes(term)));
}

export function filterLooks(models, character, kind, search, en = false) {
  const term = search.trim().toLowerCase();
  return models.filter(m => String(m.characterId) === String(character) && (kind === 'all' || lookKind(m) === kind)
    && `${modelLabel(m, en)} ${m.modelPath}`.toLowerCase().includes(term));
}

export function adjacentLook(models, id, direction) {
  const current = models.find(m => m.id === id);
  const available = models.filter(m => m.characterId === current?.characterId && m.state === 'available');
  const index = available.findIndex(m => m.id === id);
  return available.length ? available[(Math.max(0, index) + direction + available.length) % available.length] : undefined;
}

export class ModelPicker {
  constructor(host, config, selected, onSelect, signal) {
    this.host = host; this.config = config; this.selected = selected; this.onSelect = onSelect;
    this.q = selector => host.querySelector(selector);
    this.say = (zh, en) => config.en ? en : zh;
    this.group = 'all'; this.kind = 'all'; this.browsing = selected?.characterId;
    this.dialog = this.q('[data-picker]');
    const listen = (selector, event, fn) => this.q(selector).addEventListener(event, fn, { signal });
    listen('[data-picker-open]', 'click', () => this.open());
    listen('[data-picker-close]', 'click', () => this.dialog.close());
    listen('[data-character-search]', 'input', () => this.renderCharacters());
    listen('[data-costume-search]', 'input', () => this.renderLooks());
    listen('[data-costume-prev]', 'click', () => this.step(-1));
    listen('[data-costume-next]', 'click', () => this.step(1));
    this.dialog.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.characterChoice != null) {
        this.browsing = button.dataset.characterChoice; this.kind = 'all'; this.q('[data-costume-search]').value = '';
        this.highlightCharacters(); this.renderLooks();
      } else if (button.dataset.groupChoice != null) {
        this.group = button.dataset.groupChoice; this.renderCharacters();
      } else if (button.dataset.kindChoice != null) {
        this.kind = button.dataset.kindChoice; this.renderLooks();
      } else if (button.dataset.lookChoice != null) {
        this.choose(config.models.find(m => m.id === button.dataset.lookChoice)); this.dialog.close();
      } else if (button.hasAttribute('data-clear-characters')) {
        this.group = 'all'; this.q('[data-character-search]').value = ''; this.renderCharacters();
      } else if (button.hasAttribute('data-clear-looks')) {
        this.kind = 'all'; this.q('[data-costume-search]').value = ''; this.renderLooks();
      }
    }, { signal });
    this.update(selected);
  }

  open() {
    this.browsing = this.selected?.characterId;
    this.group = 'all'; this.kind = 'all';
    this.q('[data-character-search]').value = ''; this.q('[data-costume-search]').value = '';
    this.renderCharacters(); this.renderLooks(); this.dialog.showModal();
    this.q('[data-character-search]').focus();
  }

  step(direction) { this.choose(adjacentLook(this.config.models, this.selected?.id, direction)); }

  choose(model) {
    if (!model || model.state !== 'available' || model.id === this.selected?.id) return;
    this.update(model); this.onSelect(model);
  }

  avatar(character) {
    const node = document.createElement('span'); node.className = 'l2d-avatar'; node.setAttribute('aria-hidden', 'true');
    if (character?.portrait) {
      const img = document.createElement('img'); img.src = character.portrait; img.alt = ''; img.loading = 'lazy';
      img.addEventListener('error', () => img.replaceWith(document.createTextNode(character.name.slice(0, 2))), { once: true });
      node.append(img);
    } else node.textContent = character?.name.slice(0, 2) || '—';
    return node;
  }

  update(model) {
    this.selected = model;
    const character = this.config.characters.find(c => c.id === model?.characterId);
    this.q('[data-selected-avatar]').replaceChildren(...this.avatar(character).childNodes);
    this.q('[data-selected-name]').textContent = character?.name || this.say('暂无模型', 'No models');
    this.q('[data-selected-group]').textContent = character?.groupName || 'LIVE2D';
    this.q('[data-selected-costume]').textContent = model ? [modelLabel(model, this.config.en), presenceLabel(model.editionPresence, this.config.en)].filter(Boolean).join(' · ') : '';
    const choices = this.config.models.filter(m => m.characterId === model?.characterId && m.state === 'available');
    this.q('[data-costume-position]').textContent = choices.length ? `${choices.findIndex(m => m.id === model?.id) + 1} / ${choices.length}` : '0 / 0';
    this.q('[data-costume-prev]').disabled = this.q('[data-costume-next]').disabled = choices.length < 2;
    this.q('[data-picker-open]').disabled = !this.config.models.length;
  }

  chip(label, key, value, active) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.dataset[key] = value; button.setAttribute('aria-pressed', String(active)); return button;
  }

  empty(container, message, attribute) {
    const box = document.createElement('div'); box.className = 'l2d-empty';
    const text = document.createElement('p'); text.textContent = message;
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = this.say('清除筛选', 'Clear filters'); reset.setAttribute(attribute, '');
    box.append(text, reset); container.append(box);
  }

  renderCharacters() {
    const focusedGroup = document.activeElement?.dataset?.groupChoice;
    const { characters, models } = this.config;
    const groups = [...new Map(characters.map(c => [c.group, c.groupName])).entries()];
    this.q('[data-character-groups]').replaceChildren(this.chip(this.say('全部', 'All'), 'groupChoice', 'all', this.group === 'all'),
      ...groups.map(([id, name]) => this.chip(name, 'groupChoice', id, this.group === id)));
    const matches = filterCharacters(characters, models, this.group, this.q('[data-character-search]').value);
    this.q('[data-library-count]').textContent = `${matches.length} ${this.say('个角色条目', 'characters')}`;
    const list = this.q('[data-character-list]');
    list.replaceChildren(...matches.map(c => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'l2d-character-card';
      button.dataset.characterChoice = String(c.id); button.style.setProperty('--card-accent', c.color);
      const name = document.createElement('strong'); name.textContent = c.name;
      const count = document.createElement('small'); count.textContent = `${models.filter(m => m.characterId === c.id).length} ${this.say('套造型', 'looks')}`;
      const copy = document.createElement('span'); copy.append(name, count); button.append(this.avatar(c), copy);
      return button;
    }));
    if (!matches.length) this.empty(list, this.say('没有找到角色，试试其他名字或分组。', 'No characters found. Try another name or group.'), 'data-clear-characters');
    this.highlightCharacters();
    if (focusedGroup != null) [...this.q('[data-character-groups]').children].find(b => b.dataset.groupChoice === focusedGroup)?.focus();
  }

  highlightCharacters() {
    this.host.querySelectorAll('[data-character-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.characterChoice === String(this.browsing))));
  }

  renderLooks() {
    const focusedKind = document.activeElement?.dataset?.kindChoice;
    const c = this.config.characters.find(c => String(c.id) === String(this.browsing));
    this.q('[data-browsing-name]').textContent = c?.name || this.say('请选择角色', 'Choose a character');
    const all = this.config.models.filter(m => String(m.characterId) === String(this.browsing));
    const kinds = [['all', this.say('全部', 'All')], ['daily', this.say('日常', 'Everyday')], ['school', this.say('校服', 'School')],
      ['stage', this.say('演出', 'Stage')], ['special', this.say('特殊', 'Special')]];
    this.q('[data-costume-types]').replaceChildren(...kinds.filter(([id]) => id === 'all' || all.some(m => lookKind(m) === id))
      .map(([id, label]) => this.chip(label, 'kindChoice', id, this.kind === id)));
    const matches = filterLooks(this.config.models, this.browsing, this.kind, this.q('[data-costume-search]').value, this.config.en);
    this.q('[data-costume-count]').textContent = `${matches.length} / ${all.length} ${this.say('套造型', 'looks')}`;
    const list = this.q('[data-costume-list]');
    list.replaceChildren(...matches.map(model => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'l2d-costume-card';
      button.dataset.lookChoice = model.id; button.disabled = model.state !== 'available'; button.setAttribute('aria-pressed', String(model.id === this.selected?.id));
      button.style.setProperty('--card-accent', c?.color || 'var(--theme-muted)');
      const tag = document.createElement('span'); tag.className = 'l2d-look-tag';
      tag.textContent = model.id === this.selected?.id ? this.say('✓ 当前造型', '✓ Current look') : model.isDefault ? this.say('推荐 · 默认', 'Default') : kinds.find(([id]) => id === lookKind(model))?.[1];
      const name = document.createElement('strong'); name.textContent = modelLabel(model, this.config.en);
      const meta = document.createElement('small'); meta.textContent = model.state === 'available'
        ? `${(model.bytes / 1024 / 1024).toFixed(1)} MB · ${model.motions} ${this.say('动作', 'motions')} · ${model.expressions} ${this.say('表情', 'expressions')}`
        : this.say('资源暂不可用', 'Unavailable');
      button.append(tag, name, meta);
      const label=presenceLabel(model.editionPresence,this.config.en);
      if(label){const badge=document.createElement('small');badge.className='edition-mark';badge.textContent=label;button.append(badge);}
      return button;
    }));
    if (!matches.length) this.empty(list, this.say('没有匹配的造型，试试清除筛选。', 'No matching looks. Try clearing the filters.'), 'data-clear-looks');
    if (focusedKind != null) [...this.q('[data-costume-types]').children].find(b => b.dataset.kindChoice === focusedKind)?.focus();
  }

  dispose() { if (this.dialog.open) this.dialog.close(); }
}
