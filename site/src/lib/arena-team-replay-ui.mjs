import { renderSkillActivation } from './skill-activation-view.mjs';

const el = (tag, text = '', className = '') => {
  const node = document.createElement(tag);
  if (text !== '') node.textContent = text;
  if (className) node.className = className;
  return node;
};

const fmt = value => Number.isFinite(value) ? Math.round(value).toLocaleString('zh-CN') : '—';
const signedFmt = value => {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toLocaleString('zh-CN')}`;
};

export function createArenaTeamReplay({ input, candidate, cards, data, preview, state, cache, available }) {
  const root = el('section', '', 'arena-replay-panel');
  root.setAttribute('aria-label', '单卡贡献与激奏回放');

  if (!input?.songs?.length) {
    root.append(el('p', '请先运行配队计算，再查看单卡贡献与模拟回放。', 'arena-hint'));
    return { element: root, activate() {}, destroy() {} };
  }

  const participants = input.stage.participantCount;
  const luck = input.stage.missions.every(m => m === 2) || candidate.songs[0]?.samples[0]?.sections[0]?.missionType === 2;
  const maxSample = luck ? 9999 : (input.performanceScenario?.samples ?? 1) * 120 - 1;

  state.songIndex = Math.min(state.songIndex ?? preview?.songIndex ?? 0, input.songs.length - 1);
  state.ranks = Array.isArray(state.ranks) && state.ranks.length === 3
    ? state.ranks.map(r => Math.min(Math.max(1, Number(r) || 1), participants))
    : preview?.mode === 'same' ? [participants, participants, participants] : [1, 1, 1];
  state.sampleIndex = Math.max(0, Math.min(maxSample, Number(state.sampleIndex) || 0));
  state.scenarioSource = state.scenarioSource ?? (preview?.mode === 'opponents' ? 'opponents' : 'ranks');

  const controls = el('div', '', 'arena-replay-controls');

  const songLabel = el('label', '回放歌曲');
  const songSelect = el('select', '', 'ui-select');
  input.songs.forEach((song, index) => {
    const opt = el('option', `${song.title} · ${song.difficulty.toUpperCase()}`);
    opt.value = String(index);
    songSelect.append(opt);
  });
  songSelect.value = String(state.songIndex);
  songLabel.append(songSelect);

  const assumptionWrap = el('div', '', 'arena-replay-assumption');
  const sourceLabel = el('label', '名次来源');
  const sourceSelect = el('select', '', 'ui-select');
  const optRanks = el('option', '指定三段名次');
  optRanks.value = 'ranks';
  const optOpp = el('option', '使用当前对手试算');
  optOpp.value = 'opponents';
  sourceSelect.append(optRanks, optOpp);
  sourceLabel.append(sourceSelect);

  const ranksWrap = el('div', '', 'arena-replay-ranks');
  const rankSelects = [0, 1, 2].map(sectionIdx => {
    const lbl = el('label', `第 ${sectionIdx + 1} 段`);
    const sel = el('select', '', 'ui-select');
    for (let r = 1; r <= participants; r++) {
      const opt = el('option', `第 ${r} 名`);
      opt.value = String(r);
      sel.append(opt);
    }
    sel.value = String(state.ranks[sectionIdx]);
    lbl.append(sel);
    ranksWrap.append(lbl);
    return sel;
  });

  const sampleLabel = el('label', '样本编号');
  const sampleRow = el('div', '', 'arena-replay-sample-row');
  const samplePrev = el('button', '‹', 'ui-btn-outline');
  samplePrev.type = 'button';
  samplePrev.setAttribute('aria-label', '上一个样本');
  const sampleInput = el('input', '', 'ui-input');
  sampleInput.type = 'number';
  sampleInput.min = '0';
  sampleInput.max = String(maxSample);
  sampleInput.step = '1';
  sampleInput.value = String(state.sampleIndex);
  sampleInput.setAttribute('aria-label', '回放样本编号');
  const sampleNext = el('button', '›', 'ui-btn-outline');
  sampleNext.type = 'button';
  sampleNext.setAttribute('aria-label', '下一个样本');
  sampleRow.append(samplePrev, sampleInput, sampleNext);
  sampleLabel.append(sampleRow);

  const runBtn = el('button', '计算回放与贡献', 'ui-btn-primary arena-replay-run');
  runBtn.type = 'button';

  assumptionWrap.append(sourceLabel, ranksWrap);
  controls.append(songLabel, assumptionWrap, sampleLabel, runBtn);

  const assumptionNote = el('p', '', 'arena-hint arena-replay-assumption-note');
  const statusEl = el('p', '', 'arena-status');
  statusEl.setAttribute('role', 'status');
  const output = el('div', '', 'arena-replay-output');

  root.append(controls, assumptionNote, statusEl, output);

  let worker = null;
  let requestSeq = 0;
  let activated = false;

  const hasValidOpponents = () => {
    const opp = preview?.opponents?.get?.(state.songIndex);
    if (!opp || opp.length !== 3 || opp.some(rows => rows.length !== participants - 1)) return false;
    const key = luck ? 'luckPoints' : 'just';
    return !opp.flat().some(o => !Number.isSafeInteger(o[key]) || o[key] < 0 || o[key] > 0x7fffffff);
  };

  const syncControls = () => {
    const oppAvailable = hasValidOpponents();
    optOpp.disabled = !oppAvailable;
    if (!oppAvailable && state.scenarioSource === 'opponents') state.scenarioSource = 'ranks';
    sourceSelect.value = state.scenarioSource;
    ranksWrap.hidden = state.scenarioSource === 'opponents';
    samplePrev.disabled = state.sampleIndex <= 0;
    sampleNext.disabled = state.sampleIndex >= maxSample;
    assumptionNote.textContent = state.scenarioSource === 'opponents'
      ? `回放名次依据：当前「对手试算」填写的 ${participants - 1} 名对手数据。`
      : `回放名次假设：三段第 ${state.ranks.join(' / ')} 名${preview?.mode === 'unknown' ? '（当前为对手未知模式，可自由切换三段假设名次）' : ''}。`;
  };

  const cacheKey = () => {
    const opp = state.scenarioSource === 'opponents' ? preview.opponents.get(state.songIndex) : null;
    return JSON.stringify([candidate.id, state.songIndex, state.sampleIndex, state.scenarioSource, opp ? opp : state.ranks]);
  };

  const stopWorker = () => {
    worker?.terminate();
    worker = null;
  };

  const renderReplayResult = (result) => {
    output.replaceChildren();
    const { replay, contributions, sample } = result;

    // 1. Summary KPI bar
    const summary = el('dl', '', 'arena-replay-kpis');
    const items = [
      ['回放总分', fmt(replay.score)],
      ['音符得分', fmt(replay.noteScore)],
      ['名次奖励', `+${fmt(replay.rankingBonus)}`],
      ['队伍综合力', fmt(replay.power)],
      ['样本信息', `#${sample.sampleIndex} · 操作组 ${sample.playerIndex + 1} · 顺序 ${sample.order.map(n => n + 1).join('-')}`],
    ];
    for (const [label, value] of items) {
      const box = el('div');
      box.append(el('dt', label), el('dd', value));
      summary.append(box);
    }
    output.append(summary);

    // 2. Per-card contributions table
    const contribSection = el('section', '', 'arena-contributions');
    const contribHeader = el('div', '', 'arena-contributions-head');
    contribHeader.append(
      el('h3', '单卡技能贡献（关闭该卡技能后的分差）'),
      el('small', `${luck ? 'LUCK' : 'JUST'} 模拟 · 样本 #${sample.sampleIndex}`)
    );
    contribSection.append(contribHeader);

    const tableWrap = el('div', '', 'arena-table-wrap');
    const table = el('table', '', 'arena-contribution-table');
    const thead = el('thead');
    const htr = el('tr');
    for (const col of ['位置', '类型', '卡片', '音符分差', '名次奖励分差', '总分差']) {
      htr.append(el('th', col));
    }
    thead.append(htr);
    table.append(thead);

    const tbody = el('tbody');
    const maxAbsTotal = Math.max(1, ...contributions.map(c => Math.abs(c.scoreDelta)));
    for (const row of contributions) {
      const card = cards.get(row.cardId);
      const tr = el('tr');
      tr.dataset.kind = row.kind;
      if (row.slotIndex === 2 && row.kind === 'member') tr.dataset.leader = 'true';

      const slotTd = el('td', row.slotIndex === 2 ? '★ 队长' : `位置 ${row.slotIndex + 1}`, 'arena-contrib-slot');
      const kindTd = el('td');
      kindTd.append(el('span', row.kind === 'member' ? '成员' : '留影', `arena-contrib-kind arena-contrib-kind--${row.kind}`));

      const cardTd = el('td', '', 'arena-contrib-card');
      const cardWrap = el('div', '', 'arena-contrib-card-inner');
      if (card?.imageUrl) {
        const img = el('img');
        img.src = card.imageUrl;
        img.alt = '';
        img.loading = 'lazy';
        cardWrap.append(img);
      }
      cardWrap.append(el('span', card?.displayName ?? row.cardId));
      cardTd.append(cardWrap);

      const deltaCell = (value, emphasize = false) => {
        const td = el('td', '', emphasize ? 'arena-contrib-delta arena-contrib-delta--total' : 'arena-contrib-delta');
        const rounded = Math.round(value);
        td.dataset.sign = rounded > 0 ? 'pos' : rounded < 0 ? 'neg' : 'zero';
        td.append(el('span', signedFmt(value)));
        if (emphasize && rounded !== 0) {
          const bar = el('span', '', 'arena-contrib-bar');
          const fill = el('i');
          fill.style.width = `${Math.max(4, Math.min(100, (Math.abs(rounded) / maxAbsTotal) * 100))}%`;
          bar.append(fill);
          td.append(bar);
        }
        return td;
      };

      tr.append(slotTd, kindTd, cardTd, deltaCell(row.noteScoreDelta), deltaCell(row.rankingBonusDelta), deltaCell(row.scoreDelta, true));
      tbody.append(tr);
    }
    table.append(tbody);
    tableWrap.append(table);
    contribSection.append(
      tableWrap,
      el('p', '分差为原队与关闭该卡普通及激奏技能的同条件差值（共用队伍综合力、原始操作、技能顺序与初始随机种子）；分差只描述当前样本，可为负，因技能相互作用，各卡分差无法直接相加还原整队总分。', 'arena-hint')
    );
    output.append(contribSection);

    // 3. Full JUST/LUCK playback via shared renderSkillActivation
    const playbackSection = el('section', '', 'arena-replay-playback');
    const playbackHost = el('div', '', 'arena-replay-host');
    playbackSection.append(playbackHost);
    output.append(playbackSection);
    renderSkillActivation(playbackHost, replay, {
      memberCards: data.memberCards,
      supportCards: data.supportCards,
      chart: input.songs[state.songIndex].chart,
    });
  };

  const compute = () => {
    syncControls();
    const key = cacheKey();
    if (cache.has(key)) {
      statusEl.textContent = '';
      statusEl.removeAttribute('data-error');
      renderReplayResult(cache.get(key));
      return;
    }
    if (!available) {
      statusEl.textContent = '配队计算完成后可查看单卡贡献与激奏回放。';
      return;
    }
    stopWorker();
    const reqId = ++requestSeq;
    runBtn.disabled = true;
    statusEl.removeAttribute('data-error');
    statusEl.textContent = '正在计算单卡贡献与激奏回放…';
    output.replaceChildren(el('p', '正在按当前条件模拟 11 次回放（整队 + 10 张单卡对照）…', 'arena-hint'));

    const song = input.songs[state.songIndex];
    const payload = {
      rules: input.rules,
      stage: input.stage,
      song,
      songIndex: state.songIndex,
      performanceScenario: input.performanceScenario,
      draft: candidate.draft,
      sampleIndex: state.sampleIndex,
      ...(state.scenarioSource === 'opponents'
        ? { opponents: preview.opponents.get(state.songIndex) }
        : { ranks: [...state.ranks] }),
    };

    try {
      worker = new Worker(new URL('./arena-team-replay-worker.mjs', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: msg }) => {
        if (msg.requestId !== reqId) return;
        stopWorker();
        runBtn.disabled = false;
        if (msg.type === 'result') {
          cache.set(key, msg.result);
          statusEl.textContent = '';
          renderReplayResult(msg.result);
        } else {
          statusEl.setAttribute('data-error', '');
          statusEl.textContent = msg.error || '回放计算失败，请重试。';
          output.replaceChildren();
        }
      };
      worker.onerror = event => {
        if (reqId !== requestSeq) return;
        stopWorker();
        runBtn.disabled = false;
        statusEl.setAttribute('data-error', '');
        statusEl.textContent = event.message || '回放计算线程异常，请重试。';
        output.replaceChildren();
      };
      worker.postMessage({ requestId: reqId, payload });
    } catch (error) {
      stopWorker();
      runBtn.disabled = false;
      statusEl.setAttribute('data-error', '');
      statusEl.textContent = error.message;
      output.replaceChildren();
    }
  };

  songSelect.addEventListener('change', () => {
    state.songIndex = Number(songSelect.value);
    syncControls();
    if (activated) compute();
  });
  sourceSelect.addEventListener('change', () => {
    state.scenarioSource = sourceSelect.value;
    syncControls();
    if (activated) compute();
  });
  rankSelects.forEach((sel, idx) => {
    sel.addEventListener('change', () => {
      state.ranks[idx] = Number(sel.value);
      syncControls();
      if (activated) compute();
    });
  });
  const setSample = next => {
    const clamped = Math.max(0, Math.min(maxSample, Number(next) || 0));
    state.sampleIndex = clamped;
    sampleInput.value = String(clamped);
    syncControls();
    if (activated) compute();
  };
  sampleInput.addEventListener('change', () => setSample(sampleInput.value));
  samplePrev.addEventListener('click', () => setSample(state.sampleIndex - 1));
  sampleNext.addEventListener('click', () => setSample(state.sampleIndex + 1));
  runBtn.addEventListener('click', () => { activated = true; compute(); });

  syncControls();
  if (cache.has(cacheKey())) {
    activated = true;
    renderReplayResult(cache.get(cacheKey()));
  }

  return {
    element: root,
    activate() {
      activated = true;
      compute();
    },
    destroy() {
      stopWorker();
      output.querySelector('.arena-replay-host')?.stopReplay?.();
    },
  };
}
