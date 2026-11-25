import {currentServerContext} from './game-servers.mjs';
import {createRankingRow, validateHighScoreDeck, validatePlayerProfile} from './player-ranking-decks.mjs';

import {rankingEvents, rankingEventState, filterRankingEvents, rankingEventLabel, rankingEventForBand, availableRankingBoards} from './player-ranking-events.mjs';
import {rankingPicker} from './ranking-picker.mjs';
import {rankingSongCover} from './ranking-song-cover.mjs';

export const rankingBoards = ['event-points', 'music', 'total-music'];
const copy = {
  unavailable: ['该区服的此项榜单暂无数据', 'This board has no data for this server yet.'],
  empty: ['暂无排名记录', 'No ranking records yet.'],
  stale: ['数据已过期，以下为最后一次采集结果', 'Data has expired. Showing the last captured results.'],
  available: ['已加载最近采集的榜单', 'Latest captured rankings loaded.'],
};
const labels = {'event-points':['活动积分榜','Event points'], music:['单曲榜','Song'], 'total-music':['总分榜','Total score'],auto:['选择榜单','Choose a board']};

export function validateRankingResponse(data, server, board, event, music) {
  if (data?.schemaVersion !== 1 || data.serverId !== server
    || (board === 'auto' ? ![...rankingBoards, 'auto'].includes(data.board) : data.board !== board)
    || event && data.eventId !== event || music && data.musicId !== music
    || !Object.hasOwn(copy, data.status) || !Array.isArray(data.entries)
    || !Array.isArray(data.events) || !Array.isArray(data.songs)
    || data.boards !== undefined && (!Array.isArray(data.boards) || data.boards.some(id => !rankingBoards.includes(id)))) {
    throw Error('Invalid ranking response');
  }
  const ids = new Set();
  for (const row of data.entries) {
    if (typeof row?.playerId !== 'string' || !row.playerId || ids.has(row.playerId)
      || typeof row.name !== 'string' || !Number.isSafeInteger(row.rank) || row.rank < 1
      || !Number.isSafeInteger(row.score) || row.score < 0) throw Error('Invalid ranking entry');
    ids.add(row.playerId);
    validateHighScoreDeck(row.highScoreDeck);
    validatePlayerProfile(row.profile);
  }
  for (const item of [...data.events, ...data.songs]) {
    if (typeof item?.id !== 'string' || typeof item.name !== 'string') throw Error('Invalid ranking option');
  }
  for (const stamp of [data.observedAt, data.expiresAt]) {
    if (stamp != null && (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp)))) throw Error('Invalid ranking timestamp');
  }
  if (data.nextCursor != null && typeof data.nextCursor !== 'string') throw Error('Invalid ranking cursor');
  return data;
}

export function rankingStatus(data, now = Date.now()) {
  if (data.isFinal === true && data.status !== 'unavailable') return data.status === 'empty' ? 'empty' : 'available';
  return data.status !== 'unavailable' && data.expiresAt && Date.parse(data.expiresAt) <= now ? 'stale' : data.status;
}

