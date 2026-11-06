import bandIcons from './arena-band-icons.json';
import { createPersonalGrowthStore } from './personal-growth-store.mjs';
import { createTeamWorkspaceStore } from './team-workspace-store.mjs';
import { buildArenaTeamSkills, arenaMissionNames } from './arena-team-skills.mjs';
import { calculationParallelism } from './calculation-worker-pool.mjs';
import { arenaCandidateScore, arenaSongPreview } from './arena-team-preview.mjs';
import { createArenaCandidatePicker } from './arena-candidate-picker.mjs';
import { createTeamCardView } from './team-card-view.mjs';
import { skillPeek, closeSkillPopover, destroySkillPopover } from './calculator-card-ui.mjs';
import { arenaStageTracks, createArenaSongPicker } from './arena-song-picker.mjs';
import { setupQuickOptions } from './tool-quick-options.mjs';
import { artifact } from '../runtime/content.mjs';
import { currentServerContext } from './game-servers.mjs';
import { resolveArenaStage, arenaStageTime } from './arena-stage-config.mjs';

const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const number = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const mean = (samples, fn) => samples.reduce((sum, sample) => sum + fn(sample), 0) / samples.length;

class ArenaTeamWorkbench extends HTMLElement {
  connectedCallback() {
    this.data = JSON.parse(this.querySelector('[data-arena-data]').textContent);
    this.rules = this.data.formalRules;
    this.store = createPersonalGrowthStore({ rules: this.rules, vipRanks: this.data.vipRanks });
    this.teams = createTeamWorkspaceStore({ rules: this.rules });
    this.songs = []; this.generation = 0;
    this.cards = new Map([...this.data.memberCards, ...this.data.supportCards].map(card => [card.id, card]));
    this.events = new AbortController();
    const listen = (target, type, fn) => target.addEventListener(type, fn, { signal: this.events.signal });
    listen(this.q('form'), 'submit', event => { event.preventDefault(); this.run(); });
    listen(this.q('form'), 'input', () => this.invalidate());
    this.q('form').addEventListener('invalid', event => {
      this.q('settings').open = true;
      const details = event.target.closest('details'); if (details) details.open = true;
    }, { capture: true, signal: this.events.signal });
    const performanceControl = this.querySelector('.arena-performance');
    listen(document, 'click', event => { if (!performanceControl.contains(event.target)) performanceControl.open = false; });
    listen(performanceControl, 'keydown', event => { if (event.key === 'Escape') { performanceControl.open = false; performanceControl.querySelector('summary').focus(); } });
    listen(this.q('cancel'), 'click', () => this.invalidate('已取消，可重新开始。'));
    listen(this.q('edit'), 'click', () => { this.q('settings').open = true; this.q('settings').scrollIntoView({ block: 'start' }); this.q('settings').querySelector('summary').focus(); });
    listen(this.q('method-open'), 'click', () => this.q('method-dialog').showModal());
    listen(this.q('method-close'), 'click', () => this.q('method-dialog').close());
    this.songPicker = createArenaSongPicker({ charts: this.data.charts, onSelect: (track, difficulty) => {
      this.songs.push({ trackId: track.id, difficulty, title: track.title, weight: 1 });
      this.invalidate(); this.renderSongs();
    } });
    this.append(this.songPicker.element);
    const iconRoot = `/content/releases/${bandIcons.releaseId}/public/`;
    for (const option of this.q('form').elements.bandId.options) option.dataset.icon = `${iconRoot}images/filter-bands/band-${option.value}.png`;
    this.stageOptions = setupQuickOptions(this.q('stage'));
    this.stageMode = 'schedule'; this.stageReady = false; this.q('run').disabled = true;
    const params = new URLSearchParams(location.search);
    this.stageSeason = params.get('season'); this.stagePeriod = params.get('regulation') ?? '';
    if (params.has('band')) this.q('form').elements.bandId.value = params.get('band');
    listen(this.q('form').elements.bandId, 'change', () => { this.stageTouched = true; this.stagePeriod = ''; this.syncStage(); });
    listen(this.q('period'), 'click', () => { this.renderPeriods(); this.q('period-dialog').showModal(); this.q('period-list').querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'center' }); });
    listen(this.q('period-close'), 'click', () => this.q('period-dialog').close());
    listen(this.q('period-current'), 'click', () => this.selectPeriod(''));
    for (const button of this.querySelectorAll('[data-stage-source]')) listen(button, 'click', () => {
      this.stageTouched = true; this.stageMode = button.dataset.stageSource; this.invalidate(); this.syncStage();
    });
    this.loadStage(params.has('band'));
    listen(document, 'visibilitychange', () => { if (!document.hidden) this.syncStage(); });
    this.stageTimer = setInterval(() => { if (!document.hidden) this.syncStage(); }, 60000);
    listen(this.querySelector('[data-add-song]'), 'click', () => {
      this.songPicker.open(this.stageTracks, this.songs, this.q('form').elements.bandId.selectedOptions[0].text);
    });
    const refresh = () => { this.invalidate('养成已更新。'); this.refreshProfile(); };
    listen(window, 'personal-growth:changed', refresh);
    listen(window, 'storage', event => { if (event.key === this.store.key) refresh(); });
    this.refreshProfile();
    this.updateSetupSummary();
  }
  disconnectedCallback() { this.generation++; this.worker?.terminate(); this.loading?.abort(); this.events?.abort(); this.stageOptions?.destroy(); this.songPicker?.element.remove(); this.songOptions?.destroy(); clearInterval(this.stageTimer); destroySkillPopover(this); }
  stageRequest() {
    return { ...currentServerContext(), sourceReleaseId: this.rules.sourceReleaseId,
      bandId: this.q('form').elements.bandId.value, seasonId: this.stageSeason, regulationId: this.stagePeriod };
  }
  async loadStage(explicitBand) {
    try {
      this.stageData = await artifact('projection/arena.json', { optional: true });
      if (!this.isConnected) return;
      if (!explicitBand && !this.stageTouched && this.stageData) {
        const just = this.data.bands.find(band => {
          try { return resolveArenaStage(this.stageData, { ...this.stageRequest(), bandId: band.id }).stage.missions.every(m => m === 3); } catch { return false; }
        });
        if (just) this.q('form').elements.bandId.value = String(just.id);
      }
    } catch (error) { this.stageLoadError = error.message; }
    if (this.isConnected) this.syncStage();
  }
  syncStage() {
    const manual = this.stageMode === 'manual';
    this.q('manual').hidden = !manual; this.q('schedule').hidden = manual;
    for (const button of this.querySelectorAll('[data-stage-source]')) button.setAttribute('aria-pressed', String(button.dataset.stageSource === this.stageMode));
    const previous = this.resolvedStage?.stage.regulationId;
    this.resolvedStage = null; this.stageReady = manual;
    if (!manual) {
      const summary = this.q('stage-summary'); summary.replaceChildren();
      try {
        if (this.stageLoadError) throw Error(this.stageLoadError);
        const resolved = resolveArenaStage(this.stageData, this.stageRequest()); this.resolvedStage = resolved;
        const { stage, season, status } = resolved;
        this.stageReady = stage.missions.every(m => m === 3 || m === 0);
        this.q('period-label').textContent = `${this.stagePeriod ? '所选场次' : '当前舞台'} · ${arenaStageTime(stage.validFrom, this.stageData.timeZone)}`;
        const attribute = this.data.attributes.find(a => Number(a.code) === stage.musicType)?.name ?? (stage.musicType === 0 ? '原曲属性' : 'ALL');
        const heading = el('div', '', 'arena-stage-identity'), state = el('span', status === 'current' ? '进行中' : status === 'upcoming' ? '预告试配' : '历史试配', 'arena-stage-state'); state.dataset.state = status;
        heading.append(el('span', season.name), state);
        const conditions = el('div', '', 'arena-stage-conditions'), attributeNode = el('div', '', 'arena-stage-attribute');
        const icon = this.data.filterVisualOptions.attribute.find(a => Number(a.value) === stage.musicType)?.icon;
        if (icon) { const image = el('img'); image.src = icon; image.alt = ''; attributeNode.append(image); }
        else attributeNode.append(el('span', stage.musicType === 99 ? 'ALL' : '♪', 'arena-attribute-symbol'));
        const caption = el('div'); caption.append(el('small', '舞台属性'), el('strong', attribute)); attributeNode.append(caption);
        const missions = el('ol', '', 'arena-stage-missions');
        stage.missions.forEach((m, i) => { const step = el('li'); step.dataset.mission = m; step.append(el('small', `第 ${i + 1} 段`), el('strong', arenaMissionNames[m] ?? '原曲')); missions.append(step); });
        conditions.append(attributeNode, missions);
        const validity = el('p', '', 'arena-stage-validity'); validity.append(el('span', `${arenaStageTime(stage.validFrom, this.stageData.timeZone)} — ${arenaStageTime(stage.validUntil, this.stageData.timeZone)}`), el('small', this.stageData.timeZone === 'Asia/Tokyo' ? 'UTC+9' : this.stageData.timeZone));
        summary.append(heading, conditions, validity);
        if (!this.stageReady) summary.append(el('p', '本期不是三段 JUST，请选择 JUST 场次。', 'arena-stage-note'));
      } catch (error) { summary.append(el('p', error.message)); }
    }
    if (previous && previous !== this.resolvedStage?.stage.regulationId) this.invalidate('舞台条件已更新，请重新推荐。');
    this.q('run').disabled = !this.stageReady || Boolean(this.worker || this.loading);
    this.stageOptions?.sync();
    this.stageTracks = arenaStageTracks(this.data.tracks, this.data.charts, this.q('form').elements.bandId.value);
    const allowed = new Set(this.stageTracks.map(track => track.id)), removed = this.songs.filter(song => !allowed.has(song.trackId));
    if (removed.length) {
      this.songs = this.songs.filter(song => allowed.has(song.trackId));
      this.invalidate(`已移除其他乐队的 ${removed.length} 首歌，请为当前舞台选歌。`);
    }
    this.q('song-scope').textContent = `${this.q('form').elements.bandId.selectedOptions[0].text} · ${this.stageTracks.length} 首可选`;
    if (this.songBand !== this.q('form').elements.bandId.value || removed.length) this.renderSongs();
    this.songBand = this.q('form').elements.bandId.value;
    this.updateSetupSummary();
  }
  selectPeriod(id) {
    this.stageTouched = true; this.stagePeriod = id;
    this.q('period-dialog').close(); this.invalidate(); this.syncStage();
  }
  renderPeriods() {
    const now = Date.now(), zone = this.stageData?.timeZone;
    this.q('period-zone').textContent = zone === 'Asia/Tokyo' ? 'UTC+9' : zone ?? '';
    this.q('period-list').replaceChildren(...(this.resolvedStage?.periods ?? []).map(period => {
      const button = el('button', '', 'arena-period-option'); button.type = 'button';
      const current = Date.parse(period.validFrom) <= now && now < Date.parse(period.validUntil);
      const state = current ? '进行中' : Date.parse(period.validFrom) > now ? '预告' : '历史';
      const date = el('span', '', 'arena-period-date');
      date.append(el('strong', arenaStageTime(period.validFrom, zone)), el('small', state));
      const attribute = this.data.attributes.find(a => Number(a.code) === period.attribute)?.name ?? '原曲';
      const attributeNode = el('span', '', 'arena-period-attribute');
      const icon = this.data.filterVisualOptions.attribute.find(a => Number(a.value) === period.attribute)?.icon;
      if (icon) { const image = el('img'); image.src = icon; image.alt = ''; attributeNode.append(image); }
      attributeNode.append(el('span', attribute));
      const missions = el('span', '', 'arena-period-missions');
      period.missions.forEach(m => { const badge = el('span', arenaMissionNames[m] ?? '原曲', 'arena-mission-badge'); badge.dataset.mission = m; missions.append(badge); });
      button.append(date, attributeNode, missions, el('span', '✓', 'arena-period-check'));
      button.setAttribute('aria-pressed', String(period.id === this.resolvedStage.stage.regulationId));
      button.setAttribute('aria-label', `${arenaStageTime(period.validFrom, zone)} ${state} ${attribute} ${period.missions.map(m => arenaMissionNames[m] ?? '原曲').join(' / ')}`);
      button.dataset.state = current ? 'current' : '';
      button.addEventListener('click', () => this.selectPeriod(period.id)); return button;
    }));
  }
  updateSetupSummary() {
    const form = this.q('form').elements;
    this.q('performance-summary').textContent = `稳定 FC · ±${form.timingSpreadMs.value || '—'}ms${form.samples.value === '1' ? '' : ` · ${form.samples.value}组`}`;
    this.q('dock-summary').textContent = `${form.bandId.selectedOptions[0]?.text ?? '选择乐队'} · ${this.songs.length ? `${this.songs.length} 首歌` : '未选歌曲'} · ${form.participantCount.value} 人`;
    const count = Number(form.participantCount.value), excess = this.songs.length > count;
    this.q('pool-hint').textContent = excess ? `${count} 人场最多 ${count} 首，请移除 ${this.songs.length - count} 首` : `${this.songs.length} / ${count} 首 · 默认等权`;
    this.q('pool-hint').toggleAttribute('data-error', excess);
    this.querySelector('[data-add-song]').disabled = this.songs.length >= count || !this.stageTracks?.length;
    this.q('song-empty').hidden = this.songs.length > 0;
  }
  q(name) { return this.querySelector(`[data-arena-${name}]`); }
  status(text, error = false) { const node = this.q('status'); node.textContent = text; node.toggleAttribute('data-error', error); }
  refreshProfile() {
    try {
      this.profile = this.store.read();
      this.querySelector('[data-profile-status]').textContent = this.profile
        ? `${this.profile.inventory.memberCardIds.length} 成员 / ${this.profile.inventory.supportCardIds.length} 留影`
        : '请从「卡库与队伍」导入养成';
    } catch (error) { this.profile = null; this.querySelector('[data-profile-status]').textContent = error.message; }
  }
  finish() { this.worker?.terminate(); this.worker = null; this.loading = null; this.q('run').disabled = !this.stageReady; this.q('cancel').hidden = true; this.q('progress').hidden = true; }
  invalidate(message = '') {
    this.generation++; this.loading?.abort(); this.finish(); this.report = null;
    this.q('results').replaceChildren(); this.previewChanged = null; this.bestScore = null; this.preview = null; this.status(message);
    this.updateSetupSummary();
  }
  fillDifficulties(select, trackId, selected = 'hard') {
    const charts = this.data.charts.filter(c => c.trackId === trackId && c.analysisDataUrl);
    select.replaceChildren(...['easy', 'normal', 'hard', 'expert'].flatMap(difficulty => {
      const chart = charts.find(c => c.difficulty === difficulty); if (!chart) return [];
      const option = el('option', `${difficulty.toUpperCase()} ${chart.displayLevel}`); option.value = difficulty; return [option];
    }));
    if (charts.some(c => c.difficulty === selected)) select.value = selected;
  }
  renderSongs() {
    this.songOptions?.destroy();
    this.querySelector('[data-song-list]').replaceChildren(...this.songs.map((song, index) => {
      const row = el('li'), weight = el('input'), remove = el('button', '×'), difficulty = el('select');
      const controls = el('div', '', 'arena-song-options'), difficultyLabel = el('div', '', 'arena-song-difficulties'), weightLabel = el('label', '权重');
      weightLabel.className = 'arena-song-weight';
      this.fillDifficulties(difficulty, song.trackId, song.difficulty);
      difficulty.setAttribute('aria-label', `${song.title} 统一难度`);
      difficulty.addEventListener('input', () => { song.difficulty = difficulty.value; });
      weight.type = 'number'; weight.min = '0.01'; weight.max = '10000'; weight.step = 'any'; weight.value = song.weight;
      weight.setAttribute('aria-label', `${song.title} 歌曲权重`);
      weight.addEventListener('input', () => { song.weight = Number(weight.value); });
      remove.type = 'button'; remove.setAttribute('aria-label', `移除 ${song.title}`);
      remove.addEventListener('click', () => { this.songs.splice(index, 1); this.invalidate(); this.renderSongs(); });
      difficultyLabel.append(difficulty); weightLabel.append(weight);
      controls.append(difficultyLabel, weightLabel);
      const track = this.data.tracks.find(track => track.id === song.trackId), jacket = el('img');
      if (track.jacketUrl) jacket.src = track.jacketUrl; jacket.alt = ''; jacket.loading = 'lazy';
      const copy = el('div', '', 'arena-song-copy'); copy.append(el('strong', song.title), controls);
      row.append(jacket, copy, remove); return row;
    }));
    this.songOptions = setupQuickOptions(this.querySelector('[data-song-list]'));
    for (const button of this.querySelectorAll('.arena-song-difficulties button')) {
      const short = { easy: 'EZ', normal: 'NM', hard: 'HD', expert: 'EX' }[button.dataset.difficulty];
      button.querySelector('span').textContent = button.textContent.replace(/EASY|NORMAL|HARD|EXPERT/, short);
    }
  }
  async run() {
    this.invalidate(); const requestId = this.generation, started = performance.now();
    try {
      this.refreshProfile();
      if (!this.profile) throw Error('请先选择账号区服并导入养成');
      if (!this.songs.length) throw Error('点击「＋ 选歌」，选择歌曲和难度。');
      const form = new FormData(this.q('form'));
      if (this.songs.length > Number(form.get('participantCount'))) throw Error(`请将歌曲减少到 ${form.get('participantCount')} 首以内`);
      let stage;
      if (this.stageMode === 'schedule') {
        const resolved = resolveArenaStage(this.stageData, this.stageRequest());
        if (resolved.stage.regulationId !== this.resolvedStage?.stage.regulationId) { this.syncStage(); throw Error('舞台条件已更新，请确认后重新推荐'); }
        stage = { ...resolved.stage, participantCount: Number(form.get('participantCount')) };
      } else {
        if (form.get('musicType') === '') throw Error('请选择舞台属性');
        stage = { bandId: Number(form.get('bandId')), musicType: Number(form.get('musicType')), missions: [3, 3, 3], participantCount: Number(form.get('participantCount')) };
      }
      const performanceScenario = { profile: 'steady', timingSpreadMs: Number(form.get('timingSpreadMs')), missRate: 0, samples: Number(form.get('samples')), seed: 20261105 };
      const profile = structuredClone(this.profile), songs = structuredClone(this.songs);
      this.q('run').disabled = true; this.q('cancel').hidden = false; this.loading = new AbortController();
      this.status('读取完整谱面…');
      for (const song of songs) {
        const info = this.data.charts.find(c => c.trackId === song.trackId && c.difficulty === song.difficulty);
        const response = await fetch(info.analysisDataUrl, { signal: this.loading.signal });
        if (!response.ok) throw Error(`${song.title} 谱面加载失败（${response.status}）`);
        const chart = await response.json();
        // The URL comes from this page's pinned content catalog. Older chart
        // documents omit the release field; bind them at this loading boundary.
        song.chart = { ...chart, sourceReleaseId: chart.sourceReleaseId ?? this.rules.sourceReleaseId };
      }
      if (requestId !== this.generation) return;
      this.worker = new Worker(new URL('./arena-team-worker.mjs', import.meta.url), { type: 'module' });
      this.q('progress').hidden = false;
      this.status('正在生成候选队伍…');
      this.worker.onmessage = ({ data }) => {
        if (data.requestId !== this.generation) return;
        if (data.type === 'progress') {
          const p = data.progress; this.q('progress').value = p.completed / p.total;
          this.status(p.phase === 'generate' ? `生成候选 ${p.completed} / ${p.total} · 已保留 ${p.candidates} 队`
            : `比较队伍 ${p.completed} / ${p.total}${p.workers ? ` · ${p.workers} 路并行` : ''}`);
        } else if (data.type === 'result') {
          if (stage.source === 'schedule' && !this.stagePeriod) {
            try {
              if (resolveArenaStage(this.stageData, this.stageRequest()).stage.regulationId !== stage.regulationId) throw Error('舞台条件已更新');
            } catch { this.invalidate('舞台条件已更新，请重新推荐。'); this.syncStage(); return; }
          }
          this.finish(); this.report = data.result; this.renderResults(); this.q('settings').open = false;
          this.q('results').scrollIntoView({ block: 'start' });
          this.status(`${data.result.candidates.length} 队 · ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
        } else { this.finish(); this.status(data.error, true); }
      };
      this.worker.onerror = event => { if (requestId === this.generation) { this.finish(); this.status(event.message || '计算未完成，请重新尝试。', true); } };
      const sourceLabel = this.stageMode === 'manual' ? '手动试配' : this.resolvedStage.status === 'current' ? '当前舞台' : this.resolvedStage.status === 'past' ? '历史试配' : '预告试配';
      this.q('condition-summary').textContent = `${sourceLabel} · ${this.q('form').elements.bandId.selectedOptions[0].text} · ${this.data.attributes.find(a => Number(a.code) === stage.musicType)?.name ?? '原曲'} · ${songs.length} 首歌`;
      this.worker.postMessage({ requestId, workers: calculationParallelism(), payload: { rules: this.rules, profile, stage, songs, performanceScenario } });
    } catch (error) { if (requestId === this.generation) { this.finish(); this.status(error.message, true); } }
  }
  skillBadges(skill) {
    const badges = el('div', '', 'arena-skill-badges');
    const mission = el('span', arenaMissionNames[skill.mission], 'arena-mission-badge'); mission.dataset.mission = skill.mission;
    badges.append(mission);
    for (const type of skill.types) { const badge = el('span', type, 'arena-effect-badge'); badge.dataset.effect = type; badges.append(badge); }
    badges.append(el('small', `Lv.${skill.level}`));
    return badges;
  }
  lineup(candidate, skills) {
    const lineup = el('div', '', 'arena-lineup');
    lineup.setAttribute('aria-label', '五组配对，上方成员，下方留影');
    for (const [index, slot] of candidate.draft.slots.entries()) {
      const pair = el('section', '', 'arena-pair'); pair.toggleAttribute('data-leader', index === 2);
      pair.setAttribute('aria-label', `配对 ${index + 1}${index === 2 ? ' · 队长' : ''}`);
      const position = el('span', index === 2 ? '★ 队长' : `配对 ${index + 1}`, 'arena-pair-position');
      position.setAttribute('aria-hidden', 'true'); pair.append(position);
      for (const kind of ['member', 'support']) {
        const id = slot[`${kind}CardId`], card = this.cards.get(id), growth = candidate.draft.modifiers.growth[id];
        const root = el('article', '', 'arena-card'); root.dataset.kind = kind;
        root.setAttribute('aria-label', `${kind === 'member' ? '成员' : '留影'} · ${card.displayName}`);
        const view = createTeamCardView(card, { growth, kind, data: this.data, corners: true, source: 'actual' });
        view.querySelector('.tw-card-relation')?.remove();
        view.querySelector('.tw-card-source').textContent = card.displayName.split('｜')[0];
        const peek = skillPeek(this, card, { growth, leader: index === 2, mode: 'gekisou', hover: false });
        peek.textContent = '原文'; peek.setAttribute('aria-label', `查看 ${card.shortLabel} 的技能原文`);
        view.querySelector('.tw-card-source').append(peek);
        root.append(view);
        const rows = skills.byCard.get(id);
        for (const skill of rows) {
          const detail = el('div', '', 'arena-card-skill'); detail.toggleAttribute('data-inactive', !skill.active);
          detail.append(this.skillBadges(skill), el('p', skill.active ? skill.compactSummary : '本局不触发')); root.append(detail);
        }
        if (!rows.length) root.append(el('p', '无激奏技能', 'arena-hint'));
        pair.append(root);
      }
      lineup.append(pair);
    }
    return lineup;
  }
  teamSkills(skills) {
    const root = el('section', '', 'arena-team-skills');
    root.setAttribute('aria-label', '全队激奏汇总');
    const inactive = [...skills.byCard.values()].flat().filter(s => !s.active);
    const header = el('header');
    header.append(el('h3', '激奏汇总'), el('small', `按当前配对${inactive.length ? ` · ${inactive.length} 项本局不触发` : ''}`)); root.append(header);
    const groups = el('div', '', 'arena-skill-groups');
    for (const group of skills.groups) {
      const section = el('section', '', 'arena-skill-group'); section.dataset.effect = group.role;
      const heading = el('h4'); heading.append(el('span', `${arenaMissionNames[group.mission]} · ${group.role}`), el('small', `${group.sources.length} 张`)); section.append(heading);
      const list = el('ul');
      for (const entry of group.entries) {
        const item = el('li', entry.text); item.title = entry.sources.map(id => this.cards.get(id).displayName).join('、'); list.append(item);
      }
      section.append(list); groups.append(section);
    }
    root.append(groups);
    if (!skills.groups.length) root.append(el('p', '当前配对无可触发的激奏技能', 'arena-hint'));
    return root;
  }
  resultCard(candidate, title, primary = false) {
    const root = el('section', '', 'arena-result'), header = el('header', '', 'arena-result-header'); root.toggleAttribute('data-primary', primary);
    const heading = el('div', '', 'arena-result-heading'), songs = this.report.songs;
    heading.append(el('h2', title), el('small', songs.length === 1 ? `${songs[0].title} · ${songs[0].difficulty.toUpperCase()}` : `${songs.length} 首曲池`)); header.append(heading);
    const save = el('button', '保存队伍'); save.type = 'button';
    save.addEventListener('click', () => {
      try {
        this.teams.read();
        const draft = structuredClone(candidate.draft), ids = new Set(draft.slots.flatMap(s => [s.memberCardId, s.supportCardId]));
        draft.modifiers.growth = Object.fromEntries(Object.entries(draft.modifiers.growth).filter(([id]) => ids.has(id)));
        this.teams.saveTeam({ name: `JUST · ${title}`, draft }); save.textContent = '已保存'; save.disabled = true;
      } catch (error) { this.status(error.message, true); }
    });
    const actions = el('div', '', 'arena-result-actions');
    actions.append(save); header.append(actions); root.append(header);
    const preview = this.rankPreview(candidate, primary ? this.bestScore : this.report.candidates[0], primary);
    root.append(preview.root);
    const skills = buildArenaTeamSkills(this.rules, candidate.draft, this.cards, candidate.songs[0].samples[0].sections.map(s => s.missionType));
    const detail = el('section', '', 'arena-song-results'), table = el('table'), head = el('tr');
    ['歌曲 / 难度', '综合力', '第 1 段 JUST', '第 2 段 JUST', '第 3 段 JUST'].forEach(text => head.append(el('th', text))); table.append(head);
    candidate.songs.forEach((song, i) => { const row = el('tr'); [this.report.songs[i].title + ' / ' + this.report.songs[i].difficulty.toUpperCase(), number(song.power), ...[0, 1, 2].map(j => number(mean(song.samples, sample => sample.sections[j].just)))].forEach(text => row.append(el('td', text))); table.append(row); });
    const wrap = el('div', '', 'arena-table-wrap'); wrap.append(table);
    detail.append(wrap, el('p', '曲池按权重汇总，计数显示各次操作均值。', 'arena-hint'));
    const insights = el('section', '', 'arena-insights'), tabs = el('div', '', 'arena-insight-tabs');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '队伍详情');
    const panels = [this.lineup(candidate, skills), preview.detail, detail], buttons = [];
    const select = index => {
      this.resultTab = index;
      panels.forEach((panel, i) => { panel.hidden = i !== index; buttons[i].setAttribute('aria-selected', String(i === index)); buttons[i].tabIndex = i === index ? 0 : -1; });
    };
    ['队伍搭配', '得分比较', '逐曲数据'].forEach((label, index) => {
      const tab = el('button', label); tab.type = 'button'; tab.setAttribute('role', 'tab');
      tab.id = `arena-insight-tab-${index}`; tab.setAttribute('aria-controls', `arena-insight-panel-${index}`);
      const panel = panels[index]; panel.id = `arena-insight-panel-${index}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
      tab.addEventListener('click', () => select(index));
      tab.addEventListener('keydown', event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : event.key === 'ArrowRight' ? (index + 1) % panels.length : event.key === 'ArrowLeft' ? (index + panels.length - 1) % panels.length : null;
        if (next === null) return; event.preventDefault(); select(next); buttons[next].focus();
      });
      buttons.push(tab); tabs.append(tab);
    });
    const toolbar = el('div', '', 'arena-result-toolbar'); toolbar.append(tabs, preview.controls);
    insights.append(toolbar, preview.editor, this.teamSkills(skills), ...panels); select(this.resultTab); root.append(insights); return root;
  }
  renderResults() {
    const report = this.report, root = this.q('results'), main = report.candidates[0]; root.replaceChildren();
    this.bestScore = [...report.candidates].sort((a, b) => b.sameRankScore - a.sameRankScore)[0];
    this.preview = { mode: 'unknown', songIndex: 0, opponents: new Map() };
    this.resultTab = 0;
    const content = el('div'); let selected = main;
    const picker = createArenaCandidatePicker({ report, cards: this.cards, onSelect: candidate => render(candidate) });
    this.previewChanged = valid => picker.update(selected.id, this.preview, valid);
    const render = candidate => {
      closeSkillPopover(this);
      selected = candidate;
      const title = candidate.id === main.id ? '推荐队伍' : candidate.id === this.bestScore.id ? '同名次高分队' : `方案 ${report.candidates.indexOf(candidate) + 1} · ${candidate.name}`;
      content.replaceChildren(this.resultCard(candidate, title, candidate.id === main.id));
    };
    const layout = el('div', '', 'arena-results-layout'); layout.append(picker.element, content);
    root.append(layout); render(main);
    if (report.omitted.length) root.append(el('p', `${report.omitted.length} 队含暂未支持的技能，未参与比较。`, 'arena-hint'));
  }
  rankPreview(candidate, comparison, primary) {
    const root = el('section', '', 'arena-rank-preview'), controls = el('div', '', 'arena-rank-controls');
    controls.append(el('span', '计分情景'));
    const modes = el('div', '', 'arena-segments'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '名次情景');
    const state = this.preview, count = this.report.stage.participantCount;
    const metrics = el('dl', '', 'arena-metrics'), scoreRow = el('div'), scoreLabel = el('dt'), scoreValue = el('dd');
    scoreRow.append(scoreLabel, scoreValue);
    const loss = el('div'); loss.append(el('dt', '选错队最大损失'), el('dd', `${(candidate.worstLoss / 10000).toFixed(1)} 万`));
    loss.title = '对手未知时，本次候选之间的最大得分损失估计。'; metrics.append(scoreRow);
    const ranks = el('div', '', 'arena-ranks'), delta = el('p', '', 'arena-score-difference');
    const detail = el('section', '', 'arena-score-details'), comparisonMetrics = el('dl', '', 'arena-metrics');
    comparisonMetrics.append(loss); detail.append(comparisonMetrics, delta);
    const editor = el('details', '', 'arena-opponent-editor'), inputs = el('div', '', 'arena-opponents');
    editor.append(el('summary', '调整对手计数'), el('p', '初始计数取两队之间；同计数按我方胜出。', 'arena-hint'), inputs);
    const update = () => {
      const manual = state.mode === 'opponents', unknown = state.mode === 'unknown', index = state.songIndex;
      for (const button of modes.children) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
      editor.hidden = !manual;
      const opponents = state.opponents.get(index), values = { rank: manual ? undefined : state.mode === 'first' ? 1 : count, opponents };
      if (manual && opponents.flat().some(o => !Number.isSafeInteger(o.just) || o.just < 0 || o.just > 0x7fffffff)) {
        scoreValue.textContent = '—'; ranks.replaceChildren(); delta.textContent = '对手计数应为非负整数。'; this.previewChanged(false); return;
      }
      const current = arenaSongPreview(candidate.songs[index], values), other = arenaSongPreview(comparison.songs[index], values);
      const score = arenaCandidateScore(candidate, state);
      const otherScore = arenaCandidateScore(comparison, state);
      scoreLabel.textContent = unknown ? `${this.report.songs.length > 1 ? '曲池加权' : '整场'}得分范围` : manual ? '本曲试算分' : this.report.songs.length > 1 ? '曲池参考分' : '参考整场分';
      scoreValue.textContent = unknown ? `${(candidate.sameRankScore / 10000).toFixed(1)}–${(candidate.firstRankScore / 10000).toFixed(1)}` : (score / 10000).toFixed(1);
      scoreValue.append(el('span', '万')); scoreValue.dataset.range = String(unknown);
      scoreValue.title = unknown ? `三段末位 ${number(candidate.sameRankScore)} → 三段第一 ${number(candidate.firstRankScore)}` : number(score);
      ranks.replaceChildren();
      const rankText = s => s.minRank === s.maxRank ? `第 ${s.minRank} 名` : `第 ${s.minRank}–${s.maxRank} 名`;
      for (const [j, section] of current.sections.entries()) {
        const tile = el('div', '', 'arena-rank'); tile.dataset.first = String(!unknown && section.maxRank === 1);
        tile.dataset.varied = String(section.minRank !== section.maxRank);
        tile.setAttribute('aria-label', `第 ${j + 1} 段 JUST：${number(section.just)} 计数${unknown ? '' : `，${rankText(section)}`}`);
        tile.append(el('span', `${j + 1} 段`), el('strong', unknown ? number(section.just) : rankText(section)), el('small', unknown ? 'JUST' : `${number(section.just)} 计数`));
        if (manual && candidate.id !== comparison.id) tile.append(el('small', `对照 ${rankText(other.sections[j])}`, 'arena-other-rank'));
        ranks.append(tile);
      }
      const name = primary ? '同名次高分队' : '推荐队伍';
      delta.textContent = unknown ? '得分范围对应三段末位至三段第一；推荐顺序同时考虑计数带来的名次收益。' : candidate.id === comparison.id ? '这支队伍同时拥有最高同名次得分。'
        : `比${name}${score >= otherScore ? '多' : '少'} ${(Math.abs(score - otherScore) / 10000).toFixed(1)} 万分`;
      delta.dataset.ahead = String(!unknown && score >= otherScore);
      this.previewChanged(true);
    };
    for (const [mode, label] of [['unknown', '对手未知'], ['opponents', '对手试算'], ['first', '均第 1 名'], ['same', `均第 ${count} 名`]]) {
      const button = el('button', label); button.type = 'button'; button.dataset.mode = mode;
      button.addEventListener('click', () => { state.mode = mode; if (mode === 'opponents') editor.open = true; update(); }); modes.append(button);
    }
    controls.append(modes);
    const resetInputs = () => {
      const index = state.songIndex; inputs.replaceChildren();
      if (!state.opponents.has(index)) state.opponents.set(index, [0, 1, 2].map(j => {
        const midpoint = Math.round((mean(this.report.candidates[0].songs[index].samples, s => s.sections[j].just) + mean(this.bestScore.songs[index].samples, s => s.sections[j].just)) / 2);
        return Array.from({ length: count - 1 }, (_, n) => ({ just: Math.max(0, midpoint + n), noteScore: 0, perfectCount: 0 }));
      }));
      for (let j = 0; j < 3; j++) {
        const field = el('fieldset'); field.append(el('legend', `第 ${j + 1} 段 JUST`));
        state.opponents.get(index)[j].forEach((opponent, n) => {
          const row = el('label', `对手 ${n + 1}`), input = el('input'); input.type = 'number'; input.min = '0'; input.step = '1'; input.value = opponent.just;
          input.setAttribute('aria-label', `第 ${j + 1} 段对手 ${n + 1} JUST 计数`);
          input.addEventListener('input', () => { opponent.just = Number(input.value); update(); }); row.append(input); field.append(row);
        });
        inputs.append(field);
      }
      update();
    };
    if (this.report.songs.length > 1) {
      const select = el('select'); select.setAttribute('aria-label', '查看谱面计数');
      this.report.songs.forEach((song, i) => { const option = el('option', `${song.title} · ${song.difficulty.toUpperCase()}`); option.value = i; select.append(option); });
      select.value = state.songIndex;
      select.addEventListener('change', () => { state.songIndex = Number(select.value); resetInputs(); }); controls.append(select);
    }
    root.append(metrics, ranks); editor.open = state.mode === 'opponents'; resetInputs(); return { root, controls, editor, detail };
  }
}
if (!customElements.get('arena-team-workbench')) customElements.define('arena-team-workbench', ArenaTeamWorkbench);
