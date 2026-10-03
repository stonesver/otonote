import {planningUiText,translatePlanningSubtree} from './team-planning-translations.mjs';
import {skillActivation} from './skill-activation-view.mjs';
import {createPersonalGrowthStore} from './personal-growth-store.mjs';
import {scopedStorageKey, currentServerContext, assertAccountServer} from './game-servers.mjs';
import {teamLineup,scoreComposition,scoreRanking,replacementSummary} from './score-visuals.mjs';
import { preparePresetDraft, comparePresetReplacement, refreshPlanningPreset } from './preset-portfolio.mjs';
import { stableSnapshotHash } from './scoring-engine.mjs';
import { createInventoryManager } from './inventory-manager.mjs';

const el = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
const format = n => n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const signed = n => `${n > 0 ? '+' : ''}${format(n)}`;
const missionName = n => ['', 'COMBO', 'LUCK', 'JUST'][n] ?? '?';
function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const entity=(tag,text)=>{const node=el(tag,text);node.dataset.uiEntity='true';return node;};
function table(headers, rows, entityColumns = []) {
  const wrap = el('div'), root = el('table'), head = el('thead'), tr = el('tr'), body = el('tbody');
  wrap.className = 'preset-table-wrap'; headers.forEach(h => tr.append(el('th', h))); head.append(tr); root.append(head, body);
  for (const values of rows) { const row = el('tr'); values.forEach((v,i) => row.append(entityColumns.includes(i)?entity('td', String(v)):el('td', String(v)))); body.append(row); }
  wrap.append(root); return wrap;
}
export function setupPresetPortfolio(workbench) {
  const q = selector => workbench.querySelector(selector);
  const ui = text => planningUiText(text,workbench.data.locale);
  const translate = node => translatePlanningSubtree(node,workbench.data.locale);
  if (!q('[data-preset-run]')) return null;
  const rules = workbench.data.formalRules, key = scopedStorageKey('presets',rules.sourceReleaseId);
  const storageStatus = q('[data-preset-storage-status]'), status = q('[data-preset-status]'), results = q('[data-preset-results]');
  let candidates = [], worker, request = 0, report, abort, storageBlocked = false;
  const busyButtons = ['save', 'generate', 'run', 'compare', 'import'];
  function finish() { worker?.terminate(); worker = null; busyButtons.forEach(s => q(`[data-preset-${s}]`).disabled = false); q('[data-preset-cancel]').disabled = true; }
  function invalidate() {
    request++; abort?.abort(); finish(); report = null; results.replaceChildren(); q('[data-preset-report]').disabled = true;
    syncSongSelection();
    status.textContent = ui('输入已更新，可重新比较这首歌。');
  }
  function persist(next) {
    assertAccountServer(currentServerContext().serverId);
    if (storageBlocked) throw new Error('原候选备份无法读取，未覆盖。请先导出当前候选，检查浏览器存储。');
    if (next.length > 100) throw new Error('最多保存 100 支候选，请先删除重复候选');
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, ...currentServerContext(), sourceReleaseId: rules.sourceReleaseId, candidates: next }));
    candidates = next; invalidate(); renderCandidates();
    storageStatus.textContent = ui(`已在本浏览器保存 ${candidates.length} 支候选。`);
  }
  function validateFile(value) {
    assertAccountServer(value?.serverId);
    if (value?.schemaVersion !== 1 || value.sourceReleaseId !== rules.sourceReleaseId || !Array.isArray(value.candidates) || value.candidates.length > 100) throw new Error('候选文件格式或版本不一致');
    const ids = new Set();
    return value.candidates.map(c => {
      if (typeof c.id !== 'string' || !c.id || ids.has(c.id) || typeof c.name !== 'string' || c.name.length > 80 || c.sourceReleaseId !== rules.sourceReleaseId) throw new Error('候选名称、ID 或版本无效');
      ids.add(c.id); preparePresetDraft(rules, c.draft, { maximizeTrainable: false }); return c;
    });
  }
  function add(draft, name) {
    preparePresetDraft(rules, draft, { maximizeTrainable: false });
    const id = `saved-${stableSnapshotHash({ slots: draft.slots, modifiers: draft.modifiers })}`;
    const candidate = { id, name: (name || `预设 ${candidates.length + 1}`).slice(0, 80), sourceReleaseId: rules.sourceReleaseId, draft: structuredClone(draft) };
    const next = candidates.filter(c => c.id !== id); next.push(candidate); persist(next);
  }
  function renderCandidates() {
    const root = q('[data-preset-list]'), select = q('[data-preset-baseline]'), previous = select.value;
    root.replaceChildren(); select.replaceChildren();
    for (const candidate of candidates) {
      const row = el('li'), load = el('button', '载入编辑'), remove = el('button', '删除'); load.type = remove.type = 'button';
      const option = entity('option', candidate.name); option.value = candidate.id; select.append(option);
      load.addEventListener('click', () => {
        try {
          const { selectedSongId, selectedDifficulty } = workbench.draft;
          const inventory=createPersonalGrowthStore({rules,vipRanks:workbench.data.vipRanks}).read()?.inventory;
          const refreshed=refreshPlanningPreset(rules,candidate.draft,inventory);
          workbench.draft = { ...refreshed.draft, selectedSongId, selectedDifficulty };
          workbench.planningScenarios?.restore(workbench.draft.modifiers); workbench.commit();
          q('[data-preset-baseline]').value = candidate.id;
          workbench.dispatchEvent(new CustomEvent('calculator-edit-team'));
        } catch(error) {storageStatus.textContent=ui(`队伍未载入：${error.message}`);}
      });
      remove.addEventListener('click', () => { try { persist(candidates.filter(c => c.id !== candidate.id)); } catch (e) { storageStatus.textContent = ui(e.message); } });
      let label = '已保存队伍';
      try {
        const inventory = createPersonalGrowthStore({rules,vipRanks:workbench.data.vipRanks}).read()?.inventory;
        const {planning} = refreshPlanningPreset(rules,candidate.draft,inventory);
        if (planning) label = planning.trainedCardCount ? `培养计划 · ${planning.trainedCardCount} 张卡`
          : planning.missingActual ? '参考队伍 · 实际养成未齐全' : '当前养成';
        if (candidate.draft.modifiers?.planningScenario?.scope === 'trial') label = `试用卡 · ${label}`;
      } catch { label = '条件需检查，载入后查看'; }
      row.append(entity('strong', candidate.name),el('span',label), load, remove); root.append(row);
    }
    translate(root);
    if (candidates.some(c => c.id === previous)) select.value = previous;
    if (!candidates.length) root.append(el('li', '还没有保存队伍。展开下方「添加队伍」，或先用「帮我配一队」获取推荐。'));
  }
  try { const saved = localStorage.getItem(key); if (saved) candidates = validateFile(JSON.parse(saved)); }
  catch (error) { storageBlocked = true; storageStatus.textContent = ui(`候选未载入：${error.message}。原备份保留，未覆盖。`); }
  renderCandidates();
  q('[data-preset-edit]').addEventListener('click',()=>workbench.dispatchEvent(new CustomEvent('calculator-edit-team')));
  q('[data-preset-inventory]').addEventListener('click',()=>workbench.dispatchEvent(new CustomEvent('calculator-open-inventory')));
  q('[data-preset-save]').addEventListener('click', () => { try { add(workbench.draft, q('[data-preset-name]').value.trim()); } catch (e) { storageStatus.textContent = ui(e.message); } });
  workbench.addEventListener('save-preset-candidate', event => {
    try { add(event.detail.draft, event.detail.name); event.detail.onSaved?.(); } catch (e) { storageStatus.textContent = ui(e.message); event.detail.onError?.(e.message); }
  });
  q('[data-preset-export]').addEventListener('click', () => download('otonote-presets.json', { schemaVersion: 1, ...currentServerContext(), sourceReleaseId: rules.sourceReleaseId, candidates }));
  q('[data-preset-import]').addEventListener('change', async event => {
    invalidate(); const token = request, file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error('候选文件过大（最多 5 MB）');
      const imported = validateFile(JSON.parse(await file.text())); if (token !== request) return;
      const merged = new Map(candidates.map(c => [c.id, c])); imported.forEach(c => merged.set(c.id, c)); persist([...merged.values()]);
    } catch (e) { if (token === request) storageStatus.textContent = ui(e.message); }
    finally { event.target.value = ''; }
  });
  function syncSongSelection() {
    q('[data-preset-song]').value = workbench.draft.selectedSongId ?? '';
    q('[data-preset-difficulty]').value = workbench.draft.selectedDifficulty ?? '';
    const track = workbench.data.tracks.find(t => t.id === workbench.draft.selectedSongId);
    q('[data-preset-selection]').textContent = track && workbench.draft.selectedDifficulty
      ? `本次比较：${track.title} · ${workbench.draft.selectedDifficulty.toUpperCase()}。与页面上方选歌保持同步。`
      : '请先选择歌曲和难度，再生成或比较队伍。';
  }
  for (const track of workbench.data.tracks) {
    const option = entity('option', track.title); option.value = track.id; q('[data-preset-song]').append(option);
    const poolOption=entity('option',track.title);poolOption.value=track.id;q('[data-preset-pool]')?.append(poolOption);
  }
  for (const [selector, field] of [['song', 'selectedSongId'], ['difficulty', 'selectedDifficulty']]) {
    q(`[data-preset-${selector}]`).addEventListener('change', event => {
      workbench.draft[field] = event.target.value || null; workbench.commit();
    });
  }
  syncSongSelection();
  function songList() {
    const { selectedSongId, selectedDifficulty: difficulty } = workbench.draft;
    const track = workbench.data.tracks.find(t => t.id === selectedSongId);
    if (!track) throw new Error('请先选择要比较的歌曲');
    if (!['easy', 'normal', 'hard', 'expert'].includes(difficulty)) throw new Error('请先选择演奏难度');
    if(q('[data-preset-use-pool]')?.checked){
      const ids=[...q('[data-preset-pool]').selectedOptions].map(option=>option.value);
      if(!ids.length||ids.length>12)throw Error('请选择 1–12 首曲池歌曲');
      return ids.map(id=>{const row=workbench.data.tracks.find(t=>t.id===id);return {trackId:id,title:row.title,difficulty,weight:1};});
    }
    return [{ trackId: track.id, title: track.title, difficulty, weight: 1 }];
  }
  function renderReport(result, comparison) {
    results.replaceChildren(); results.append(el('h3','比较结果'));
    const performanceName = {steady:'参考发挥',practice:'较多失误',ideal:'理想发挥',explicit:'演出记录'}[result.performanceScenario?.profile]??'理想输入';
    results.append(el('p', `共同条件：${performanceName}${result.mode==='gekisou'?` · 各段假设名次 ${result.scenario.ranks.join(' / ')}`:''}。各队均使用同一组原始操作。`)); const name = id => result.matrix.candidates.find(c => c.id === id)?.name ?? id;
    if (comparison) {
      results.append(el('p', `当前队伍替换「${name(comparison.beforeId)}」：${result.matrix.songs.length>1?'曲池平均分':'本曲总分'}变化 ${signed(comparison.expectedDelta)} 分。`));
      for (const row of comparison.rows) {results.append(el('h4',row.title),replacementSummary(row));}

    } else {
      const p = result.portfolio;
      results.append(el('p', `${result.matrix.songs.length>1?'曲池预设':'本曲推荐'}：${p.selectedIds.map(name).join('、')}`));
      const headline=el('div');headline.className='recommendation-score';headline.append(el('strong',Math.round(p.expectedScore).toLocaleString()),el('span','预计平均分 · 当前条件'));results.append(headline);
      const winnerIndex=result.matrix.candidates.findIndex(c=>c.id===p.selectedIds[0]);
      const winner=result.matrix.candidates[winnerIndex];
      if (result.matrix.songs.length > 1) results.append(el('h4', `首曲对比：${result.matrix.songs[0].title} · ${winner.name}`));
      results.append(teamLineup(workbench,winner.draft));
      if(result.mode==='gekisou')results.append(scoreComposition(result.matrix.scores[0][winnerIndex].sections,result.matrix.scores[0][winnerIndex].expectedScore));
      results.append(scoreRanking(result.matrix.candidates.map((c,i)=>({name:c.name,score:result.matrix.scores[0][i].expectedScore}))));
      results.append(el('p', '这些结果只比较当前保存的队伍。分差接近时，可以按自己的习惯选择。'));
      if(result.matrix.songs.length>1)results.append(table(['歌曲','建议使用','条件平均分'],p.rows.map(row=>[row.title,name(row.candidateId),format(row.expectedScore)]),[0,1]));
      for(const candidate of result.matrix.candidates)if(candidate.planning?.trainedCardCount)results.append(el('p',`${candidate.name}：还需要培养 ${candidate.planning.trainedCardCount} 张卡，结果按目标养成计算。`));
    }
    const sectionDetails = el('details'); sectionDetails.append(el('summary', '查看本曲各队的三段分值与任务数'));
    for (const [s, song] of result.matrix.songs.entries()) {
      const detail = el('details'); detail.append(entity('summary', song.title));
      detail.append(table(['预设', '整曲分数', '第一段', '第二段', '第三段'], result.matrix.candidates.map((c, i) => {
        const score = result.matrix.scores[s][i];
        return [c.name, format(score.expectedScore), ...[0, 1, 2].map(j => {
          const sec = score.sections[j]; if (!sec) return '—';
          const count = sec.missionType === 1 ? sec.combo : sec.missionType === 2 ? sec.luckPoints : sec.just;
          return `${missionName(sec.missionType)}：${format(sec.totalScore)} 分 (${format(sec.share * 100)}%)；任务 ${format(count)}${sec.missionType === 3 ? `，实际 JUST ${format(sec.rawJust)}` : ''}`;
        })];
      }))); sectionDetails.append(detail);
    }
    if (result.mode === 'gekisou') results.append(sectionDetails);
    for(const song of result.matrix.songs)for(const candidate of result.matrix.candidates){
      const entry=el('details');entry.append(el('summary',`${candidate.name} · ${song.title} · 技能详情`));
      let rendered=false;entry.addEventListener('toggle',()=>{if(!entry.open||rendered)return;rendered=true;entry.append(skillActivation(workbench,{...candidate.draft,modifiers:{...candidate.draft.modifiers,performanceScenario:result.performanceScenario},selectedSongId:song.trackId,selectedDifficulty:song.difficulty},{mode:result.mode,scenario:result.scenario}));});results.append(entry);
    }
    const details = el('details'); details.append(el('summary', '比较条件与适用范围'));
    result.warnings.forEach(w => details.append(el('p', w)));
    result.omitted.forEach(c => details.append(el('p', `${c.id}：${c.reason}`))); results.append(details);
    report = { ...result, ...(comparison ? { comparison } : {}) }; q('[data-preset-report]').disabled = false;
    translate(results);results.scrollIntoView({block:'start',behavior:'auto'});
  }
  async function run(type) {
    invalidate(); const token = request; abort = new AbortController();
    busyButtons.forEach(s => q(`[data-preset-${s}]`).disabled = true); q('[data-preset-cancel]').disabled = false;
    try {
      const songs = songList(), mode = q('[data-preset-mode]').value, maxWindowCards = Number(q('[data-preset-window]').value);
      let payload, baselineId;
      if (type === 'generate') {
        const profile = createPersonalGrowthStore({rules,vipRanks:workbench.data.vipRanks}).read();
        const inventory = profile ? createInventoryManager(rules).validate(profile.inventory) : undefined;
        const settings = workbench.planningScenarios?.read() ?? {planningScenario:workbench.draft.modifiers.planningScenario??{scope:inventory?'owned':'reference'}};
        payload = { rules, draft: structuredClone(workbench.draft), inventory, songs, mode, maxWindowCards, ...settings };
      } else {
        let inputs = structuredClone(candidates);
        if (type === 'compare') {
          baselineId = q('[data-preset-baseline]').value;
          inputs = inputs.filter(c => c.id === baselineId);
          if (!inputs.length) throw new Error('请先保存一支基准预设');
          inputs.push({ id: 'current-replacement', name: '当前队伍', draft: structuredClone(workbench.draft), sourceReleaseId: rules.sourceReleaseId });
        }
        if (!inputs.length) throw new Error('请先保存或生成候选预设');
        for (const [i, song] of songs.entries()) {
          status.textContent = ui(`加载谱面 ${i + 1}/${songs.length}…`);
          const summary = workbench.data.charts.find(c => c.trackId === song.trackId && c.difficulty === song.difficulty);
          if (!summary?.analysisDataUrl) throw new Error(`${song.title} 缺少当前难度谱面`);
          const response = await fetch(summary.analysisDataUrl, { signal: abort.signal });
          if (!response.ok) throw new Error(`${song.title} 谱面加载失败`);
          song.chart = { ...await response.json(), sourceReleaseId: rules.sourceReleaseId }; if (token !== request) return;
        }
        const inventory=createPersonalGrowthStore({rules,vipRanks:workbench.data.vipRanks}).read()?.inventory;
        payload = { rules, candidates: inputs, songs, mode, inventory, maxWindowCards, maximizeTrainable: q('[data-preset-maximize]').checked,
          performanceScenario:{profile:q('[data-preset-performance]')?.value??'steady',timingBiasMs:Number(q('[data-preset-offset]').value)},
          limit: songs.length>1?Number(q('[data-preset-limit]').value):1, scenario: { timingOffsetMs: Number(q('[data-preset-offset]').value),
            ranks: Array(3).fill(Number(q('[data-preset-rank]').value)), batches: Number(q('[data-preset-batches]').value), seed: 20260929, frameRate: 60 } };
      }
      if (token !== request) return;
      worker = new Worker(new URL('./preset-portfolio-worker.mjs', import.meta.url), { type: 'module' });
      worker.onerror = () => { if (token !== request) return; finish(); status.textContent = ui('后台计算失败，请重试。'); };
      worker.onmessage = ({ data }) => {
        if (token !== request || data.requestId !== token) return;
        if (data.type === 'progress') { status.textContent = ui(`${type === 'generate' ? '生成候选' : '比较歌曲与预设'} ${data.progress.completed}/${data.progress.total}…`); return; }
        finish();
        try {
          if (data.type === 'error') throw new Error(data.error);
          if (type === 'generate') {
            const merged = new Map(candidates.map(c => [c.id, c])); data.result.candidates.forEach(c => merged.set(c.id, c)); persist([...merged.values()]);
            status.textContent = ui(`生成 ${data.result.candidates.length} 支候选。${data.result.warning} ${data.result.skipped.join('；')}`);
          } else {
            const comparison = type === 'compare' ? comparePresetReplacement(data.result.matrix, [baselineId], baselineId, 'current-replacement') : null;
            renderReport(data.result, comparison); status.textContent = ui('计算完成。结果仅针对当前歌曲、难度与比较条件。');
          }
        } catch (e) { status.textContent = ui(e.message); }
      };
      worker.postMessage({ type: type === 'generate' ? 'generate' : 'evaluate', requestId: token, payload });
    } catch (e) { if (token === request) { finish(); status.textContent = ui(e.message); } }
  }
  for (const action of ['generate', 'run', 'compare']) q(`[data-preset-${action}]`).addEventListener('click', () => run(action === 'run' ? 'evaluate' : action));
  q('[data-preset-cancel]').addEventListener('click', () => { invalidate(); status.textContent = ui('已停止计算，候选预设仍保留。'); });
  q('[data-preset-report]').addEventListener('click', () => { if (report) download('otonote-preset-report.json', report); });
  for (const field of ['mode', 'window', 'maximize', 'offset', 'rank', 'batches', 'baseline','performance','use-pool','pool','limit']) {
    const control = q(`[data-preset-${field}]`);
    if(!control)continue;
    control.addEventListener(control.tagName === 'INPUT' && control.type !== 'checkbox' ? 'input' : 'change', () => {
      invalidate(); q('[data-preset-scenario]').hidden = q('[data-preset-mode]').value !== 'gekisou';
      q('[data-preset-window-label]').hidden = q('[data-preset-mode]').value !== 'gekisou';
    });
  }
  workbench.addEventListener('preset-inventory-changed', () => { invalidate(); renderCandidates(); });
  return { invalidate, disconnect: () => { request++; abort?.abort(); finish(); } };
}