export function matchRankingEntry(entry, rawQuery, mode = 'auto') {
  const raw = String(rawQuery ?? '').trim();
  if (!raw || !entry) return null;
  const lower = raw.toLowerCase();
  const idStr = String(entry.playerId ?? '');
  const nameStr = String(entry.name ?? '');

  if (mode === 'rank') {
    const rankMatch = raw.match(/^(?:#|第\s*)?(\d+)\s*名?$/i);
    if (!rankMatch) return null;
    const target = Number(rankMatch[1]);
    return entry.rank === target ? { kind: 'rank', score: 100 } : null;
  }

  if (mode === 'id') {
    const cleanId = (raw.match(/^(?:id|uid)[:\s]*(.+)$/i)?.[1] ?? raw).trim().toLowerCase();
    if (!cleanId) return null;
    if (idStr.toLowerCase() === cleanId) return { kind: 'id', score: 100 };
    if (cleanId.length >= 4 && idStr.toLowerCase().includes(cleanId)) return { kind: 'id-partial', score: 80 };
    return null;
  }

  if (mode === 'name') {
    const cleanName = (raw.match(/^(?:name|昵称)[:\s]*(.+)$/i)?.[1] ?? raw).trim().toLowerCase();
    if (!cleanName) return null;
    if (nameStr.toLowerCase() === cleanName) return { kind: 'name', score: 100 };
    if (nameStr.toLowerCase().includes(cleanName)) return { kind: 'name-partial', score: 84 };
    return null;
  }

  const rankExplicit = raw.match(/^(?:#|第\s*)(\d+)\s*名?$/i);
  if (rankExplicit) {
    const target = Number(rankExplicit[1]);
    return entry.rank === target ? { kind: 'rank', score: 100 } : null;
  }

  const idExplicit = raw.match(/^(?:id|uid)[:\s]+(.+)$/i);
  if (idExplicit) {
    const targetId = idExplicit[1].trim().toLowerCase();
    if (!targetId) return null;
    if (idStr.toLowerCase() === targetId) return { kind: 'id', score: 100 };
    if (targetId.length >= 3 && idStr.toLowerCase().includes(targetId)) return { kind: 'id-partial', score: 80 };
    return null;
  }

  const nameExplicit = raw.match(/^(?:name|昵称)[:\s]+(.+)$/i);
  if (nameExplicit) {
    const targetName = nameExplicit[1].trim().toLowerCase();
    if (!targetName) return null;
    if (nameStr.toLowerCase() === targetName) return { kind: 'name', score: 100 };
    if (nameStr.toLowerCase().includes(targetName)) return { kind: 'name-partial', score: 84 };
    return null;
  }

  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    if (entry.rank === num) return { kind: 'rank', score: 100 };
    if (idStr.toLowerCase() === lower) return { kind: 'id', score: 96 };
    if (nameStr.toLowerCase() === lower) return { kind: 'name', score: 92 };
    if (raw.length >= 5 && idStr.toLowerCase().includes(lower)) return { kind: 'id-partial', score: 78 };
    if (nameStr.toLowerCase().includes(lower)) return { kind: 'name-partial', score: 72 };
    return null;
  }

  const tokens = raw.split(/[\s,，/]+/).filter(Boolean);
  if (tokens.length > 1) {
    let totalScore = 0;
    const kinds = [];
    for (const token of tokens) {
      const m = matchRankingEntry(entry, token, 'auto');
      if (!m) return null;
      totalScore += m.score;
      kinds.push(m.kind);
    }
    return { kind: kinds.join('+'), score: Math.round(totalScore / tokens.length) };
  }

  if (nameStr.toLowerCase() === lower) return { kind: 'name', score: 96 };
  if (idStr.toLowerCase() === lower) return { kind: 'id', score: 92 };
  if (nameStr.toLowerCase().includes(lower)) return { kind: 'name-partial', score: 82 };
  if (raw.length >= 4 && idStr.toLowerCase().includes(lower)) return { kind: 'id-partial', score: 72 };
  return null;
}

export function findBestRankingMatch(entries, rawQuery, mode = 'auto') {
  if (!Array.isArray(entries)) return [];
  const matches = [];
  for (const entry of entries) {
    const m = matchRankingEntry(entry, rawQuery, mode);
    if (m) matches.push({ entry, ...m });
  }
  if (!matches.length) return [];
  const topScore = Math.max(...matches.map(item => item.score));
  const filtered = topScore >= 95 ? matches.filter(item => item.score === topScore) : matches;
  return filtered.sort((a, b) => b.score - a.score || a.entry.rank - b.entry.rank);
}

export function installPlayerRankings(root) {
  if (root.dataset.rankInstalled) return;
  root.dataset.rankInstalled = 'true';
  const en = root.dataset.locale === 'en', language = en ? 'en-US' : 'zh-CN';
  const q = selector => root.querySelector(selector);
  const status = q('[data-rank-status]'), rows = q('[data-rank-rows]');
  const empty = q('[data-rank-empty]');
  let cardCatalog = {};
  try {
    const value = JSON.parse(q('[data-rank-cards]')?.textContent || '{}');
    const region = location.pathname.split('/')[1];
    if (value.region === region) cardCatalog = value;
  } catch { /* Rankings remain usable without card artwork. */ }
  let server;
  try { server = currentServerContext().serverId; }
  catch { status.textContent = en ? 'Invalid server link. Choose a server.' : '区服链接不匹配，请重新选择区服。'; return; }
  const serverShortLabels = {
    jp: en ? 'JP' : '日服',
    'global-hmt': en ? 'HMT' : '港澳台',
    'global-kr': en ? 'KR' : '韩服',
    'global-en': 'EN'
  };
  const serverChip = q('[data-rank-server-label]');
  if (serverChip) serverChip.textContent = serverShortLabels[server] || (en ? 'Server' : '选服');
  const commandBar = q('[data-rank-command]');
  const filterToggle = q('[data-rank-filters-toggle]');
  const setFiltersOpen = open => {
    if (!commandBar) return;
    commandBar.dataset.filtersOpen = open ? 'true' : 'false';
    const state = open ? 'true' : 'false';
    filterToggle?.setAttribute('aria-expanded', state);
    if (serverChip?.tagName === 'BUTTON') serverChip.setAttribute('aria-expanded', state);
  };
  const toggleFilters = () => setFiltersOpen(commandBar?.dataset.filtersOpen !== 'true');
  filterToggle?.addEventListener('click', toggleFilters);
  if (serverChip?.tagName === 'BUTTON') serverChip.addEventListener('click', toggleFilters);
  commandBar?.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && commandBar.dataset.filtersOpen === 'true') {
      setFiltersOpen(false);
      filterToggle?.focus();
    }
  });
  for (const link of root.querySelectorAll('[data-ranking-server]')) {
    if (link.dataset.rankingServer === server) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
    if (!server) {
      const target = new URL(link.href, location.href);
      if (target.pathname === location.pathname) {
        const source = new URLSearchParams(location.search);
        for (const key of ['event', 'board', 'music']) if (source.has(key)) target.searchParams.set(key, source.get(key));
        link.href = target.href;
      }
    }
  }
  let context = {events:[],bands:[],attributes:[],songs:[]};
  try {const value=JSON.parse(q('[data-rank-context]')?.textContent || '{}');if(value.region===location.pathname.split('/')[1]) context=value;} catch { /* Artwork is optional. */ }
  const event = q('[data-rank-event]'), board = q('[data-rank-board]'), song = q('[data-rank-song]'), band=q('[data-rank-band]');
  const next = q('[data-rank-next]'), retry = q('[data-rank-retry]'), refresh = q('[data-rank-refresh]');
  const sentinel=q('[data-rank-sentinel]'), loadNote=q('[data-rank-load-note]');
  const locateForm = q('[data-rank-locate-form]'), locateInput = q('[data-rank-locate-input]'), locateClear = q('[data-rank-locate-clear]');
  const locateMode = q('[data-rank-locate-mode]'), locateCount = q('[data-rank-locate-count]');
  let locateCycleIndex = 0, lastLocateKey = '';
  const modePlaceholders = {
    auto: en ? '#Rank / Name / ID…' : '排名 / 昵称 / 玩家ID…',
    rank: en ? 'Enter rank (e.g. 20)…' : '输入排名数字（如 20）…',
    name: en ? 'Enter player name…' : '输入玩家昵称…',
    id: en ? 'Enter player ID…' : '输入玩家 ID…'
  };
  const syncLocatePlaceholder = () => {
    if (!locateInput) return;
    const m = locateMode?.value || 'auto';
    locateInput.placeholder = modePlaceholders[m] || modePlaceholders.auto;
  };
  syncLocatePlaceholder();
  const params = new URLSearchParams(location.search);
  board.value = rankingBoards.includes(params.get('board')) ? params.get('board') : 'auto';
  let requestedEvent = params.get('event') || '', requestedMusic = params.get('music') || '';
  let pending, generation = 0, cursor = null, lastData = null, failedAppend = false, loading=false, autoPaused=false;
  let snapshots=[], events=rankingEvents(context.events,[]);
  const stateLabels={active:en?'Ongoing':'进行中',ended:en?'Ended':'已结束',upcoming:en?'Upcoming':'未开始',unknown:en?'Schedule unknown':'时间待确认'};
  const seen = new Set(), pickers = new Map();
  const options = (select, items, selected, placeholder) => {
    select.replaceChildren(...(items.length ? items : [{id:'',name:placeholder}]).map(item => new Option(item.name,item.id)));
    select.value = selected ?? ''; select.disabled = !items.length;pickers.get(select)?.update();
  };
  options(band,[{id:'',name:en?'All bands':'全部乐队'},...context.bands],params.get('band') || '','');
  if (!band.value) band.value='';
  const syncEvents = () => {
    events=rankingEvents(context.events,snapshots);
    const filtered=filterRankingEvents(events,band.value);
    options(event,filtered.map(item=>({id:item.id,name:rankingEventLabel(item,en)})),requestedEvent,en?'No matching events':'暂无符合条件的活动');
  };
  requestedEvent=rankingEventForBand(events,band.value,requestedEvent);
  syncEvents();
  const pickerLabels=[en?'Band':'乐队',en?'Event':'活动',en?'Board':'榜单',en?'Song':'歌曲'];
  [band,event,board,song].forEach((select,index)=>pickers.set(select,rankingPicker(select,{label:pickerLabels[index],en,
    describe:id=> select===band ? context.bands.find(item=>item.id===id) : select===song ? context.songs.find(item=>item.id===id)
      : select===event ? (()=>{const item=events.find(item=>item.id===id);return item && {name:item.name,badge:stateLabels[item.state]+(item.isFinal ? (en?' · Final':' · 最终记录'):''),state:item.state};})() : null})));
  const showHeading = () => {
    const selected=events.find(item=>item.id===requestedEvent), state=rankingEventState(selected);
    q('[data-rank-event-name]').textContent=selected?.name || '';
    const badge=q('[data-rank-event-state]');badge.hidden=!selected;badge.textContent=stateLabels[state] || stateLabels.unknown;badge.dataset.state=state;
    const bonuses=q('[data-rank-bonuses]');bonuses.replaceChildren();
    for (const id of selected?.attributes || []) {
      const attribute=context.attributes.find(item=>item.id===String(id));if(!attribute) continue;
      const item=document.createElement('span');item.className='pr-bonus';item.title=`${en?'Event bonus':'活动加成'} · ${attribute.name}`;
      if(attribute.image) {const image=document.createElement('img');image.src=attribute.image;image.alt=item.title;image.width=image.height=24;image.addEventListener('error',()=>{item.textContent=attribute.name;},{once:true});item.append(image);}
      else item.textContent=attribute.name;
      bonuses.append(item);
    }
    const type=lastData?.board || board.value, selectedSong=lastData?.songs.find(item=>item.id===requestedMusic);
    q('[data-rank-song-name]').textContent=(type==='music' ? selectedSong?.name : labels[type]?.[Number(en)]) || (en?'No board data yet':'榜单暂未收录');
    const cover=q('[data-rank-cover]');cover.hidden=type!=='music';cover.replaceChildren();
    if(type==='music') cover.append(rankingSongCover(document,context.songs.find(item=>item.id===requestedMusic)?.image,34));
  };
  const showStatus = () => {
    if (!lastData) return;
    const state=rankingStatus(lastData), ended=rankingEventState(events.find(item=>item.id===requestedEvent))==='ended' || lastData.eventState==='ended';
    status.textContent=lastData.isFinal ? (en?'Ended · Final record'+(state==='empty'?' · No entries':''):'已结束 · 最终记录'+(state==='empty'?' · 无排名记录':''))
      : ended ? (en?'Ended · Awaiting final capture':'已结束 · 等待最终采集') : copy[state][Number(en)];
    status.dataset.state=lastData.isFinal ? 'final' : state;
  };
  const supportsScroll=typeof IntersectionObserver!=='undefined';
  const maybeLoad=()=>{
    if (!supportsScroll || !cursor || loading || autoPaused || !root.isConnected || document.visibilityState==='hidden') return;
    const bounds=sentinel.getBoundingClientRect();if(bounds.top<innerHeight+280 && bounds.bottom>0) load(true);
  };
  const observer=supportsScroll ? new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)) maybeLoad();},{rootMargin:'280px 0px'}) : null;
  observer?.observe(sentinel);
  const noMatchingEvents=()=>{
    pending?.abort();++generation;loading=false;autoPaused=true;refresh.disabled=true;retry.hidden=true;next.hidden=true;
    rows.replaceChildren();seen.clear();cursor=null;lastData=null;empty.hidden=false;status.dataset.state='unavailable';
    status.textContent=en?'No events match this band.':'该乐队暂无活动。';q('[data-rank-count]').textContent='';q('[data-rank-time]').textContent='';loadNote.textContent='';showHeading();
    const url=new URL(location.href);url.searchParams.set('band',band.value);for(const key of ['event','music','board']) url.searchParams.delete(key);history.replaceState(history.state,'',url);
  };
  async function load(append = false) {
    if (!server || append && (loading || !cursor)) return;
    if(band.value && !filterRankingEvents(events,band.value).length){noMatchingEvents();return;}
    pending?.abort(); pending = new AbortController(); const controller = pending, request = ++generation;
    loading=true;autoPaused=false;failedAppend=false;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    const type = board.value || 'auto', eventId = requestedEvent, musicId = type === 'music' ? requestedMusic : '';
    const query = new URLSearchParams({server, board:type});
    if (eventId) query.set('event', eventId); if (musicId) query.set('music', musicId);
    if (append && cursor) query.set('cursor', cursor);
    if (!append) { rows.replaceChildren(); seen.clear(); cursor = null; lastData = null;showHeading(); }
    next.hidden = true; retry.hidden = true; refresh.disabled = true;
    status.textContent = en ? 'Loading…' : '正在加载…';loadNote.textContent=append ? (en?'Loading more players…':'正在加载更多玩家…'):'';
    status.dataset.state = 'loading'; rows.setAttribute('aria-busy', 'true'); empty.hidden = true;
    q('[data-rank-song-label]').hidden = type !== 'music';
    if (!append) { q('[data-rank-time]').textContent = ''; q('[data-rank-count]').textContent = ''; }
    try {
      const response = await fetch('/api/v1/player-rankings?' + query, {signal:controller.signal, cache:'no-store'});
      if (request !== generation) return;
      if (response.status === 404) { lastData = null; status.textContent = copy.unavailable[Number(en)]; status.dataset.state = 'unavailable'; empty.hidden = seen.size > 0;autoPaused=true; return; }
      if (append && response.status === 400) {
        cursor = null; autoPaused=true;lastData = null;retry.hidden = false;
        status.textContent = en ? 'The snapshot changed. Reload to see the new rankings.' : '榜单快照已更新，请重新加载查看最新排名。'; return;
      }
      if (!response.ok) throw Error('Request failed');
      const data = validateRankingResponse(await response.json(), server, type, eventId, musicId);
      if (request !== generation) return;
      lastData = data;snapshots=data.events;
      requestedEvent = data.eventId || requestedEvent; requestedMusic = data.musicId || '';
      syncEvents();
      options(song, data.songs, data.musicId, en ? 'No song data' : '暂无歌曲数据');
      const available = availableRankingBoards(events.find(item=>item.id===requestedEvent),data.boards ?? [],data.board);
      if(data.board==='auto')available.unshift('auto');
      options(board, available.map(id => ({id, name:labels[id][Number(en)]})), data.board, en ? 'No board data' : '暂无榜单数据');
      showHeading();showStatus();
      q('[data-rank-song-label]').hidden = data.board !== 'music';
      q('[data-rank-time]').textContent = data.observedAt ? `${en ? 'Captured' : '采集时间'} ${new Date(data.observedAt).toLocaleString(language)}` : '';
      if (data.observedAt) q('[data-rank-time]').setAttribute('datetime', data.observedAt);
      else q('[data-rank-time]').removeAttribute('datetime');
      const scoreLabel = data.board === 'event-points' ? (en ? 'Points' : '活动积分') : data.board === 'total-music' ? (en ? 'Total score' : '总分') : (en ? 'Score' : '成绩');
      const scoreHead = q('[data-rank-score-label]');
      if (scoreHead) scoreHead.textContent = scoreLabel;
      const teamHead = q('[data-rank-team-label]');
      if (teamHead) teamHead.textContent = data.board === 'total-music' ? (en ? 'Ranking team' : '榜单队伍') : (en ? 'High-score team' : '最高分队伍');
      q('[data-rank-footnote]').textContent=data.board==='total-music'
        ? (en?'Total scores and ordering come from the official total-score board. The attached public team is not a separate team for every song. Captures may cover only part of the ranking.':'总分与排序来自官方总分榜；附带队伍不代表每首歌曲各自的队伍。当前采集结果可能仅覆盖部分排名。')
        : (en?'Teams and power are saved with the highest score. Captured results may cover only part of the ranking.':'队伍与综合力为最高分成绩对应的游戏记录。当前采集结果可能仅覆盖部分排名。');
      for (const entry of data.entries) {
        if (seen.has(entry.playerId)) continue;
        seen.add(entry.playerId);
        const item=createRankingRow(entry, {en, catalog:cardCatalog, server, scoreLabel});
        if(data.board==='total-music'){
          item.querySelector('.pr-team-preview')?.setAttribute('aria-label',en?'Team attached to the total-score ranking':'总分榜附带队伍');
          const details=item.querySelector('details');
          details?.addEventListener('toggle',()=>{
            if(!details.open)return;
            const heading=details.querySelector('.pr-deck-heading');
            if(heading){heading.querySelector('h3').textContent=en?'Team attached to this ranking':'榜单附带队伍';
              heading.querySelector('p').textContent=en?'The official total-score board provides one public team, not a separate team for every song.':'官方总分榜附带的一支公开队伍，不代表每首歌曲各自的队伍。';}
          });
        }
        rows.append(item);
      }
      empty.hidden = seen.size > 0;
      q('[data-rank-count]').textContent = seen.size ? (en ? `${seen.size} / ${data.totalEntries ?? seen.size} players` : `${seen.size} / ${data.totalEntries ?? seen.size} 名玩家`) : '';
      if (locateInput?.value.trim()) applyLocateHighlight({ scroll: false, cycle: false });
      cursor = data.nextCursor; next.hidden = supportsScroll || !cursor;
      const url = new URL(location.href); url.searchParams.set('server', server);
      if (data.board !== 'auto') url.searchParams.set('board', data.board);else url.searchParams.delete('board');
      for (const [key, value] of [['event', requestedEvent], ['music', data.board === 'music' ? requestedMusic : ''],['band',band.value]]) {
        value ? url.searchParams.set(key, value) : url.searchParams.delete(key);
      }
      history.replaceState(history.state, '', url);
    } catch (error) {
      if (request === generation && (error.name !== 'AbortError' || timedOut)) {
        lastData = null; failedAppend = append;autoPaused=true;retry.hidden = false;
        status.dataset.state = 'error';status.textContent = en ? 'Could not load rankings. Please try again.' : '榜单加载失败，请稍后重试。';
      }
    } finally {
      clearTimeout(timeout);
      if (request === generation) {
        loading=false;refresh.disabled = false; rows.setAttribute('aria-busy', 'false');
        loadNote.textContent=!autoPaused && seen.size ? (cursor ? (en?'Scroll for more players':'继续下滑加载更多玩家'):(en?'All captured players loaded':'已加载本次采集的全部玩家')):'';
        if(!autoPaused) requestAnimationFrame(maybeLoad);
      }
    }
  }
  const applyLocateHighlight = ({ scroll = false, cycle = false } = {}) => {
    const query = locateInput?.value.trim() || '';
    const mode = locateMode?.value || 'auto';
    const locateKey = `${mode}:${query}`;
    if (locateClear) locateClear.hidden = !query;
    const rowNodes = [...rows.querySelectorAll('.pr-row')];
    const entries = [];
    for (const rowNode of rowNodes) {
      delete rowNode.dataset.rankMatch;
      delete rowNode.dataset.rankFocus;
      if (!query) continue;
      entries.push({
        row: rowNode,
        rank: Number(rowNode.dataset.playerRank),
        playerId: rowNode.dataset.playerId || '',
        name: rowNode.dataset.playerName || ''
      });
    }
    if (!query) {
      lastLocateKey = '';
      locateCycleIndex = 0;
      if (locateCount) {
        locateCount.hidden = true;
        locateCount.textContent = '';
      }
      showStatus();
      return { matches: [], query: '', mode };
    }
    const matched = findBestRankingMatch(entries, query, mode);
    for (const item of matched) {
      item.entry.row.dataset.rankMatch = 'true';
    }
    if (matched.length) {
      if (cycle && locateKey === lastLocateKey) {
        locateCycleIndex = (locateCycleIndex + 1) % matched.length;
      } else if (locateKey !== lastLocateKey) {
        locateCycleIndex = 0;
        lastLocateKey = locateKey;
      }
      const target = matched[locateCycleIndex] || matched[0];
      target.entry.row.dataset.rankFocus = 'true';
      if (locateCount) {
        locateCount.hidden = false;
        locateCount.textContent = `${locateCycleIndex + 1}/${matched.length}`;
        delete locateCount.dataset.empty;
      }
      if (scroll) {
        if (typeof window !== 'undefined' && window.innerWidth <= 860 && commandBar?.dataset.filtersOpen === 'true') {
          setFiltersOpen(false);
        }
        target.entry.row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      const suffix = matched.length > 1 ? (en ? ` (${locateCycleIndex + 1}/${matched.length})` : `（${locateCycleIndex + 1}/${matched.length}）`) : '';
      status.textContent = en
        ? `Located #${target.entry.rank} · ${target.entry.name || target.entry.playerId}${suffix}`
        : `已定位：第 ${target.entry.rank} 名 · ${target.entry.name || target.entry.playerId}${suffix}`;
      status.dataset.state = 'available';
    } else if (locateCount) {
      locateCount.hidden = false;
      locateCount.textContent = '0';
      locateCount.dataset.empty = 'true';
    }
    return { matches: matched, query, mode };
  };
  locateMode?.addEventListener('change', () => {
    syncLocatePlaceholder();
    applyLocateHighlight({ scroll: Boolean(locateInput?.value.trim()), cycle: false });
    locateInput?.focus();
  });
  locateInput?.addEventListener('input', () => {
    applyLocateHighlight({ scroll: false, cycle: false });
  });
  locateClear?.addEventListener('click', () => {
    if (!locateInput) return;
    locateInput.value = '';
    applyLocateHighlight({ scroll: false, cycle: false });
    locateInput.focus();
  });
  locateForm?.addEventListener('submit', async event => {
    event.preventDefault();
    let { matches, query } = applyLocateHighlight({ scroll: true, cycle: true });
    if (!query) return;
    if (!matches.length && cursor) {
      let guard = 0;
      while (!matches.length && cursor && !autoPaused && guard++ < 25) {
        await load(true);
        ({ matches } = applyLocateHighlight({ scroll: true, cycle: false }));
      }
    }
    if (!matches.length) {
      status.textContent = en ? `No match in captured rankings for "${query}".` : `当前已采集榜单中未找到“${query}”。`;
      status.dataset.state = 'stale';
    }
  });
  const teaserHost = q('[data-rank-teaser]');
  const statsBaseHref = `/${context.region || 'global'}/${language}/rankings/stats/`;
  let teaserClient = null;
  let teaserIdleHandle = null;
  let teaserSeq = 0;
  const cancelPendingTeaser = () => {
    if (teaserIdleHandle == null) return;
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(teaserIdleHandle);
    else clearTimeout(teaserIdleHandle);
    teaserIdleHandle = null;
  };
  const syncTeaser = () => {
    if (!teaserHost || !server) return;
    cancelPendingTeaser();
    const mySeq = ++teaserSeq;
    const scope = {
      serverId: server,
      eventId: requestedEvent || lastData?.eventId || null,
      musicId: requestedMusic || lastData?.musicId || '',
    };
    const run = async () => {
      teaserIdleHandle = null;
      if (mySeq !== teaserSeq || !root.isConnected) return;
      if (!teaserClient) {
        const {createRankingTeaserClient} = await import('./ranking-teaser-ui.mjs');
        if (mySeq !== teaserSeq || !root.isConnected) return;
        teaserClient = createRankingTeaserClient({
          container: teaserHost,
          mode: 'activity',
          en,
          catalog: cardCatalog,
          statsBaseHref,
        });
      }
      teaserClient.select(scope);
    };
    if (typeof requestIdleCallback === 'function') {
      teaserIdleHandle = requestIdleCallback(() => { void run(); }, {timeout: 1200});
    } else {
      teaserIdleHandle = setTimeout(() => { void run(); }, 60);
    }
  };

  const resetBoard=()=>{requestedMusic='';if(![...board.options].some(option=>option.value==='auto')) board.append(new Option(en?'Available board':'已接入榜单','auto'));board.value='auto';pickers.get(board)?.update();};
  band.addEventListener('change',()=>{syncEvents();requestedEvent=rankingEventForBand(events,band.value,requestedEvent);syncEvents();resetBoard();load().then(syncTeaser);});
  event.addEventListener('change', () => { requestedEvent = event.value;resetBoard();load().then(syncTeaser); });
  board.addEventListener('change', () => { requestedMusic = ''; load().then(syncTeaser); });
  song.addEventListener('change', () => { requestedMusic = song.value; load().then(syncTeaser); });
  next.addEventListener('click', () => load(true)); retry.addEventListener('click', () => load(failedAppend));
  refresh.addEventListener('click', () => { load().then(syncTeaser); });
  const tick=()=>{if(root.isConnected){syncEvents();showHeading();showStatus();}else clearInterval(timer);};
  let timer = setInterval(tick,30000);
  window.addEventListener('pagehide', () => { pending?.abort();cancelPendingTeaser();clearInterval(timer);observer?.disconnect(); });
  window.addEventListener('pageshow', event => { if (event.persisted && root.isConnected) {loading=false;clearInterval(timer);timer=setInterval(tick,30000);observer?.observe(sentinel);tick();} });
  if (!server) refresh.disabled = true;
  load().then(syncTeaser);
}

if (typeof document !== 'undefined') document.querySelectorAll('[data-player-rankings]').forEach(installPlayerRankings);
