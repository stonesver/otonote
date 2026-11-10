import { arenaCandidateChanges, arenaCandidateOrder } from './arena-team-preview.mjs';

const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const points = value => value == null ? '—' : `${(value / 10000).toFixed(1)} 万`;

/** A compact shortlist opens the full, sortable candidate gallery. */
export function createArenaCandidatePicker({ report, cards, onSelect }) {
  const luck = report.method === 'expected_rank_envelope';
  const main = report.candidates[0], element = el('section', '', 'arena-candidate-picker');
  element.setAttribute('aria-label', '候选队伍切换');
  const header = el('header');
  const browse = el('button', `全部 ${report.candidates.length} 队 ›`, 'arena-candidate-browse'); browse.type = 'button'; browse.setAttribute('aria-haspopup', 'dialog');
  header.append(el('h2', '候选队伍'), browse);
  const comparisonNote = el('p', '与当前队伍比较 · 换卡高亮', 'arena-candidate-comparison');
  const featured = el('div', '', 'arena-candidate-featured');
  const dialog = el('dialog', '', 'arena-candidate-dialog'); dialog.setAttribute('aria-label', '候选队伍排行');
  const dialogHeader = el('header'), close = el('button', '×', 'arena-candidate-close'); close.type = 'button'; close.setAttribute('aria-label', '关闭候选排行');
  dialogHeader.append(el('h2', '候选排行'), close);
  const toolbar = el('div', '', 'arena-candidate-toolbar'), sortGroup = el('div', '', 'arena-segments');
  sortGroup.setAttribute('role', 'group'); sortGroup.setAttribute('aria-label', '候选排序');
  const basis = el('p', '', 'arena-candidate-basis'), list = el('ol', '', 'arena-candidate-list');
  list.setAttribute('aria-label', '候选队伍');
  const pager = el('nav', '', 'arena-candidate-pager'), previous = el('button', '← 上一页'), next = el('button', '下一页 →'), pageLabel = el('span');
  pager.setAttribute('aria-label', '候选分页'); previous.type = next.type = 'button'; pager.append(previous, pageLabel, next);
  toolbar.append(sortGroup); dialog.append(dialogHeader, toolbar, basis, list, pager);
  element.append(header, comparisonNote, featured, dialog);
  let rows = [], selectedId = main.id, comparedId = main.id, preview, valid = true, sort = 'recommendation', page = 0, scoreContext = '';
  const pageSize = 6;
  const name = row => row.candidate.id === main.id ? '推荐队伍' : `方案 ${row.index + 1}`;
  const delta = row => row.score == null ? '请修正对手计数' : row.candidate.id === main.id ? '推荐基准'
    : `比推荐 ${row.score >= baseline() ? '+' : '−'}${points(Math.abs(row.score - baseline()))}`;
  const baseline = () => rows.find(row => row.candidate.id === main.id).score;
  const roster = (candidate, button) => {
    const reference = report.candidates.find(row => row.id === selectedId);
    const changes = arenaCandidateChanges(candidate.draft, reference.draft, cards);
    const comparing = candidate.id !== selectedId, descriptions = [];
    const team = el('span', '', 'arena-candidate-team');
    const strip = el('span', '', 'arena-candidate-roster'); strip.setAttribute('aria-hidden', 'true');
    strip.toggleAttribute('data-comparing', comparing);
    strip.toggleAttribute('data-member-changes', changes.members > 0);
    strip.toggleAttribute('data-support-changes', changes.supports + changes.pairings > 0);
    candidate.draft.slots.forEach((slot, index) => {
      const pair = el('span', '', 'arena-candidate-pair'), change = changes.slots[index];
      for (const kind of ['member', 'support']) {
        const card = cards.get(slot[`${kind}CardId`]), image = el('img'); image.src = card.imageUrl; image.alt = ''; image.loading = 'lazy';
        const thumb = el('span', '', 'arena-candidate-thumb'); thumb.dataset.kind = kind;
        const changed = kind === 'member' ? change.memberChanged : change.supportChanged;
        const moved = kind === 'support' && change.supportMoved;
        const captain = kind === 'member' && index === 2;
        thumb.dataset.change = changed ? 'replace' : moved ? 'move' : captain && changes.leaderChanged ? 'leader' : 'none';
        thumb.title = `${kind === 'member' ? '成员' : '留影'} · ${card.displayName}`;
        thumb.append(image);
        if (changed || moved) {
          const before = cards.get(change.before[`${kind}CardId`]);
          thumb.title = `${moved ? '调整搭配' : kind === 'member' ? '更换成员' : '更换留影'}：${before.displayName} → ${card.displayName}`;
          descriptions.push(thumb.title);
          thumb.append(el('span', moved ? '调' : '换', 'arena-card-change'));
        }
        if (captain) {
          const leader = el('span', changes.leaderChanged ? '队长' : '★', 'arena-candidate-captain');
          leader.toggleAttribute('data-changed', changes.leaderChanged);
          const text = changes.leaderChanged ? `更换队长：${cards.get(reference.draft.slots[2].memberCardId).displayName} → ${card.displayName}` : `队长 · ${card.displayName}`;
          leader.title = text; if (changes.leaderChanged) descriptions.push(text);
          thumb.append(leader);
        }
        pair.append(thumb);
      }
      strip.append(pair);
    });
    team.append(strip);
    if (comparing) {
      const summary = [changes.members && `换 ${changes.members} 成员`, changes.supports && `换 ${changes.supports} 留影`, changes.pairings && `调 ${changes.pairings} 搭配`, changes.leaderChanged && '换队长'].filter(Boolean).join(' · ') || '成员、留影与队长相同';
      team.append(el('span', summary, 'arena-candidate-changes'));
      button.setAttribute('aria-description', `相对${name(rows.find(row => row.candidate.id === selectedId))}：${summary}。${descriptions.join('；')}`);
      button.title = descriptions.join('\n') || summary;
    }
    return team;
  };
  const choose = row => {
    const fromDialog = dialog.open; if (fromDialog) dialog.close(); onSelect(row.candidate);
    if (!fromDialog) featured.querySelector('button[aria-pressed="true"]')?.focus();
  };
  const unknown = () => preview.mode === 'unknown';
  const value = row => unknown() ? row.candidate.firstRankScore : row.score;
  const highest = () => valid ? [...rows].sort((a, b) => value(b) - value(a) || a.index - b.index)[0] : null;
  const scoreContent = (root, row) => {
    if (unknown()) root.append(el('small', luck ? '均第一平均分' : '得分上限'), el('strong', points(row.candidate.firstRankScore)), el('small', `${luck ? '均末位' : '下限'} ${points(row.candidate.sameRankScore)}`));
    else root.append(el('strong', points(row.score)), el('small', delta(row)));
  };
  const renderList = () => {
    const start = page * pageSize, best = highest(); list.start = start + 1; list.replaceChildren();
    for (const [offset, row] of rows.slice(start, start + pageSize).entries()) {
      const item = el('li'), button = el('button', '', 'arena-candidate-row'); button.type = 'button'; button.setAttribute('aria-label', `查看方案 ${row.index + 1}`);
      button.setAttribute('aria-pressed', String(row.candidate.id === selectedId));
      const title = el('span', '', 'arena-candidate-title'); title.append(el('b', name(row)), el('small', row.candidate.name));
      if (row === best) title.append(el('em', unknown() ? '上限最高' : '最高分'));
      if (row.candidate.id === selectedId) title.append(el('em', '正在查看', 'arena-candidate-selected'));
      const value = el('span', '', 'arena-candidate-value'); scoreContent(value, row); value.append(el('small', `最大损失 ${points(row.candidate.worstLoss)}`, 'arena-candidate-loss'));
      button.append(el('span', String(start + offset + 1).padStart(2, '0'), 'arena-candidate-position'), title, roster(row.candidate, button), value);
      button.addEventListener('click', () => choose(row)); item.append(button); list.append(item);
    }
    pageLabel.textContent = `${page + 1} / ${Math.ceil(rows.length / pageSize)} 页`;
    previous.disabled = page === 0; next.disabled = (page + 1) * pageSize >= rows.length;
    list.scrollTop = 0;
    for (const button of sortGroup.children) { if (button.dataset.sort === 'score') button.textContent = unknown() ? '上限从高到低' : '分数从高到低'; button.setAttribute('aria-pressed', String(button.dataset.sort === sort)); button.disabled = !valid; }
  };
  for (const [value, label] of [['score', '分数从高到低'], ['recommendation', '推荐顺序']]) {
    const button = el('button', label); button.type = 'button'; button.dataset.sort = value;
    button.addEventListener('click', () => { sort = value; page = 0; update(selectedId, preview, valid); }); sortGroup.append(button);
  }
  previous.addEventListener('click', () => { page--; renderList(); });
  next.addEventListener('click', () => { page++; renderList(); });
  close.addEventListener('click', () => dialog.close());
  browse.addEventListener('click', () => { renderList(); dialog.showModal(); });

  function update(id, state, isValid = true) {
    selectedId = id; preview = state; valid = isValid;
    const contextKey = JSON.stringify([preview.mode, preview.songIndex, preview.mode === 'opponents' ? preview.opponents.get(preview.songIndex) : null]);
    if (contextKey !== scoreContext) page = 0;
    scoreContext = contextKey;
    rows = valid ? arenaCandidateOrder(report.candidates, preview, sort) : report.candidates.map((candidate, index) => ({ candidate, index, score: null }));
    const basisText = !valid ? '请修正对手计数后比较分数' : unknown() ? '对手未知 · 下限至上限' : preview.mode === 'opponents'
      ? `${report.songs[preview.songIndex].title} · 对手试算`
      : `三段均第 ${preview.mode === 'first' ? 1 : report.stage.participantCount} 名${report.songs.length > 1 ? ' · 曲池加权' : ''}`;
    basis.textContent = `${basisText} · ${sort === 'score' ? unknown() ? '按得分上限降序' : '按整场分数降序' : '按最大损失从小到大'}${unknown() ? ' · 范围对应三段末位至三段第一' : ' · 分差相对推荐队伍'} · 换卡高亮，相对当前队伍`;
    const recommendation = rows.find(row => row.candidate.id === main.id), best = highest();
    const alternative = best && best !== recommendation ? best : rows.find(row => row.candidate.id !== main.id);
    featured.replaceChildren();
    const shortlist = [recommendation, alternative].filter(Boolean);
    const validationWinner = report.validation?.status === 'changed' ? rows.find(row => row.candidate.id === report.validation.winnerId) : null;
    if (validationWinner && !shortlist.includes(validationWinner)) shortlist.push(validationWinner);
    if (!shortlist.some(row => row.candidate.id === selectedId)) comparedId = selectedId;
    const compared = rows.find(row => row.candidate.id === comparedId);
    if (!shortlist.includes(compared)) shortlist.push(compared);
    for (const row of shortlist) {
      const button = el('button', '', 'arena-candidate-shortcut'); button.type = 'button';
      const label = row === recommendation ? (!unknown() && best === recommendation ? '推荐 · 最高分' : '推荐队伍') : row === validationWinner ? '独立复核首选' : row === best ? unknown() ? '上限最高队' : '当前最高分' : name(row);
      button.setAttribute('aria-label', `选择${label}`); button.setAttribute('aria-pressed', String(row.candidate.id === selectedId));
      const title = el('span', '', 'arena-shortcut-title');
      title.append(el('b', label));
      if (row.candidate.id === selectedId) title.append(el('small', '当前查看', 'arena-shortcut-current'));
      const score = el('span', '', 'arena-shortcut-score');
      score.append(el('small', luck ? unknown() ? '整场平均分范围' : '整场平均分' : unknown() ? '整场得分范围' : '整场得分'));
      const amount = el('strong', unknown() ? `${points(row.candidate.sameRankScore).replace(' 万', '')}–${points(row.candidate.firstRankScore)}` : points(row.score));
      score.append(amount);
      if (!unknown()) score.append(el('small', delta(row), 'arena-shortcut-delta'));
      button.append(title, roster(row.candidate, button), score); button.addEventListener('click', () => choose(row)); featured.append(button);
    }
    renderList();
  }
  return { element, update };
}
