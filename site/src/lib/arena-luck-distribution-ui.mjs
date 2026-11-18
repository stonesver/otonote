import { arenaLuckScoreDistribution } from './arena-team-preview.mjs';

const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const points = value => `${(value / 10000).toFixed(1)} 万`;

/** One on-demand worker for the selected formation/song. The owning search
 * clears the bounded cache whenever stage, growth or performance changes. */
export function createArenaLuckDistribution({ input, candidate, state, cache, available }) {
  const root = el('details', '', 'arena-luck-distribution'); root.open = state.open;
  const summary = el('summary', '单局分数波动'); summary.append(el('small', '按单曲与名次查看')); root.append(summary);
  root.addEventListener('toggle', () => { state.open = root.open; });
  const controls = el('div', '', 'arena-distribution-controls'), songLabel = el('label', '歌曲'), songSelect = el('select');
  songSelect.setAttribute('aria-label', '单局分布歌曲');
  input.songs.forEach((song, i) => songSelect.append(new Option(`${song.title} · ${song.difficulty.toUpperCase()}`, i)));
  songSelect.value = state.songIndex; songLabel.append(songSelect); controls.append(songLabel);
  const ranks = el('div', '', 'arena-distribution-ranks');
  state.ranks.forEach((rank, i) => {
    const label = el('label', `第 ${i + 1} 段名次`), select = el('select');
    for (let r = 1; r <= input.stage.participantCount; r++) select.append(new Option(`第 ${r} 名`, r));
    select.value = rank;
    select.addEventListener('change', () => { state.ranks[i] = Number(select.value); render(); });
    label.append(select); ranks.append(label);
  });
  controls.append(ranks);
  const actions = el('div', '', 'arena-distribution-actions'), start = el('button', '计算单局分布'), cancel = el('button', '取消分布计算');
  start.type = cancel.type = 'button'; actions.append(start, cancel);
  const status = el('p', '', 'arena-hint'); status.setAttribute('role', 'status');
  const progress = el('progress'); progress.max = 1; progress.setAttribute('aria-label', '单局分布计算进度');
  const results = el('dl', '', 'arena-distribution-metrics');
  root.append(controls, el('p', '三段按所选名次计算奖励，不模拟取得这些名次的概率。', 'arena-hint'), actions, progress, status, results,
    el('p', '按当前养成与参考发挥独立抽样 LUCK 与普通技能顺序，均分可能与推荐阶段略有差异。P10–P90 为本次中间约 80% 的结果，单局仍可超出；样本极值不代表保底或理论上限。', 'arena-hint'));
  let worker = null;
  const key = () => `${candidate.id}:${state.songIndex}`;
  const stop = () => { worker?.terminate(); worker = null; };
  const render = () => {
    const result = cache.get(key());
    start.disabled = !available || Boolean(worker) || Boolean(result);
    start.textContent = result ? '已计算' : '计算单局分布';
    cancel.hidden = progress.hidden = !worker;
    status.textContent = !available ? '推荐完成或停止后，可计算单局分布。' : worker ? '正在回放当前歌曲…'
      : result ? `${result.samples.length} 次独立抽样 · 三段按 ${state.ranks.join(' / ')} 名结算`
      : '点击计算当前队伍在本曲的分数波动；不会改变综合推荐顺序。';
    results.replaceChildren();
    if (result) {
      const stats = arenaLuckScoreDistribution(result.samples, state.ranks);
      for (const [label, value, title] of [
        ['平均分（本次抽样）', points(stats.mean), Math.round(stats.mean).toLocaleString('zh-CN')],
        ['常见单局范围 · P10–P90', `${points(stats.p10)}–${points(stats.p90)}`, `${stats.p10.toLocaleString('zh-CN')}–${stats.p90.toLocaleString('zh-CN')}`],
        ['本次样本最低／最高', `${points(stats.minimum)} / ${points(stats.maximum)}`, `${stats.minimum.toLocaleString('zh-CN')} / ${stats.maximum.toLocaleString('zh-CN')}`]
      ]) {
        const metric = el('div'), valueNode = el('dd', value); valueNode.title = title;
        metric.append(el('dt', label), valueNode); results.append(metric);
      }
    }
  };
  songSelect.addEventListener('change', () => { stop(); state.songIndex = Number(songSelect.value); render(); });
  cancel.addEventListener('click', () => { stop(); render(); status.textContent = '已取消单局分布计算。'; });
  start.addEventListener('click', () => {
    const current = new Worker(new URL('./arena-luck-distribution-worker.mjs', import.meta.url), { type: 'module' });
    worker = current; progress.value = 0; render();
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      if (data.type === 'progress') {
        progress.value = data.progress.completed / data.progress.total;
        status.textContent = `正在回放 ${data.progress.completed} / ${data.progress.total} 次…`; return;
      }
      if (data.type === 'result') {
        cache.set(key(), data.result);
        if (cache.size > 8) cache.delete(cache.keys().next().value);
      }
      stop(); render();
      if (data.type === 'error') status.textContent = `单局分布未完成：${data.error}`;
    };
    current.onerror = event => { if (worker !== current) return; stop(); render(); status.textContent = `单局分布未完成：${event.message}`; };
    current.postMessage({ rules: input.rules, stage: input.stage, performanceScenario: input.performanceScenario,
      song: input.songs[state.songIndex], songIndex: state.songIndex, candidate: { id: candidate.id, draft: candidate.draft } });
  });
  render();
  return { element: root, destroy: stop };
}
