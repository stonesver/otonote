const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };

/** Arena replaces attributes and missions, but retains the league's song band. */
export function arenaStageTracks(tracks, charts, bandId) {
  const available = new Set(charts.filter(chart => chart.analysisDataUrl).map(chart => chart.trackId));
  return tracks.filter(track => track.bandIds.includes(`band-${bandId}`) && available.has(track.id));
}

export function createArenaSongPicker({ charts, onSelect }) {
  const dialog = el('dialog', '', 'arena-song-dialog'); dialog.setAttribute('aria-label', '选择舞台歌曲');
  const header = el('header'), title = el('h2'), close = el('button', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭选歌');
  header.append(title, close);
  const query = el('input'); query.type = 'search'; query.placeholder = '搜索歌曲'; query.setAttribute('aria-label', '搜索舞台歌曲');
  const hint = el('p', '点击难度加入曲池', 'arena-hint'), list = el('div', '', 'arena-song-choices');
  dialog.append(header, query, hint, list);
  let tracks = [], selected = new Set();
  const render = () => {
    const words = query.value.trim().toLocaleLowerCase().split(/\s+/);
    const visible = tracks.filter(track => words.every(word => track.title.toLocaleLowerCase().includes(word)));
    list.replaceChildren(...visible.map(track => {
      const row = el('article', '', 'arena-song-choice'), copy = el('div'), choices = el('div', '', 'tool-options');
      if (track.jacketUrl) { const image = el('img'); image.src = track.jacketUrl; image.alt = ''; image.loading = 'lazy'; row.append(image); }
      copy.append(el('strong', track.title));
      const chosen = selected.has(track.id);
      for (const difficulty of ['easy', 'normal', 'hard', 'expert']) {
        const chart = charts.find(chart => chart.trackId === track.id && chart.difficulty === difficulty && chart.analysisDataUrl);
        if (!chart) continue;
        const button = el('button', `${{ easy: 'EZ', normal: 'NM', hard: 'HD', expert: 'EX' }[difficulty]} ${chart.displayLevel}`);
        button.type = 'button'; button.dataset.difficulty = difficulty; button.disabled = chosen;
        button.setAttribute('aria-label', `${track.title} ${difficulty.toUpperCase()} ${chart.displayLevel}${chosen ? ' 已加入' : ''}`);
        button.addEventListener('click', () => { onSelect(track, difficulty); dialog.close(); }); choices.append(button);
      }
      copy.append(choices); row.append(copy); if (chosen) row.append(el('small', '已加入'));
      return row;
    }));
    if (!visible.length) list.append(el('p', '没有匹配的歌曲', 'arena-hint'));
  };
  query.addEventListener('input', render);
  close.addEventListener('click', () => dialog.close());
  return { element: dialog, open(available, songs, bandName) {
    tracks = available; selected = new Set(songs.map(song => song.trackId));
    title.textContent = `${bandName} · 选歌`; query.value = ''; render(); dialog.showModal(); query.focus();
  } };
}
