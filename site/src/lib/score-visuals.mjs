import {createWorkbenchTeamView} from './workbench-team-view.mjs';
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const number = n => Number.isFinite(n) ? Math.round(n).toLocaleString() : '—';
const mission = n => ['', 'COMBO', 'LUCK', 'JUST'][n] ?? '任务';

export function teamLineup(workbench, draft) {
  return createWorkbenchTeamView(workbench,draft);
}

export function scoreComposition(sections, expectedScore) {
  const root = el('section', null, 'score-composition');
  root.append(el('h4', '分数从哪里来'));
  if (!sections?.length || !(expectedScore > 0)) return root;
  const sum = sections.reduce((n, s) => n + s.totalScore, 0);
  const parts = [{ label: '非激奏段', value: Math.max(0, expectedScore - sum), color: '#9da5b5' },
    ...sections.map((s, i) => ({ label: `第 ${s.index ?? i + 1} 段 · ${mission(s.missionType)}`, value: s.totalScore,
      color: ['#9b587e', '#4c8588', '#b88835'][i % 3] }))];
  const track = el('div', null, 'score-segments'); track.setAttribute('aria-hidden', 'true');
  const legend = el('div', null, 'score-legend');
  for (const part of parts) {
    const share = part.value / expectedScore * 100;
    const segment = el('span'); segment.style.flexGrow = String(part.value); segment.style.background = part.color; track.append(segment);
    const item = el('div'); item.style.setProperty('--segment-color', part.color);
    item.append(el('span', part.label), el('strong', `${share.toFixed(1)}%`), el('small', `${number(part.value)} 分`)); legend.append(item);
  }
  root.append(track, legend);
  root.append(el('p', '激奏段包含该段音符分与名次奖励。', 'score-footnote'));
  return root;
}

export function scoreRanking(entries) {
  const root = el('ol', null, 'score-ranking');
  const sorted = [...entries].sort((a, b) => b.score - a.score), best = sorted[0]?.score ?? 0;
  for (const [index, entry] of sorted.entries()) {
    const row = el('li'), head = el('div', null, 'score-rank-heading');
    head.append(el('span', String(index + 1).padStart(2, '0')), el('strong', entry.name), el('b', number(entry.score)));
    const track = el('div', null, 'score-rank-track'), fill = el('span');
    fill.style.width = `${best > 0 ? Math.max(0, entry.score / best * 100) : 0}%`; track.append(fill);
    row.append(head, track, el('small', index ? `比第一名少 ${number(best - entry.score)} 分` : '当前候选中最高')); root.append(row);
  }
  return root;
}

export function replacementSummary(comparison) {
  const root = el('section', null, 'score-replacement'), delta = comparison.delta;
  const header = el('div', null, 'score-gain'); header.dataset.direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';
  header.append(el('span', delta > 0 ? '换卡后提高' : delta < 0 ? '换卡后降低' : '换卡前后持平'),
    el('strong', `${delta > 0 ? '+' : ''}${number(delta)}`), el('small', comparison.percent == null ? '分' : `分 · ${comparison.percent > 0 ? '+' : ''}${comparison.percent.toFixed(2)}%`));
  const scores = el('div', null, 'score-before-after');
  for (const [label, value] of [['原队', comparison.before], ['换卡后', comparison.after]]) {
    const item = el('div'); item.append(el('span', label), el('strong', number(value))); scores.append(item);
  }
  root.append(header, scores);
  if (comparison.sectionDeltas?.length) {
    const parts = el('div', null, 'score-deltas');
    for (const s of comparison.sectionDeltas) {
      const item = el('div'); item.append(el('span', `第 ${s.index} 段 · ${mission(s.missionType)}`),
        el('strong', `${s.scoreDelta > 0 ? '+' : ''}${number(s.scoreDelta)}`, s.scoreDelta < 0 ? 'is-negative' : 'is-positive')); parts.append(item);
    }
    root.append(parts);
  }
  return root;
}
