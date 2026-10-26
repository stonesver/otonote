import {rankingTableColumns, formatRankingCell, rankingStatusTags} from './song-ranking-table.mjs';
import {RANKING_OPTIONS} from './song-ranking-options.mjs';
import {rankingSongCover} from './ranking-song-cover.mjs';

export function renderRankingTable(root, {rows, page, size, mode, metric, direction, locale, artwork, expanded, detail, reveal, scoreLabel, append = false}) {
  const document = root.ownerDocument, en = locale.startsWith('en');
  const make = (tag, text = '', className = '') => { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; };
  const columns = rankingTableColumns(mode,metric), table = root.querySelector('[data-ranking-table]');
  const head = root.querySelector('[data-ranking-head]'), signature = columns.map(column => column.key).join(',');
  if (table.dataset.columns !== signature) {
    const colgroup = root.querySelector('[data-ranking-cols]'); colgroup.replaceChildren();
    colgroup.append(make('col','','ranking-position-col'));
    const heading = make('tr'); heading.append(make('th','#','ranking-position')); heading.firstChild.scope = 'col';
    for (const column of columns) {
      const col = make('col'); if (column.key === 'title') col.className = 'ranking-song-col'; else col.style.width = `${column.width}px`; colgroup.append(col);
      const th = make('th','','title' === column.key ? 'ranking-song' : ''); th.scope = 'col'; th.dataset.column = column.key;
      const button = make('button'); button.type = 'button'; button.dataset.sort = column.key;
      button.append(make('span'),make('i','↕')); button.lastChild.setAttribute('aria-hidden','true'); th.append(button); heading.append(th);
    }
    head.replaceChildren(heading);
    table.style.setProperty('--ranking-data-width',`${columns.filter(column => column.key !== 'title').reduce((sum,column) => sum + column.width,0)}px`);
    table.dataset.columns = signature;
  }
  for (const column of columns) {
    const button = head.querySelector(`[data-sort="${column.key}"]`), active = column.key === metric;
    let label = column.labels[en ? 1 : 0];
    if (column.key === 'expectedScore') label = scoreLabel;
    if (column.key === 'title') label = en ? 'Song & status' : '歌曲与状态';
    if (column.key === 'durationSeconds') label = en ? 'Selected duration' : '所选时长';
    if (mode === 'gekisou' && ['minimumScore','maximumScore'].includes(column.key)) label = en ? column.key === 'minimumScore' ? 'Sample minimum' : 'Sample maximum' : column.key === 'minimumScore' ? '样本最低分' : '样本最高分';
    button.firstChild.textContent = label; button.lastChild.textContent = active ? direction === 'asc' ? '↑' : '↓' : '↕';
    button.title = `${label} · ${en ? 'Click to change sort order' : '点击排序，再次点击切换方向'}`;
    button.closest('th').setAttribute('aria-sort',active ? direction === 'asc' ? 'ascending' : 'descending' : 'none');
  }
  const body = root.querySelector('[data-rows]'); if (!append) body.replaceChildren();
  for (const row of rows.slice(page*size,(page+1)*size)) {
    const tr = make('tr');
    if (RANKING_OPTIONS[metric][2] !== 'text' && row.rank > 0 && row.rank <= 3) tr.dataset.podium = String(row.rank);
    tr.append(make('td',row.rank === null ? '—' : String(row.rank).padStart(2,'0'),'ranking-position'));
    const expandedRow = make('tr','','ranking-detail'); expandedRow.hidden = !expanded.has(row.id); expandedRow.id = `detail-${row.id}`;
    const cell = make('td'), content = make('div','','ranking-detail-content'); cell.colSpan = columns.length+1; cell.append(content); expandedRow.append(cell);
    for (const column of columns) {
      const td = make('td','','title' === column.key ? 'ranking-song' : 'ranking-value'); td.dataset.column = column.key;
      if (column.key === metric) td.dataset.active = '';
      if (column.key === 'title') {
        const track = make('div','','ranking-track');
        track.append(rankingSongCover(document,artwork[row.trackId]));
        const name = make('div'),subtitle=make('div','','ranking-subtitle'),difficulty=make('span',row.difficulty.toUpperCase(),'ranking-difficulty');difficulty.dataset.difficulty=row.difficulty;subtitle.append(difficulty,make('small',`Lv.${row.level}`));name.append(make('strong',row.title),subtitle);
        const tags = make('div','','ranking-track-tags');
        for(const tag of rankingStatusTags(row,locale)) {
          const badge=make('span',tag.label,`ranking-tag ranking-tag--${tag.kind}`);badge.title=`${tag.title}：${tag.description??tag.label}`;badge.dataset.label=badge.title;badge.setAttribute('aria-label',badge.title);badge.tabIndex=0;if(tag.state)badge.dataset.state=tag.state;
          if(tag.icons?.length){badge.textContent='';badge.classList.add('ranking-tag--icon');for(const url of tag.icons){const img=make('img');img.src=url;img.alt='';img.width=tag.kind==='band'?44:18;img.height=18;img.loading='lazy';img.addEventListener('error',()=>{img.remove();if(!badge.querySelector('img')){badge.textContent=tag.label;badge.classList.remove('ranking-tag--icon');}},{once:true});badge.append(img);}}
          else if(tag.editions?.length){badge.textContent='';for(const edition of tag.editions){const symbol=make('span','','ranking-edition-symbol');symbol.dataset.edition=edition;symbol.setAttribute('aria-hidden','true');badge.append(symbol);}}
          else if(tag.kind==='state'){badge.textContent='';const symbol=make('span','','ranking-state-symbol');symbol.dataset.symbol=tag.symbol;symbol.setAttribute('aria-hidden','true');badge.append(symbol);}
          tags.append(badge);
        }
        track.append(name);
        const button = make('button',expandedRow.hidden ? '⋯' : '−','ranking-detail-toggle'); button.type = 'button';
        button.setAttribute('aria-label',en ? `Details for ${row.title} ${row.difficulty}` : `查看 ${row.title} ${row.difficulty} 明细`);
        button.setAttribute('aria-expanded',String(!expandedRow.hidden)); button.setAttribute('aria-controls',expandedRow.id);
        button.addEventListener('click',()=>{
          expandedRow.hidden = !expandedRow.hidden;
          if (!expandedRow.hidden && !content.children.length) detail(content,row);
          expandedRow.hidden ? expanded.delete(row.id) : expanded.add(row.id);
          button.textContent = expandedRow.hidden ? '⋯' : '−'; button.setAttribute('aria-expanded',String(!expandedRow.hidden));
        });
        track.append(button); td.append(track,tags);
      } else {
        const value = formatRankingCell(column.key,row,locale);
        if (column.key === 'difficulty') { const badge = make('span',value,'ranking-difficulty'); badge.dataset.difficulty = row.difficulty; td.append(badge); }
        else if (column.key === 'calculationState') { const state = make('span',value,'ranking-state'); state.dataset.state = row.pending ? 'pending' : Number.isFinite(row.expectedScore) ? 'calculated' : 'unavailable'; td.append(state); }
        else td.textContent = value;
        if (RANKING_OPTIONS[column.key][2] === 'text') td.classList.add('ranking-text-value');
      }
      tr.append(td);
    }
    if (!expandedRow.hidden) detail(content,row);
    body.append(tr,expandedRow);
  }
  if (reveal) {
    const wrap = root.querySelector('[data-results]'), th = head.querySelector(`[data-column="${metric}"]`);
    const fixedWidth = head.querySelector('.ranking-position').offsetWidth + head.querySelector('.ranking-song').offsetWidth;
    const columnLeft=th.getBoundingClientRect().left-table.getBoundingClientRect().left;
    wrap.scrollLeft = metric === 'title' ? 0 : Math.max(0,columnLeft-fixedWidth);
  }
}
