import { createPersonalGrowthStore } from './personal-growth-store.mjs';
import { createTeamWorkspaceStore } from './team-workspace-store.mjs';
import { openTeamWorkspace } from './shared-team-context.mjs';
import { buildArenaTeamSkills, arenaMissionNames } from './arena-team-skills.mjs';
import { calculationParallelism } from './calculation-worker-pool.mjs';
import { rankGekisouSection } from './scoring-rules/gekisou-ranking.mjs';

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
    listen(this.q('form'), 'input', event => { if (!event.target.matches('[data-profile-file]')) this.invalidate(); });
    listen(this.q('cancel'), 'click', () => this.invalidate('已取消，可重新开始。'));
    listen(this.querySelector('[data-open-growth]'), 'click', () => openTeamWorkspace('inventory'));
    const songSelect = this.querySelector('[data-song-select]'), difficultySelect = this.querySelector('[data-difficulty-select]');
    const updateDifficulties = () => this.fillDifficulties(difficultySelect, songSelect.value, difficultySelect.value);
    listen(songSelect, 'change', updateDifficulties); updateDifficulties();
    listen(this.querySelector('[data-add-song]'), 'click', () => {
      try {
        const trackId = this.querySelector('[data-song-select]').value, difficulty = this.querySelector('[data-difficulty-select]').value;
        if (!this.data.charts.some(c => c.trackId === trackId && c.difficulty === difficulty && c.analysisDataUrl)) throw Error('该难度缺少可计算谱面');
        if (this.songs.some(s => s.trackId === trackId)) throw Error('这首歌已加入，请在曲池内修改难度或权重');
        if (this.songs.length >= 12) throw Error('最多比较 12 首歌曲');
        this.songs.push({ trackId, difficulty, title: this.data.tracks.find(t => t.id === trackId).title, weight: 1 });
        this.invalidate(); this.renderSongs();
      } catch (error) { this.status(error.message, true); }
    });
    listen(this.querySelector('[data-profile-file]'), 'change', async event => {
      const file = event.target.files[0]; if (!file) return;
      this.invalidate();
      try {
        if (file.size > 2_000_000) throw Error('养成文件最多 2 MB');
        this.store.save(this.store.fromImport(JSON.parse(await file.text())));
        this.refreshProfile();
      } catch (error) { this.status(error.message, true); }
      event.target.value = '';
    });
    const refresh = () => { this.invalidate('养成已更新。'); this.refreshProfile(); };
    listen(window, 'personal-growth:changed', refresh);
    listen(window, 'storage', event => { if (event.key === this.store.key) refresh(); });
    this.refreshProfile();
  }
  disconnectedCallback() { this.generation++; this.worker?.terminate(); this.loading?.abort(); this.events?.abort(); }
  q(name) { return this.querySelector(`[data-arena-${name}]`); }
  status(text, error = false) { const node = this.q('status'); node.textContent = text; node.toggleAttribute('data-error', error); }
  refreshProfile() {
    try {
      this.profile = this.store.read();
      this.querySelector('[data-profile-status]').textContent = this.profile
        ? `${this.profile.inventory.memberCardIds.length} 张成员 · ${this.profile.inventory.supportCardIds.length} 张留影 · 实际养成`
        : '请导入养成文件，或在卡库中录入实际等级。';
    } catch (error) { this.profile = null; this.querySelector('[data-profile-status]').textContent = error.message; }
  }
  finish() { this.worker?.terminate(); this.worker = null; this.q('run').disabled = false; this.q('cancel').hidden = true; this.q('progress').hidden = true; }
  invalidate(message = '') {
    this.generation++; this.loading?.abort(); this.finish(); this.report = null;
    this.q('results').replaceChildren(); this.status(message);
  }
  fillDifficulties(select, trackId, selected = 'hard') {
    const charts = this.data.charts.filter(c => c.trackId === trackId && c.analysisDataUrl);
    select.replaceChildren(...['hard', 'expert', 'normal', 'easy'].flatMap(difficulty => {
      const chart = charts.find(c => c.difficulty === difficulty); if (!chart) return [];
      const option = el('option', `${difficulty.toUpperCase()} ${chart.displayLevel}`); option.value = difficulty; return [option];
    }));
    if (charts.some(c => c.difficulty === selected)) select.value = selected;
  }
  renderSongs() {
    this.querySelector('[data-song-list]').replaceChildren(...this.songs.map((song, index) => {
      const row = el('li'), weight = el('input'), remove = el('button', '×'), difficulty = el('select');
      const difficultyLabel = el('label', '统一难度'), weightLabel = el('label', '歌曲权重');
      this.fillDifficulties(difficulty, song.trackId, song.difficulty);
      difficulty.setAttribute('aria-label', `${song.title} 统一难度`);
      difficulty.addEventListener('input', () => { song.difficulty = difficulty.value; });
      weight.type = 'number'; weight.min = '0.01'; weight.max = '10000'; weight.step = 'any'; weight.value = song.weight;
      weight.setAttribute('aria-label', `${song.title} 歌曲权重`);
      weight.addEventListener('input', () => { song.weight = Number(weight.value); });
      remove.type = 'button'; remove.setAttribute('aria-label', `移除 ${song.title}`);
      remove.addEventListener('click', () => { this.songs.splice(index, 1); this.invalidate(); this.renderSongs(); });
      difficultyLabel.append(difficulty); weightLabel.append(weight);
      row.append(el('strong', song.title), remove, difficultyLabel, weightLabel); return row;
    }));
  }
  async run() {
    this.invalidate(); const requestId = this.generation, started = performance.now();
    try {
      this.refreshProfile();
      if (!this.profile) throw Error('请先选择账号区服并导入养成');
      if (!this.songs.length) throw Error('选择歌曲后，点击「＋ 加入」。');
      const form = new FormData(this.q('form'));
      if (form.get('musicType') === '') throw Error('请对照游戏选择舞台属性');
      const stage = { bandId: Number(form.get('bandId')), musicType: Number(form.get('musicType')), missions: [3, 3, 3], participantCount: Number(form.get('participantCount')) };
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
          this.finish(); this.report = data.result; this.renderResults(); this.q('settings').open = false;
          this.status(`已比较 ${data.result.candidates.length} 支队伍 · ${songs.length} 首歌 · 用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
        } else { this.finish(); this.status(data.error, true); }
      };
      this.worker.onerror = event => { if (requestId === this.generation) { this.finish(); this.status(event.message || '计算未完成，请重新尝试。', true); } };
      this.q('condition-summary').textContent = `${this.q('form').elements.bandId.selectedOptions[0].text} · ${this.q('form').elements.musicType.selectedOptions[0].text} · ${songs.length} 首歌`;
      this.worker.postMessage({ requestId, workers: calculationParallelism(), payload: { rules: this.rules, profile, stage, songs, performanceScenario } });
    } catch (error) { if (requestId === this.generation) { this.finish(); this.status(error.message, true); } }
  }
  skillBadges(skill) {
    const badges = el('div', '', 'arena-skill-badges');
    const mission = el('span', arenaMissionNames[skill.mission], 'arena-mission-badge'); mission.dataset.mission = skill.mission;
    badges.append(mission);
    for (const type of skill.types) { const badge = el('span', type, 'arena-effect-badge'); badge.dataset.effect = type; badges.append(badge); }
    badges.append(el('small', `Lv.${skill.level}`));
    if (!skill.active) badges.append(el('small', '本局不触发', 'arena-inactive-label'));
    return badges;
  }
  lineup(candidate, skills) {
    const lineup = el('div', '', 'arena-lineup');
    for (const [index, slot] of candidate.draft.slots.entries()) {
      const pair = el('section', '', 'arena-pair'); pair.toggleAttribute('data-leader', index === 2);
      const heading = el('div', '', 'arena-pair-heading');
      heading.append(el('span', index === 2 ? '队长配对' : `配对 ${index + 1}`), el('span', '成员 ＋ 留影'));
      pair.append(heading);
      for (const kind of ['member', 'support']) {
        const id = slot[`${kind}CardId`], card = this.cards.get(id), growth = candidate.draft.modifiers.growth[id];
        const root = el('article', '', 'arena-card'), head = el('div', '', 'arena-card-head');
        if (card.imageUrl) { const image = el('img'); image.src = card.imageUrl; image.alt = ''; image.loading = 'lazy'; head.append(image); }
        const copy = el('div', '', 'arena-card-name');
        copy.append(el('small', kind === 'member' ? '成员' : '留影'), el('h3', card.shortLabel), el('p', card.displayName.split('｜')[0]),
          el('small', `Lv.${growth.level} · ${kind === 'member' ? '觉醒' : '突破'} ${growth.rank}`));
        head.append(copy); root.append(head);
        const rows = skills.byCard.get(id);
        for (const skill of rows) {
          const detail = el('div', '', 'arena-card-skill'); detail.toggleAttribute('data-inactive', !skill.active);
          detail.append(this.skillBadges(skill), el('p', skill.summary)); root.append(detail);
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
    const header = el('header'); header.append(el('h3', '全队激奏技能'), el('small', '按当前配对与技能等级汇总')); root.append(header);
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
    const inactive = [...skills.byCard.values()].flat().filter(s => !s.active);
    if (inactive.length) root.append(el('p', `另有 ${[...new Set(inactive.map(s => arenaMissionNames[s.mission]))].join('／')} 技能 ${inactive.length} 项，本局三段 JUST 不触发。`, 'arena-hint'));
    return root;
  }
  resultCard(candidate, title, primary = false) {
    const root = el('section', '', 'arena-result'), header = el('header', '', 'arena-result-header'); root.toggleAttribute('data-primary', primary);
    const heading = el('div'); heading.append(el('span', primary ? '推荐' : '对照', 'arena-result-kicker'), el('h2', title)); header.append(heading);
    const save = el('button', '保存队伍'); save.type = 'button';
    save.addEventListener('click', () => {
      try {
        this.teams.read();
        const draft = structuredClone(candidate.draft), ids = new Set(draft.slots.flatMap(s => [s.memberCardId, s.supportCardId]));
        draft.modifiers.growth = Object.fromEntries(Object.entries(draft.modifiers.growth).filter(([id]) => ids.has(id)));
        this.teams.saveTeam({ name: `JUST · ${title}`, draft }); save.textContent = '已保存'; save.disabled = true;
      } catch (error) { this.status(error.message, true); }
    });
    header.append(save); root.append(header);
    const metrics = el('dl', '', 'arena-metrics');
    for (const [label, value] of [['同名次参考分', candidate.sameRankScore], ['选错队的最大损失', candidate.worstLoss]]) {
      const row = el('div'), score = el('dd', `${(value / 10000).toFixed(1)}`); score.append(el('span', '万')); score.title = number(value);
      row.append(el('dt', label), score); metrics.append(row);
    }
    root.append(metrics);
    const skills = buildArenaTeamSkills(this.rules, candidate.draft, this.cards, this.report.stage.missions);
    root.append(this.teamSkills(skills), this.lineup(candidate, skills));
    const detail = el('details', '', 'arena-song-results'), table = el('table'), head = el('tr');
    detail.append(el('summary', '逐曲计数与得分'));
    ['歌曲 / 难度', '综合力', '第 1 段 JUST', '第 2 段 JUST', '第 3 段 JUST'].forEach(text => head.append(el('th', text))); table.append(head);
    candidate.songs.forEach((song, i) => { const row = el('tr'); [this.report.songs[i].title + ' / ' + this.report.songs[i].difficulty.toUpperCase(), number(song.power), ...[0, 1, 2].map(j => number(mean(song.samples, sample => sample.sections[j].just)))].forEach(text => row.append(el('td', text))); table.append(row); });
    const wrap = el('div', '', 'arena-table-wrap'); wrap.append(table);
    detail.append(wrap, el('p', `同名次统一按第 ${this.report.stage.participantCount} 名；三段第一时参考分 ${number(candidate.firstRankScore)}。曲池按权重汇总，计数显示各次操作均值。`, 'arena-hint'));
    root.append(detail); return root;
  }
  renderResults() {
    const report = this.report, root = this.q('results'), main = report.candidates[0]; root.replaceChildren();
    const pool = el('div', '', 'arena-pool-summary');
    report.songs.forEach(s => pool.append(el('span', `${s.title} · ${s.difficulty.toUpperCase()}${s.weight !== 1 ? ` · 权重 ${s.weight}` : ''}`)));
    root.append(pool, this.resultCard(main, '推荐队伍', true));
    const bestScore = [...report.candidates].sort((a, b) => b.sameRankScore - a.sameRankScore)[0];
    const comparison = el('details', '', 'arena-comparison'), summary = el('summary');
    summary.append(el('span', '比较其他队伍'), el('small', bestScore.id === main.id ? '推荐队伍同时拥有最高同名次得分' : `同名次得分最高的队伍多 ${(Math.max(0, bestScore.sameRankScore - main.sameRankScore) / 10000).toFixed(1)} 万分`));
    comparison.append(summary); root.append(comparison);
    const head = el('div', '', 'arena-results-head'), label = el('label', '对比队伍'), select = el('select');
    select.setAttribute('aria-label', '对比候选');
    report.candidates.forEach((c, i) => { const option = el('option', `${i + 1}. ${c.id === bestScore.id ? '同名次得分最高' : c.name} · ${number(c.sameRankScore)} 分`); option.value = c.id; select.append(option); });
    select.value = bestScore.id; label.append(select); head.append(label); comparison.append(head);
    const alternative = el('div'), sensitivity = el('div'); comparison.append(alternative, sensitivity);
    const render = () => {
      const candidate = report.candidates.find(c => c.id === select.value);
      alternative.replaceChildren(this.resultCard(candidate, candidate.id === bestScore.id ? '同名次得分最高' : '对比队伍'));
      sensitivity.replaceChildren(this.sensitivity(main, candidate));
    };
    select.addEventListener('change', render); render();
    const version = el('details', '', 'arena-method'); version.append(el('summary', '数据与搜索记录'),
      el('p', `${report.candidates.length} 支候选 · 每组操作 ${report.orderCount} 种技能顺序`), el('p', report.sourceReleaseId, 'arena-hint'));
    if (report.omitted.length) version.append(el('p', `${report.omitted.length} 队技能暂未支持：${report.omitted.map(c => c.reason).join('；')}`));
    root.append(version);
  }
  sensitivity(a, b) {
    const root = el('section', '', 'arena-sensitivity'), select = el('select'), label = el('label', '比较谱面 ');
    root.append(el('h2', '对手多少 JUST 时，换队更划算？'));
    this.report.songs.forEach((song, i) => { const option = el('option', `${song.title} · ${song.difficulty.toUpperCase()}`); option.value = i; select.append(option); });
    label.append(select); root.append(label, el('p', '填入对手每段的 JUST 计数，查看两队分差。同计数时，此处按我方胜出计算。', 'arena-hint'));
    const inputs = el('div', '', 'arena-opponents'), output = el('div', '', 'arena-simulation'); root.append(inputs, output);
    const update = () => {
      const index = Number(select.value), opponents = [0, 1, 2].map(j => [...inputs.querySelectorAll(`[data-section="${j}"]`)].map(input => ({ just: Number(input.value), noteScore: 0, perfectCount: 0 })));
      if (opponents.flat().some(o => !Number.isSafeInteger(o.just) || o.just < 0 || o.just > 0x7fffffff)) { output.textContent = '对手计数应为非负整数。'; return; }
      const score = candidate => mean(candidate.songs[index].samples, sample => sample.noteScore + sample.sections.reduce((sum, section, j) => sum + section.bonuses[rankGekisouSection(section, opponents[j], section.missionType) - 1], 0));
      const va = score(a), vb = score(b); output.replaceChildren();
      for (const [name, value] of [['推荐队伍', va], ['对比队伍', vb]]) { const bar = el('div', '', 'arena-score-bar'), fill = el('i'); fill.style.width = `${100 * value / Math.max(va, vb, 1)}%`; bar.append(fill); output.append(el('p', `${name}：${number(value)}`), bar); }
      output.append(el('p', `此情景下，对比队伍${vb >= va ? '多拿' : '少拿'} ${number(Math.abs(vb - va))} 分。`));
      const baselineA = mean(a.songs[index].samples, sample => sample.noteScore + sample.sections.reduce((sum, section) => sum + section.bonuses.at(-1), 0));
      const baselineB = mean(b.songs[index].samples, sample => sample.noteScore + sample.sections.reduce((sum, section) => sum + section.bonuses.at(-1), 0));
      output.append(el('p', `双方都为第 ${this.report.stage.participantCount} 名时，对比队伍${baselineB >= baselineA ? '多拿' : '少拿'} ${number(Math.abs(baselineB - baselineA))} 分；当前名次差异额外改变 ${number(vb - va - (baselineB - baselineA))} 分。`, 'arena-hint'));
    };
    const reset = () => {
      const index = Number(select.value); inputs.replaceChildren();
      for (let j = 0; j < 3; j++) {
        const field = el('fieldset'); field.append(el('legend', `第 ${j + 1} 段 JUST`));
        const midpoint = Math.round((mean(a.songs[index].samples, x => x.sections[j].just) + mean(b.songs[index].samples, x => x.sections[j].just)) / 2);
        for (let n = 0; n < this.report.stage.participantCount - 1; n++) {
          const row = el('label', `对手 ${n + 1}`), input = el('input'); input.type = 'number'; input.min = '0'; input.step = '1'; input.value = Math.max(0, midpoint + n); input.dataset.section = j;
          input.setAttribute('aria-label', `第 ${j + 1} 段对手 ${n + 1} JUST 计数`); input.addEventListener('input', update); row.append(input); field.append(row);
        }
        inputs.append(field);
      }
      update();
    };
    select.addEventListener('change', reset); reset(); return root;
  }
}
if (!customElements.get('arena-team-workbench')) customElements.define('arena-team-workbench', ArenaTeamWorkbench);
