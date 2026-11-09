const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };

/** Arena replaces attributes and missions, but retains the league's song band. */
export function arenaStageTracks(tracks, charts, bandId) {
  const available = new Set(charts.filter(chart => chart.analysisDataUrl).map(chart => chart.trackId));
  return tracks.filter(track => track.bandIds.includes(`band-${bandId}`) && available.has(track.id));
}

export const arenaDifficulties = ['easy', 'normal', 'hard', 'expert'];

/** Existing selections keep both their individual difficulty and weight. */
export function addArenaSongs(songs, tracks, charts, difficulty) {
  const selected = new Map(songs.map(song => [song.trackId, song]));
  for (const track of tracks) {
    if (selected.has(track.id)) continue;
    const available = arenaDifficulties.filter(d => charts.some(c => c.trackId === track.id && c.difficulty === d && c.analysisDataUrl));
    if (available.length) selected.set(track.id, { trackId: track.id, title: track.title,
      difficulty: available.includes(difficulty) ? difficulty : available.at(-1), weight: 1 });
  }
  return [...selected.values()];
}

export function createArenaSongPicker({ charts, onChange }) {
  const dialog = el('dialog', '', 'arena-song-dialog'); dialog.setAttribute('aria-label', '选择舞台歌曲');
  const header = el('header'), title = el('h2'), close = el('button', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭选歌');
  header.append(title, close);
  const query = el('input'); query.type = 'search'; query.placeholder = '搜索歌曲'; query.setAttribute('aria-label', '搜索舞台歌曲');
  const toolbar = el('div', '', 'arena-song-batch'), difficultyLabel = el('label', '批量难度'), difficulty = el('select');
  difficulty.setAttribute('aria-label', '批量难度');
  for (const value of arenaDifficulties) { const option = el('option', value.toUpperCase()); option.value = value; difficulty.append(option); }
  difficulty.value = 'hard'; difficultyLabel.append(difficulty); toolbar.append(difficultyLabel);
  const action = (label, fn) => { const button = el('button', label); button.type = 'button'; button.addEventListener('click', fn); toolbar.append(button); return button; };
  const hint = el('p', '可连续选歌；批量加入时，无所选难度的歌曲使用其最高可用难度。', 'arena-hint');
  const notice = el('p', '', 'arena-hint'); notice.setAttribute('role', 'status');
  const list = el('div', '', 'arena-song-choices'), footer = el('footer'), summary = el('span'), done = el('button', '完成选歌'); done.type = 'button';
  footer.append(summary, done); dialog.append(header, query, toolbar, hint, notice, list, footer);
  let tracks = [], selected = new Map();
  const visible = () => {
    const words = query.value.trim().toLocaleLowerCase().split(/\s+/);
    return tracks.filter(track => words.every(word => track.title.toLocaleLowerCase().includes(word)));
  };
  const commit = (message = '') => { onChange([...selected.values()]); notice.textContent = message; render(); };
  const add = available => {
    selected = new Map(addArenaSongs([...selected.values()], available, charts, difficulty.value).map(song => [song.trackId, song]));
    commit();
  };
  action('全选当前乐队', () => add(tracks));
  action('全选搜索结果', () => add(visible()));
  action('统一已选难度', () => {
    let skipped = 0;
    for (const [id, song] of selected) {
      if (charts.some(c => c.trackId === id && c.difficulty === difficulty.value && c.analysisDataUrl)) selected.set(id, { ...song, difficulty: difficulty.value });
      else skipped++;
    }
    commit(skipped ? `${skipped} 首没有 ${difficulty.value.toUpperCase()} 谱面，保留原难度。` : `已选歌曲已统一为 ${difficulty.value.toUpperCase()}。`);
  });
  action('移除搜索结果', () => { visible().forEach(track => selected.delete(track.id)); commit(); });
  action('清空已选', () => { selected.clear(); commit(); });
  const render = () => {
    const shown = visible(), scroll = list.scrollTop;
    summary.textContent = `已选 ${selected.size} / ${tracks.length} 首`;
    list.replaceChildren(...shown.map(track => {
      const row = el('article', '', 'arena-song-choice'), copy = el('div'), choices = el('div', '', 'tool-options');
      const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(track.id); checkbox.setAttribute('aria-label', `选择 ${track.title}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) add([track]); else { selected.delete(track.id); commit(); }
        list.querySelector(`[data-track-id="${track.id}"] input`)?.focus({ preventScroll: true });
      }); row.append(checkbox);
      if (track.jacketUrl) { const image = el('img'); image.src = track.jacketUrl; image.alt = ''; image.loading = 'lazy'; row.append(image); }
      copy.append(el('strong', track.title));
      for (const value of arenaDifficulties) {
        const chart = charts.find(chart => chart.trackId === track.id && chart.difficulty === value && chart.analysisDataUrl);
        if (!chart) continue;
        const button = el('button', `${{ easy: 'EZ', normal: 'NM', hard: 'HD', expert: 'EX' }[value]} ${chart.displayLevel}`);
        button.type = 'button'; button.dataset.difficulty = value;
        button.setAttribute('aria-pressed', String(selected.get(track.id)?.difficulty === value));
        button.setAttribute('aria-label', `${track.title} ${value.toUpperCase()} ${chart.displayLevel}`);
        button.addEventListener('click', () => {
          selected.set(track.id, { trackId: track.id, title: track.title, weight: 1, ...selected.get(track.id), difficulty: value }); commit();
          list.querySelector(`[data-track-id="${track.id}"] [data-difficulty="${value}"]`)?.focus({ preventScroll: true });
        }); choices.append(button);
      }
      copy.append(choices); row.append(copy); row.dataset.trackId = track.id;
      return row;
    }));
    if (!shown.length) list.append(el('p', '没有匹配的歌曲', 'arena-hint'));
    list.scrollTop = scroll;
  };
  query.addEventListener('input', () => { list.scrollTop = 0; render(); });
  close.addEventListener('click', () => dialog.close()); done.addEventListener('click', () => dialog.close());
  return { element: dialog, open(available, songs, bandName) {
    tracks = available; selected = new Map(songs.map(song => [song.trackId, { ...song }]));
    title.textContent = `${bandName} · 选歌`; query.value = ''; notice.textContent = ''; render(); dialog.showModal(); query.focus();
  } };
}
