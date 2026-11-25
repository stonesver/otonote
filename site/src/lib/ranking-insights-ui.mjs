/**
 * Shared Ranking Insights UI controller for /rankings/stats/.
 * Renders focused 5-tab interactive views using uniform card ratios and OtoNote theme tokens.
 */
export { createRankingTeaserClient } from './ranking-teaser-ui.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n ?? 0).toLocaleString('en-US');
const pct = (a, n) => (n ? (100 * a / n).toFixed(1).replace(/\.0$/, '') + '%' : '0%');
const CARD_DIMS = { m44: [44, 44], m64: [64, 64], s80: [80, 45], s112: [112, 63] };
const INSIGHTS_CACHE_TTL_MS = 120_000;
const INSIGHTS_CACHE_MAX = 24;
const SWAP_SVG = '<svg class="ri-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7h12m-3-3 3 3-3 3M16 13H4m3-3-3 3 3 3"/></svg>';
const ICONS = {
  overview: '<svg class="ri-ico" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/></svg>',
  pairs: '<svg class="ri-ico" viewBox="0 0 20 20" aria-hidden="true"><circle cx="6.5" cy="7" r="2.8"/><circle cx="13.5" cy="7" r="2.8"/><path d="M2.5 16c.5-2.6 2.3-4 4-4s3.5 1.4 4 4M10.5 16c.4-2 1.8-3.3 3-3.3 1.7 0 3.5 1.4 4 3.3"/></svg>',
  tiers: '<svg class="ri-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16v-5m6 5V7m6 9V4"/></svg>',
  explorer: '<svg class="ri-ico" viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="m13.5 13.5 3.5 3.5"/></svg>',
  closing: '<svg class="ri-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 15 8 10l3.5 3L17 5.5M13.5 5.5H17V9"/></svg>',
  crown: '<svg class="ri-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 14.5h14l-1-8-3.5 3L10 5l-2.5 4.5-3.5-3-1 8Z"/></svg>',
  top: '<svg class="ri-ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4"/></svg>',
};
const TIER_COLORS = ['#556673', '#9a5129', '#536a87', '#94660e', '#6a46a2', '#347774', '#a33b6c'];

/** Lazily decode compact v2 card catalog entries (or pass through v1 objects). */
export function createCardCatalogAccessor(catalog = {}, serverId = '') {
  const cache = { member: new Map(), support: new Map() };
  const isV2 = catalog?.v === 2;
  const imgBase = catalog?.imgBase || '';
  const hrefBase = catalog?.hrefBase || '';
  const region = hrefBase.match(/^\/(global|jp)\//)?.[1] || '';
  const serverSuffix = serverId && ((region === 'jp' && serverId === 'jp') || (region === 'global' && serverId.startsWith('global-')))
    ? `?server=${encodeURIComponent(serverId)}`
    : '';

  const getRarityEntry = rarity => {
    if (rarity == null) return null;
    const entry = catalog?.rarities?.[String(rarity)];
    if (!entry) return null;
    return Array.isArray(entry) ? { label: entry[0] || '', image: entry[1] || null } : entry;
  };
  const getAttrImg = code => {
    if (code == null) return null;
    const entry = catalog?.attributes?.[String(code)];
    if (!entry) return null;
    return typeof entry === 'string' ? (entry || null) : (entry.image || null);
  };
  const getRarityImg = rarity => getRarityEntry(rarity)?.image || null;

  const getCard = (kind, id) => {
    const sid = String(id);
    const bucket = cache[kind];
    if (bucket?.has(sid)) return bucket.get(sid);
    const raw = (catalog?.[kind] || {})[sid];
    let card;
    if (!raw) {
      card = { name: `#${sid}`, image: null, href: null, rarity: null, rarityLabel: '', attr: null, bandIds: [] };
    } else if (isV2 && Array.isArray(raw)) {
      const [name, imgRel, slug, rarity, attr, bandIds] = raw;
      const image = !imgRel ? null : (imgRel.startsWith('/') || imgRel.startsWith('http') ? imgRel : `${imgBase}${imgRel}`);
      const cardSlug = slug || `${kind}-card-${sid}`;
      const href = hrefBase ? `${hrefBase}${kind === 'member' ? 'members' : 'supports'}/${cardSlug}/${serverSuffix}` : null;
      card = {
        name: name || `#${sid}`,
        image,
        href,
        rarity,
        rarityLabel: getRarityEntry(rarity)?.label || '',
        attr,
        bandIds: bandIds || [],
      };
    } else {
      card = raw;
    }
    bucket?.set(sid, card);
    return card;
  };

  return { getCard, getAttrImg, getRarityImg };
}

export function createRankingInsightsClient({ container, mode, en = false, catalog = {}, bands = [], songs = {}, initialTab = 'overview', serverId = '', fetcher = fetch }) {
  const t = (zh, eng) => (en ? eng : zh);
  const responseCache = new Map();
  const state = {
    scope: null,
    data: null,
    loading: false,
    error: null,
    tab: initialTab || 'overview',
    cmpA: 0,
    cmpB: 1,
    member: null,
    pairMode: 'member',
    matrixCell: null,
    diffKind: 'member',
    diffSort: 'abs',
    expKind: 'member',
    expQuery: '',
    expBand: '',
    expLimit: 16,
    expSelected: null,
    chartHidden: {},
    chartHoverIdx: null,
    onSelectSong: null,
  };
  let controller = null;
  let seq = 0;

  const { getCard, getAttrImg, getRarityImg } = createCardCatalogAccessor(catalog, serverId);
  const bandMap = new Map(bands.map(b => [String(b.id), b]));
  const songMap = Array.isArray(songs)
    ? new Map(songs.map(s => [String(s.id), s.name]))
    : new Map(Object.entries(songs || {}));
  const getBand = id => bandMap.get(String(id)) || { id: String(id), name: `#${id}`, image: null };
  const getSong = id => ({ id: String(id), name: songMap.get(String(id)) || `#${id}` });

  const cardThumb = (kind, id, size) => {
    const c = getCard(kind, id);
    const sz = size || (kind === 'support' ? 's112' : 'm64');
    const [w, h] = CARD_DIMS[sz] || [64, 64];
    const showBadges = sz !== 'm44';
    const attrImg = showBadges ? getAttrImg(c.attr) : null;
    const rarImg = showBadges ? getRarityImg(c.rarity) : null;
    const tag = c.href ? 'a' : 'span';
    const hrefAttr = c.href ? ` href="${esc(c.href)}"` : '';
    return `<${tag} class="ri-card ri-card--${sz}"${hrefAttr} title="${esc(c.name)}">
      <span class="ri-frame">
        ${c.image ? `<img class="ri-art" src="${esc(c.image)}" alt="${esc(c.name)}" width="${w}" height="${h}" loading="lazy" decoding="async">` : ''}
        ${attrImg ? `<img class="ri-attr" src="${esc(attrImg)}" alt="" width="16" height="16" loading="lazy" decoding="async">` : ''}
        ${rarImg ? `<img class="ri-rarity" src="${esc(rarImg)}" alt="" height="15" loading="lazy" decoding="async">` : ''}
      </span>
    </${tag}>`;
  };

  function findRaritySpot(stats) {
    const hr = stats?.headCardRanks;
    if (!hr) return null;
    let best = null;
    for (const kind of ['member', 'support']) {
      for (const [id, ranks] of Object.entries(hr[kind] || {})) {
        const c = getCard(kind, id);
        if (!['R', 'SR'].includes(c.rarityLabel)) continue;
        const candidate = { kind, id: Number(id), ranks, count: ranks.length, headEnd: stats.headEnd || 100 };
        if (!best || candidate.ranks[0] < best.ranks[0] || (candidate.ranks[0] === best.ranks[0] && candidate.count > best.count)) {
          best = candidate;
        }
      }
    }
    return best;
  }

  function renderHeadlines(d) {
    const st = d.stats;
    const top1 = st.members.top[0];
    const top3 = st.members.top.slice(0, 3).reduce((a, x) => a + x.count, 0);

    let h2Sub, h2Title, h2Num, h2Thumb = '';
    if (mode === 'arena') {
      const sp = findRaritySpot(st);
      const spCard = sp ? getCard(sp.kind, sp.id) : null;
      h2Sub = t('低稀有度亮点', 'Low-rarity');
      h2Title = spCard ? `${spCard.name} (${spCard.rarityLabel})` : t('前100无 R/SR', 'No R/SR');
      h2Num = sp ? `#${sp.ranks[0]}` : '—';
      if (spCard?.image) {
        const isSup = sp.kind === 'support';
        h2Thumb = `<img class="ri-pulse-thumb ${isSup ? 'is-support' : ''}" src="${esc(spCard.image)}" alt="" width="${isSup ? 52 : 34}" height="${isSup ? 30 : 34}" loading="lazy" decoding="async">`;
      }
    } else {
      const songCount = d.songs?.length || 0;
      const all = d.sameTeamSongsHistogram?.[String(songCount)] || 0;
      h2Sub = t('一队多曲', 'Multi-song');
      h2Title = t(`同队打满 ${songCount} 曲`, `1 team × ${songCount} songs`);
      h2Num = `${all}${t('人', '')}`;
    }

    let h3Sub, h3Title, h3Num, h3Tab, h3Thumb = '';
    if (mode === 'arena') {
      const totalPop = d.population?.totalEstimate;
      h3Sub = t('估算总人数', 'Est. players');
      h3Title = totalPop ? t('联动段位分布', 'Tier population') : t('跨队互借矩阵', 'Cross-band');
      h3Num = totalPop ? fmt(totalPop) : fmt(d.coverage?.maxRank || st.n);
      h3Tab = totalPop ? 'closing' : 'pairs';
    } else {
      const hist = (d.closingHistory || []).find(x => String(x.music) === String(d.musicId));
      const c100 = hist?.changes?.find(z => z.rank === 100);
      h3Sub = t('最后24h百名线', '24h Top-100');
      h3Title = c100 ? `+${fmt(c100.increase)} ${t('分', 'pts')}` : t('查看涨分曲线', 'Closing curves');
      h3Num = c100 ? `+${c100.pct.toFixed(2)}%` : '—';
      h3Tab = 'closing';
    }

    return `<div class="ri-pulse-bar">
      <button type="button" class="ri-pulse-item" data-ri-tab="overview" title="${t(`前 3 套覆盖 ${pct(top3, st.n)} · 共 ${st.members.unique} 种`, `Top 3 cover ${pct(top3, st.n)}`)}">
        <div class="ri-pulse-text"><small>${t('Top 1 阵容', 'Top 1')}</small><strong>${st.members.unique} ${t('种组合', 'combos')}</strong></div>
        <span class="ri-pulse-val">${top1 ? pct(top1.count, st.n) : '—'}</span>
      </button>
      <button type="button" class="ri-pulse-item" data-ri-tab="overview">
        ${h2Thumb}
        <div class="ri-pulse-text"><small>${h2Sub}</small><strong>${esc(h2Title)}</strong></div>
        <span class="ri-pulse-val">${esc(h2Num)}</span>
      </button>
      <button type="button" class="ri-pulse-item" data-ri-tab="${h3Tab}">
        ${h3Thumb}
        <div class="ri-pulse-text"><small>${h3Sub}</small><strong>${esc(h3Title)}</strong></div>
        <span class="ri-pulse-val">${esc(h3Num)}</span>
      </button>
    </div>`;
  }

  function renderOverview(d) {
    const st = d.stats;
    const topList = st.members.top.slice(0, 5);
    let spotHtml = '';

    if (mode === 'arena') {
      const sp = findRaritySpot(st);
      if (sp) {
        const c = getCard(sp.kind, sp.id);
        spotHtml = `<section class="ui-sheet ri-panel">
          <header class="ri-panel-head">
            <div><h3>${t('低稀有度上榜亮点', 'Low-rarity spotlight')} <span class="ui-tag ui-tag--warning">${esc(c.rarityLabel)}</span></h3><p>${t(`前 ${sp.headEnd} 名共 ${sp.count} 队携带`, `${sp.count} teams in top ${sp.headEnd}`)}</p></div>
            <span class="ui-tag ui-tag--accent ri-tnum">${t(`最高第 ${sp.ranks[0]} 名`, `Best #${sp.ranks[0]}`)}</span>
          </header>
          <div class="ri-spotlight">
            ${cardThumb(sp.kind, sp.id, sp.kind === 'support' ? 's112' : 'm64')}
            <div class="ri-spotlight-info">
              <h4>${esc(c.name)}</h4>
              <div class="ri-rank-pills">${sp.ranks.slice(0, 10).map(r => `<span class="ri-rank-pill">#<b>${r}</b></span>`).join('')}</div>
            </div>
          </div>
        </section>`;
      }
    } else if (d.crossSong) {
      const cs = d.crossSong;
      const nMulti = cs.multiSongPlayers || 0;
      const cats = [
        ['samePairing', t('没换队', 'Same team'), 'var(--theme-chart-2)'],
        ['sameCardsChangedPairing', t('调换留影', 'Swapped pairs'), 'var(--theme-chart-4)'],
        ['sameMembersChangedSupports', t('换了留影', 'Changed supports'), 'var(--theme-chart-3)'],
        ['changedMembers', t('换了成员', 'Changed members'), 'var(--theme-chart-1)'],
      ];
      spotHtml = `<section class="ui-sheet ri-panel">
        <header class="ri-panel-head">
          <div><h3>${t('一队多曲复用', 'Multi-song team reuse')}</h3><p>${t(`多曲上榜 ${nMulti} 人 · 完整队玩家 ${cs.uniquePlayersWithCompleteDecks} 人`, `${nMulti} multi-song players out of ${cs.uniquePlayersWithCompleteDecks}`)}</p></div>
        </header>
        ${d.repeatExample ? `<div class="ri-five-grid">${d.repeatExample.pairs.map(([m, s]) => `<div class="ri-five-item">${cardThumb('member', m, 'm64')}${cardThumb('support', s, 's112')}</div>`).join('')}</div>` : ''}
        <div class="ri-conc-bar">${cats.map(([k, l, col]) => (cs.categories[k] ? `<span style="width:${nMulti ? 100 * cs.categories[k] / nMulti : 0}%;background:${col}" title="${l}: ${cs.categories[k]}"></span>` : '')).join('')}</div>
        <div class="ri-legend">${cats.map(([k, l, col]) => `<span><i class="ri-dot" style="background:${col}"></i>${l} <strong>${cs.categories[k] || 0}</strong></span>`).join('')}</div>
      </section>`;
    }

    const idxA = Math.min(state.cmpA, Math.max(0, topList.length - 1));
    let idxB = Math.min(state.cmpB, Math.max(0, topList.length - 1));
    if (idxA === idxB && topList.length > 1) idxB = idxA === 0 ? 1 : 0;
    const teamA = topList[idxA], teamB = topList[idxB];
    const colors = ['var(--theme-chart-1)', 'var(--theme-chart-2)', 'var(--theme-chart-3)', 'var(--theme-surface-deep)'];
    const top3Counts = topList.slice(0, 3).map(x => x.count);
    const restCount = Math.max(0, st.n - top3Counts.reduce((a, b) => a + b, 0));

    let cmpHtml = '';
    if (teamA && teamB) {
      const shared = teamA.key.filter(id => teamB.key.includes(id));
      const onlyA = teamA.key.filter(id => !teamB.key.includes(id));
      const onlyB = teamB.key.filter(id => !teamA.key.includes(id));
      cmpHtml = `
        <div class="ri-cmp-pickers">
          <div class="ri-cmp-col"><label>${t('阵容 A', 'Team A')}</label><select class="ui-select" data-ri-cmp="a">${topList.map((x, i) => `<option value="${i}" ${i === idxA ? 'selected' : ''}>Top ${i + 1} (${x.count} · ${pct(x.count, st.n)})</option>`).join('')}</select></div>
          <span aria-hidden="true">${SWAP_SVG}</span>
          <div class="ri-cmp-col"><label>${t('阵容 B', 'Team B')}</label><select class="ui-select" data-ri-cmp="b">${topList.map((x, i) => `<option value="${i}" ${i === idxB ? 'selected' : ''}>Top ${i + 1} (${x.count} · ${pct(x.count, st.n)})</option>`).join('')}</select></div>
        </div>
        <div class="ri-cmp-board">
          <div class="ri-shared-bar" aria-label="${t(`相同 ${shared.length} 张`, `${shared.length} shared`)}">
            ${shared.map(id => cardThumb('member', id, 'm44')).join('')}
          </div>
          <div class="ri-diff-list">
            ${onlyA.map((id, i) => {
              const rid = onlyB[i];
              return `<div class="ri-diff-row">
                <div class="ri-diff-cell is-a">${cardThumb('member', id, 'm64')}</div>
                <span style="display:grid;place-items:center" aria-hidden="true">${SWAP_SVG}</span>
                <div class="ri-diff-cell is-b">${cardThumb('member', rid, 'm64')}</div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
    }

    const compSection = `<section class="ui-sheet ri-panel">
      <header class="ri-panel-head">
        <div><h3>${t('阵容集中度与对比器', 'Team Concentration & Diff')}</h3><p>${fmt(st.n)} ${t('支完整队', 'complete teams')} · ${st.members.unique} ${t('种成员组合', 'member combos')}</p></div>
      </header>
      <div class="ri-conc-bar">
        ${top3Counts.map((cnt, i) => `<span style="width:${100 * cnt / st.n}%;background:${colors[i]}"></span>`).join('')}
        <span style="width:${100 * restCount / st.n}%;background:${colors[3]}"></span>
      </div>
      <div class="ri-legend">
        ${top3Counts.map((cnt, i) => `<span><i class="ri-dot" style="background:${colors[i]}"></i>Top ${i + 1}: <strong>${pct(cnt, st.n)}</strong></span>`).join('')}
        <span><i class="ri-dot" style="background:var(--theme-border)"></i>${t('其他', 'Other')}: <strong>${pct(restCount, st.n)}</strong></span>
      </div>
      ${cmpHtml}
    </section>`;
    return spotHtml ? `<div class="ri-split">${compSection}${spotHtml}</div>` : compSection;
  }

  function renderPairs(d) {
    const st = d.stats;
    const canMatrix = mode === 'arena' && Array.isArray(d.crossBand) && d.crossBand.length > 0 && bands.length >= 2;
    const pmode = canMatrix ? state.pairMode : 'member';

    if (pmode === 'matrix') {
      const matrix = {};
      for (const r of bands) {
        matrix[r.id] = {};
        for (const c of bands) matrix[r.id][c.id] = { total: 0, items: [] };
      }
      let maxVal = 1;
      for (const row of d.crossBand) {
        const sc = getCard('support', row.support);
        const ownIds = (sc.bandIds || []).map(String);
        for (const ownId of ownIds) {
          if (!matrix[ownId]) continue;
          for (const target of row.boards) {
            if (ownIds.includes(String(target.band)) || !matrix[ownId][String(target.band)]) continue;
            if (target.count > 0) {
              matrix[ownId][String(target.band)].total += target.count;
              matrix[ownId][String(target.band)].items.push({ support: row.support, count: target.count, pct: target.pct });
              if (matrix[ownId][String(target.band)].total > maxVal) maxVal = matrix[ownId][String(target.band)].total;
            }
          }
        }
      }
      if (!state.matrixCell) {
        let best = null, bv = -1;
        for (const r of bands) for (const c of bands) {
          if (r.id !== c.id && matrix[r.id][c.id].total > bv) { bv = matrix[r.id][c.id].total; best = `${r.id}:${c.id}`; }
        }
        state.matrixCell = best || `${bands[0].id}:${bands[1].id}`;
      }
      const [src, dst] = state.matrixCell.split(':');
      const items = (matrix[src]?.[dst]?.items || []).sort((a, b) => b.count - a.count);

      return `<section class="ui-sheet ri-panel">
        <header class="ri-panel-head">
          <div><h3>${t('5×5 跨乐队留影热力矩阵', '5×5 Cross-band Support Matrix')}</h3><p>${t('点击任意跨队格子筛选对应打工留影', 'Click any cross-band cell to inspect supports')}</p></div>
          <div class="ui-segmented">
            <button type="button" data-ri-pair-mode="member">${t('成员 × 留影', 'Pairings')}</button>
            <button type="button" data-ri-pair-mode="matrix" class="active">${t('跨队矩阵', 'Matrix')}</button>
          </div>
        </header>
        <div class="ri-split">
          <div class="ri-matrix-wrap">
            <table class="ri-matrix">
              <thead><tr><th>${t('所属 \\ 出场', 'Own \\ Used')}</th>${bands.map(col => `<th title="${esc(col.name)}">${col.image ? `<img src="${esc(col.image)}" alt="${esc(col.name)}" height="20" loading="lazy" decoding="async">` : esc(col.name)}</th>`).join('')}</tr></thead>
              <tbody>${bands.map(row => `<tr>
                <td class="ri-m-row" title="${esc(row.name)}">${row.image ? `<img src="${esc(row.image)}" alt="${esc(row.name)}" height="20" loading="lazy" decoding="async">` : esc(row.name)}</td>
                ${bands.map(col => {
                  if (row.id === col.id) return `<td><button type="button" class="ri-matrix-cell is-self" disabled>${t('本队', 'Own')}</button></td>`;
                  const cell = matrix[row.id][col.id];
                  const bg = cell.total ? `color-mix(in srgb, var(--theme-accent) ${Math.round(8 + (cell.total / maxVal) * 38)}%, var(--theme-surface))` : 'var(--theme-surface-tint)';
                  const key = `${row.id}:${col.id}`;
                  return `<td><button type="button" class="ri-matrix-cell ${state.matrixCell === key ? 'is-selected' : ''}" data-ri-cell="${key}" style="background:${bg}">${fmt(cell.total)}</button></td>`;
                }).join('')}
              </tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="ui-subsheet" style="padding:12px;display:grid;gap:8px">
            <strong style="font-size:13px">${esc(getBand(src).name)} → ${esc(getBand(dst).name)} (${items.length})</strong>
            ${items.slice(0, 6).map((it, i) => `<div class="ri-pair-card ${i === 0 ? 'is-best' : ''}">
              ${cardThumb('support', it.support, 's112')}
              <div class="ri-pair-body">
                <div class="ri-pair-top"><strong>${esc(getCard('support', it.support).name)}</strong><b>${it.count} ${t('队', '')}</b></div>
                <div class="ri-meter"><span style="width:${Math.min(100, it.pct)}%"></span></div>
                <span style="font-size:12px;color:var(--theme-muted)">${it.pct.toFixed(1)}%</span>
              </div>
            </div>`).join('') || `<p style="font-size:12px;color:var(--theme-muted)">${t('暂无记录', 'No cross-band records')}</p>`}
          </div>
        </div>
      </section>`;
    }

    const usage = st.memberUsage || [];
    if (!usage.some(x => x.key === state.member)) state.member = usage[0]?.key ?? null;
    const mid = state.member;
    const cur = usage.find(x => x.key === mid);
    const pairs = (st.pairUsage || []).filter(p => p.key[0] === mid).sort((a, b) => b.count - a.count);

    return `<section class="ui-sheet ri-panel">
      <header class="ri-panel-head">
        <h3>${t('成员 × 留影', 'Pairings')}</h3>
        ${canMatrix ? `<div class="ui-segmented">
          <button type="button" data-ri-pair-mode="member" class="active" aria-pressed="true">${t('搭配', 'Pairs')}</button>
          <button type="button" data-ri-pair-mode="matrix" aria-pressed="false">${t('跨队矩阵', 'Matrix')}</button>
        </div>` : ''}
      </header>
      <div class="ri-member-rail">
        ${usage.slice(0, 14).map(u => {
          const mc = getCard('member', u.key);
          return `<button type="button" class="ri-member-chip ${u.key === mid ? 'active' : ''}" data-ri-member="${u.key}" title="${esc(mc.name)}">
            ${mc.image ? `<img src="${esc(mc.image)}" alt="${esc(mc.name)}" width="28" height="28" loading="lazy" decoding="async">` : ''}
            <span class="ri-tnum">${pct(u.count, st.n)}</span>
          </button>`;
        }).join('')}
      </div>
      <div class="ri-pair-grid-3">
        ${cur ? pairs.slice(0, 6).map((p, i) => `<div class="ri-pair-card ${i === 0 ? 'is-best' : ''}">
          ${cardThumb('support', p.key[1], 's80')}
          <div class="ri-pair-body">
            <div class="ri-pair-top"><strong title="${esc(getCard('support', p.key[1]).name)}">${esc(getCard('support', p.key[1]).name)}</strong><b>${pct(p.count, cur.count)}</b></div>
            <div class="ri-meter"><span style="width:${100 * p.count / cur.count}%"></span></div>
          </div>
        </div>`).join('') : ''}
      </div>
    </section>`;
  }

  function renderTiers(d) {
    const tiers = d.tiers || [];
    const st = d.stats;
    const kind = state.diffKind;
    const key = kind === 'member' ? 'memberUsage' : 'supportUsage';
    let rows = [];
    if (tiers.length >= 2) {
      const ids = [...new Set(tiers.flatMap(ti => ti.stats[key].map(x => x.key)))];
      rows = ids.map(id => {
        const head = (tiers[0].stats[key].find(x => x.key === id)?.count || 0) / tiers[0].stats.n * 100;
        const mid = (tiers.at(-1).stats[key].find(x => x.key === id)?.count || 0) / tiers.at(-1).stats.n * 100;
        return { id, head, mid, diff: head - mid };
      });
      if (state.diffSort === 'abs') rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      else if (state.diffSort === 'head') rows.sort((a, b) => b.head - a.head);
      else rows.sort((a, b) => b.mid - a.mid);
    }

    const headRows = rows.filter(r => r.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 5);
    const midRows = rows.filter(r => r.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 5);
    const headShort = tiers.length >= 2 ? t(`前${tiers[0].ranks[1]}`, `Top ${tiers[0].ranks[1]}`) : '';
    const midShort = tiers.length >= 2 ? `${tiers.at(-1).ranks[0]}-${tiers.at(-1).ranks[1]}` : '';

    const donutSvg = (val, col) => {
      const r = 21, circ = 2 * Math.PI * r, off = circ * (1 - Math.min(100, Math.max(0, val)) / 100);
      return `<svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true">
        <circle cx="27" cy="27" r="${r}" fill="none" stroke="var(--theme-surface-deep)" stroke-width="5"/>
        <circle cx="27" cy="27" r="${r}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 27 27)"/>
        <text x="27" y="31" text-anchor="middle" font-size="12" font-weight="700" fill="var(--theme-text)">${val.toFixed(0)}%</text>
      </svg>`;
    };

    const renderDiffCol = (title, tagCls, list) => `<div class="ri-diff-col">
      <div class="ri-diff-col-title"><span>${title}</span></div>
      ${list.map(r => `<div class="ri-compare-item">
        ${cardThumb(kind, r.id, kind === 'support' ? 's80' : 'm44')}
        <div class="ri-compare-body">
          <div class="ri-compare-top">
            <strong title="${esc(getCard(kind, r.id).name)}">${esc(getCard(kind, r.id).name)}</strong>
            <span class="ui-tag ${r.diff >= 0 ? 'ui-tag--accent' : 'ui-tag--secondary'} ri-tnum">${r.diff >= 0 ? '+' : ''}${r.diff.toFixed(1)}%</span>
          </div>
          <div class="ri-diff-pair">
            <i class="ri-dot" style="background:var(--theme-accent)"></i><b>${r.head.toFixed(0)}%</b>
            <span>→</span>
            <i class="ri-dot" style="background:var(--theme-secondary-ink)"></i><b>${r.mid.toFixed(0)}%</b>
          </div>
        </div>
      </div>`).join('') || `<p style="font-size:12px;color:var(--theme-muted)">—</p>`}
    </div>`;

    const ps = st.powerStats;
    const order0 = st.orderPreference?.['0'] || [];
    const order4 = st.orderPreference?.['4'] || [];

    return `<div style="display:grid;gap:10px">
      <section class="ui-sheet ri-panel">
        <header class="ri-panel-head">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <h3>${t('名次差异', 'Tier Diff')}</h3>
            <div class="ri-legend"><span><i class="ri-dot" style="background:var(--theme-accent)"></i>${headShort}</span><span><i class="ri-dot" style="background:var(--theme-secondary-ink)"></i>${midShort}</span></div>
          </div>
          <div class="ui-segmented">
            <button type="button" data-ri-diff="member" class="${kind === 'member' ? 'active' : ''}" aria-pressed="${kind === 'member'}">${t('成员', 'Member')}</button>
            <button type="button" data-ri-diff="support" class="${kind === 'support' ? 'active' : ''}" aria-pressed="${kind === 'support'}">${t('留影', 'Support')}</button>
          </div>
        </header>
        <div class="ri-diff-grid">
          ${renderDiffCol(t(`${headShort} 更常用`, `${headShort} Preferred`), 'ui-tag--accent', headRows)}
          ${renderDiffCol(t(`${midShort} 更常用`, `${midShort} Preferred`), 'ui-tag--secondary', midRows)}
        </div>
      </section>

      <div class="ri-diff-grid">
        <section class="ui-sheet ri-panel">
          <header class="ri-panel-head"><h3>${t('满破断层', 'Max-rank Gap')}</h3></header>
          ${[['memberRank', t('成员觉醒 5', 'Member R5')], ['supportRank', t('留影突破 5', 'Support R5')]].map(([gk, label]) => `
            <div style="display:grid;gap:6px">
              <strong style="font-size:12px;color:var(--theme-muted)">${label}</strong>
              <div class="ri-ring-row">
                ${tiers.map((ti, idx) => {
                  const rate = 100 * (ti.stats.growth[gk]?.['5'] || 0) / (ti.stats.n * 5);
                  return `<div class="ri-ring-card">${donutSvg(rate, idx === 0 ? 'var(--theme-accent)' : 'var(--theme-secondary-ink)')}<small>${ti.ranks[0]}–${ti.ranks[1]}</small></div>`;
                }).join('')}
              </div>
            </div>`).join('')}
        </section>

        ${ps ? `<section class="ui-sheet ri-panel">
          <header class="ri-panel-head"><h3>${t('综合力门槛', 'Power Thresholds')}</h3></header>
          <div class="ri-metric-grid">
            <div class="ri-metric-box"><small>${t('中位', 'Median')}</small><strong>${fmt(ps.median)}</strong></div>
            <div class="ri-metric-box"><small>P90</small><strong>${fmt(ps.p90)}</strong></div>
            <div class="ri-metric-box"><small>${t('最低', 'Min')}</small><strong>${fmt(ps.min)}</strong></div>
            <div class="ri-metric-box"><small>${t('最高', 'Max')}</small><strong>${fmt(ps.max)}</strong></div>
          </div>
          ${ps.lowestHeadTeam ? `<div class="ri-spotlight" style="padding:8px 10px">
            <div class="ri-spotlight-info"><h4>#${ps.lowestHeadTeam.rank} · ${fmt(ps.lowestHeadTeam.totalPower)}</h4></div>
            <div style="display:flex;gap:4px;flex-wrap:wrap">${ps.lowestHeadTeam.pairs.map(([m]) => cardThumb('member', m, 'm44')).join('')}</div>
          </div>` : ''}
        </section>` : ''}
      </div>
    </div>`;
  }

  function buildExplorerParts(d) {
    const kind = state.expKind;
    const usageKey = kind === 'member' ? 'memberUsage' : 'supportUsage';
    const boardsMap = mode === 'arena' ? (d.allBandsUsage || {}) : (d.allSongsUsage || {});
    const seenTotals = new Map();
    for (const bval of Object.values(boardsMap)) {
      for (const x of (bval[usageKey] || [])) seenTotals.set(x.key, (seenTotals.get(x.key) || 0) + x.count);
    }
    const q = state.expQuery.trim().toLowerCase();
    const cardsList = [...seenTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, total]) => ({ id, total, ...getCard(kind, id) }))
      .filter(c => !q || String(c.name).toLowerCase().includes(q));
    const shownCards = q ? cardsList.slice(0, 24) : cardsList.slice(0, state.expLimit);
    if (!cardsList.some(c => c.id === state.expSelected)) state.expSelected = cardsList[0]?.id ?? null;

    let reportHtml = `<p style="font-size:13px;color:var(--theme-muted)">${t('暂无匹配卡片', 'No matching cards')}</p>`;
    if (state.expSelected != null) {
      const cid = state.expSelected;
      const card = getCard(kind, cid);
      const hits = Object.entries(boardsMap).map(([bid, bval]) => {
        const hit = (bval[usageKey] || []).find(x => x.key === cid);
        const label = mode === 'arena' ? getBand(bid).name : (bval.name || getSong(bid).name);
        return { bid, label, count: hit ? hit.count : 0, n: bval.n, pct: hit && bval.n ? 100 * hit.count / bval.n : 0 };
      }).sort((a, b) => b.pct - a.pct);

      /* For member cards in Arena, show tier usage inside their own band (members cannot cross bands) */
      let primaryBarsHtml = '';
      if (mode === 'arena' && kind === 'member') {
        const ownTierRows = (d.tiers || []).map(ti => {
          const hit = (ti.stats.memberUsage || []).find(x => x.key === cid);
          const p = hit && ti.stats.n ? 100 * hit.count / ti.stats.n : 0;
          return { label: `${ti.ranks[0]}–${ti.ranks[1]}`, count: hit ? hit.count : 0, pct: p };
        });
        const ownHit = hits.find(h => h.count > 0);
        primaryBarsHtml = `<div style="display:grid;gap:6px">
          <strong style="font-size:13px">${ownHit ? `${esc(ownHit.label)} · ${ownHit.count}${t('队', '')} (${ownHit.pct.toFixed(1)}%)` : t('本乐队分段出场率', 'Usage by tier')}</strong>
          ${ownTierRows.map(h => `<div class="ri-bar-row"><span>${esc(h.label)}</span><div class="ri-meter"><span style="width:${h.pct}%"></span></div><strong>${h.pct.toFixed(1)}%</strong></div>`).join('')}
        </div>`;
      } else {
        primaryBarsHtml = `<div style="display:grid;gap:6px">
          <strong style="font-size:13px">${mode === 'arena' ? t('5 乐队榜出场率', 'Usage across 5 Arena bands') : t('本期各曲出场率', 'Usage across event songs')}</strong>
          ${hits.map(h => `<div class="ri-bar-row" style="grid-template-columns:120px minmax(0,1fr) 88px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.label)}</span><div class="ri-meter"><span style="width:${h.pct}%"></span></div><strong>${h.count} · ${h.pct.toFixed(1)}%</strong></div>`).join('')}
        </div>`;
      }

      reportHtml = `
        <div class="ri-spotlight" style="padding:10px 12px">
          ${cardThumb(kind, cid, kind === 'support' ? 's112' : 'm64')}
          <div class="ri-spotlight-info"><h4>${esc(card.name)}</h4></div>
          ${card.href ? `<a class="ui-btn-soft" href="${esc(card.href)}">${t('卡面详情', 'Details')}</a>` : ''}
        </div>
        ${primaryBarsHtml}`;
    }

    const listHtml = `<div class="ri-exp-grid ${kind === 'support' ? 'is-support' : ''}">
      ${shownCards.map(c => `<button type="button" class="ri-exp-tile ${c.id === state.expSelected ? 'active' : ''}" data-ri-exp-pick="${c.id}" title="${esc(c.name)}">
        ${cardThumb(kind, c.id, kind === 'support' ? 's80' : 'm64').replace(/<a /g, '<span ').replace(/<\/a>/g, '</span>')}
      </button>`).join('')}
    </div>
    ${!q && cardsList.length > shownCards.length ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:4px"><span style="font-size:12px;color:var(--theme-muted)">${t(`按热门排序，当前显示 ${shownCards.length} / ${cardsList.length} 张`, `Showing top ${shownCards.length} of ${cardsList.length}`)}</span><button type="button" class="ui-btn-outline" data-ri-exp-more>${t('加载更多', 'Load more')}</button></div>` : ''}`;

    return { listHtml, reportHtml };
  }

  function renderExplorer(d) {
    const kind = state.expKind;
    const { listHtml, reportHtml } = buildExplorerParts(d);
    return `<div class="ri-split">
      <section class="ui-sheet ri-panel">
        <header class="ri-panel-head">
          <div><h3>${t('单卡全榜反查', 'Card Reverse Lookup')}</h3></div>
          <div class="ui-segmented">
            <button type="button" data-ri-exp-kind="member" class="${kind === 'member' ? 'active' : ''}">${t('成员', 'Member')}</button>
            <button type="button" data-ri-exp-kind="support" class="${kind === 'support' ? 'active' : ''}">${t('留影', 'Support')}</button>
          </div>
        </header>
        <div class="ri-exp-controls">
          <input type="search" class="ui-input" data-ri-exp-q value="${esc(state.expQuery)}" placeholder="${t('搜索卡名…', 'Search card…')}" style="flex:1;min-width:160px">
        </div>
        <div data-ri-exp-list>${listHtml}</div>
      </section>
      <section class="ui-sheet ri-panel">
        <header class="ri-panel-head"><div><h3>${t('单卡出场报告', 'Card Usage Report')}</h3></div></header>
        <div data-ri-exp-report>${reportHtml}</div>
      </section>
    </div>`;
  }

  function patchExplorer() {
    if (state.tab !== 'explorer' || !state.data || !container) { render(); return; }
    const listEl = container.querySelector('[data-ri-exp-list]');
    const reportEl = container.querySelector('[data-ri-exp-report]');
    if (!listEl || !reportEl) { render(); return; }
    const { listHtml, reportHtml } = buildExplorerParts(state.data);
    listEl.innerHTML = listHtml;
    reportEl.innerHTML = reportHtml;
  }

  function renderClosing(d) {
    if (mode === 'arena') {
      const pop = d.population;
      const cross = (d.crossBand || []).map(x => {
        const own = (getCard('support', x.support).bandIds || []).map(String);
        const outside = x.boards.filter(b => !own.includes(String(b.band)) && b.count > 0);
        return { support: x.support, own, outside, total: outside.reduce((a, b) => a + b.count, 0) };
      }).filter(x => x.total > 0).sort((a, b) => b.total - a.total);

      return `<div class="ri-split">
        <section class="ui-sheet ri-panel">
          <header class="ri-panel-head"><h3>${t('打工榜 Top 10', 'Top 10 Cross-band Supports')}</h3></header>
          <div class="ri-pair-grid">
            ${cross.slice(0, 10).map((r, i) => `<div class="ri-pair-card ${i === 0 ? 'is-best' : ''}">
              ${cardThumb('support', r.support, 's80')}
              <div class="ri-pair-body">
                <div class="ri-pair-top"><strong>#${i + 1} ${esc(getCard('support', r.support).name)}</strong><b>${fmt(r.total)}</b></div>
                <div class="ri-band-flow">
                  ${r.own.map(bid => { const b = getBand(bid); return b.image ? `<img src="${esc(b.image)}" alt="${esc(b.name)}" title="${esc(b.name)}" width="20" height="20" loading="lazy" decoding="async">` : ''; }).join('')}
                  <span aria-hidden="true">→</span>
                  ${r.outside.map(ob => { const b = getBand(ob.band); return b.image ? `<img src="${esc(b.image)}" alt="${esc(b.name)}" title="${esc(b.name)}: ${ob.count}" width="20" height="20" loading="lazy" decoding="async">` : ''; }).join('')}
                </div>
              </div>
            </div>`).join('')}
          </div>
        </section>
        <section class="ui-sheet ri-panel">
          <header class="ri-panel-head"><div><h3>${t('激奏段位人数联动', 'Arena Tier Population')}</h3><p>${pop ? `${t('估算总人数', 'Estimated total')}: ${fmt(pop.totalEstimate)}` : t('当前段位人数暂不可用', 'Population unavailable')}</p></div></header>
        ${pop ? `<div class="ri-pyramid">
            ${(() => {
              const maxCnt = Math.max(1, ...pop.tiers.map(x => x.count));
              return [...pop.tiers].reverse().map(ti => {
                const p = pop.totalEstimate ? (100 * ti.count / pop.totalEstimate) : 0;
                const col = TIER_COLORS[(ti.tier - 1) % TIER_COLORS.length];
                return `<div class="ri-pyramid-row"><strong style="color:${col}">T${ti.tier}</strong><div class="ri-pyramid-bar"><span style="width:${Math.max(8, 100 * ti.count / maxCnt)}%;background:${col}"></span></div><strong class="ri-tnum" style="text-align:right">${fmt(ti.count)} (${p.toFixed(0)}%)</strong></div>`;
              }).join('');
            })()}
          </div>` : ''}
        </section>
      </div>`;
    }

    const list = d.closingHistory || [];
    const h = list.find(x => String(x.music) === String(d.musicId)) || list[0];
    if (!h) {
      return `<section class="ui-sheet ri-panel"><p class="ri-status">${t('本期暂无最后 24 小时历史采样记录。', 'No final-24h threshold history for this event.')}</p></section>`;
    }
    const base = h.checkpoints.find(x => x.hoursBeforeEnd === 24);
    const meta = [
      { rank: 10, label: t('第 10 名', 'Rank 10'), color: 'var(--theme-chart-4)' },
      { rank: 50, label: t('第 50 名', 'Rank 50'), color: 'var(--theme-chart-3)' },
      { rank: 100, label: t('第 100 名', 'Rank 100'), color: 'var(--theme-chart-1)' },
    ];
    const cps = [...h.checkpoints, { hoursBeforeEnd: 0, observed: h.end, isFinal: true }];
    const series = meta.map(m => {
      const ch = h.changes.find(x => x.rank === m.rank);
      const first = Number(base.scores[String(m.rank)]);
      const pts = cps.map(cp => {
        const sc = cp.isFinal ? ch.final : Number(cp.scores[String(m.rank)]);
        const p = cp.isFinal ? ch.pct : (sc - first) / first * 100;
        return { hours: cp.isFinal ? 0 : (h.end - cp.observed) / 3600, score: sc, pct: p, label: cp.isFinal ? t('结算', 'Final') : `${cp.hoursBeforeEnd}h` };
      });
      return { ...m, change: ch, points: pts };
    });
    const vis = series.filter(s => !state.chartHidden[s.rank]);
    const maxP = Math.max(1, ...vis.flatMap(s => s.points.map(p => p.pct)));
    const ceil = Math.ceil(maxP / 2) * 2;
    const minH = Math.max(...series[0].points.map(p => p.hours));
    const W = 560, H = 210;
    const X = hr => 44 + (minH - hr) / minH * (W - 64);
    const Y = v => 174 - v / ceil * 144;
    const hi = state.chartHoverIdx ?? (cps.length - 1);
    const maxEvP = Math.max(0.1, ...list.map(x => x.changes.find(z => z.rank === 100).pct));

    return `<div class="ri-split">
      <section class="ui-sheet ri-panel">
        <header class="ri-panel-head"><div><h3>${t('最后 24 小时冲刺曲线', 'Final 24h Threshold Curves')}</h3><p>${esc(h.name)}</p></div></header>
        <div class="ri-chart-box">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            ${series.map(s => `<button type="button" class="ui-btn-outline" data-ri-ctog="${s.rank}" style="${state.chartHidden[s.rank] ? 'opacity:0.45' : ''}"><i class="ri-dot" style="background:${s.color}"></i>${s.label}</button>`).join('')}
          </div>
          <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
            ${[0, 1, 2, 3, 4].map(i => `<line x1="44" y1="${Y(ceil * i / 4)}" x2="${W - 20}" y2="${Y(ceil * i / 4)}" stroke="var(--theme-border-soft)"/><text x="38" y="${Y(ceil * i / 4) + 4}" text-anchor="end" font-size="11" fill="var(--theme-muted)">${(ceil * i / 4).toFixed(1)}%</text>`).join('')}
            ${series[0].points.map((pt, idx) => (pt.label === '1h' ? '' : `<text x="${X(pt.hours)}" y="198" text-anchor="middle" font-size="11" fill="var(--theme-muted)">${pt.label}</text>`)).join('')}
            ${vis.map(s => `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" points="${s.points.map(p => `${X(p.hours)},${Y(p.pct)}`).join(' ')}"/>${s.points.map((p, idx) => `<circle cx="${X(p.hours)}" cy="${Y(p.pct)}" r="${idx === hi ? 5.2 : 3.6}" fill="${s.color}" stroke="var(--theme-surface)" stroke-width="1.5" style="cursor:pointer" data-ri-cpt="${idx}"/>`).join('')}`).join('')}
          </svg>
          <div class="ri-chart-tip">
            <strong>${series[0].points[hi].label}</strong>
            ${series.map(s => `<span>#${s.rank}: <b>${fmt(s.points[hi].score)}</b> (+${s.points[hi].pct.toFixed(2)}%)</span>`).join('')}
          </div>
        </div>
      </section>
      <section class="ui-sheet ri-panel">
        <header class="ri-panel-head"><div><h3>${t('本期各曲百名线涨幅', 'Event Songs Top-100 Surge')}</h3></div></header>
        <div style="display:grid;gap:8px">
          ${list.map(x => {
            const c = x.changes.find(z => z.rank === 100);
            const on = String(x.music) === String(h.music);
            return `<button type="button" class="ri-song-btn ${on ? 'active' : ''}" data-ri-song="${esc(x.music)}">
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.name)}</span>
              <div class="ri-meter"><span style="width:${100 * c.pct / maxEvP}%"></span></div>
              <strong class="ri-tnum" style="text-align:right">+${c.pct.toFixed(2)}%</strong>
            </button>`;
          }).join('')}
        </div>
      </section>
    </div>`;
  }

  function render() {
    if (!container) return;
    if (state.loading) {
      container.innerHTML = `<div class="ui-sheet ri-status">${t('正在加载趣味统计…', 'Loading ranking insights…')}</div>`;
      return;
    }
    if (state.error) {
      container.innerHTML = `<div class="ui-sheet ri-status">${esc(state.error)}</div>`;
      return;
    }
    const d = state.data;
    if (!d || d.status !== 'available') {
      container.innerHTML = `<div class="ui-sheet ri-status">${t('当前榜单暂无趣味统计数据。', 'Insights are not available for this board yet.')}</div>`;
      return;
    }
    const tabs = [
      ['overview', t('阵容', 'Meta')],
      ['pairs', mode === 'arena' ? t('搭配与矩阵', 'Pairs') : t('搭配', 'Pairs')],
      ['tiers', t('差异', 'Tiers')],
      ['explorer', t('反查', 'Cards')],
      ['closing', mode === 'arena' ? t('段位', 'Ranks') : t('24h', '24h')],
    ];
    let body = '';
    if (state.tab === 'overview') body = renderOverview(d);
    else if (state.tab === 'pairs') body = renderPairs(d);
    else if (state.tab === 'tiers') body = renderTiers(d);
    else if (state.tab === 'explorer') body = renderExplorer(d);
    else body = renderClosing(d);

    container.innerHTML = `<div class="ri-root">
      ${renderHeadlines(d)}
      <div class="ri-tabs-bar">
        <nav class="ri-tabs-rail" role="tablist">
          ${tabs.map(([id, label]) => `<button type="button" class="ri-tab ${state.tab === id ? 'active' : ''}" data-ri-tab="${id}" role="tab" aria-selected="${state.tab === id}">${ICONS[id] || ''}<span>${label}</span></button>`).join('')}
        </nav>
        <button type="button" class="ui-icon-btn" data-ri-top aria-label="${t('返回顶部', 'Back to top')}" title="${t('返回顶部', 'Back to top')}">${ICONS.top}</button>
      </div>
      ${body}
    </div>`;
  }

  container?.addEventListener('click', e => {
    const pt = e.target.closest('[data-ri-cpt]');
    if (pt) { state.chartHoverIdx = Number(pt.dataset.riCpt); render(); return; }
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.riTop !== undefined) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (btn.dataset.riTab) { state.tab = btn.dataset.riTab; render(); return; }
    if (btn.dataset.riPairMode) { state.pairMode = btn.dataset.riPairMode; render(); return; }
    if (btn.dataset.riCell) { state.matrixCell = btn.dataset.riCell; render(); return; }
    if (btn.dataset.riMember) { state.member = Number(btn.dataset.riMember); render(); return; }
    if (btn.dataset.riDiff) { state.diffKind = btn.dataset.riDiff; render(); return; }
    if (btn.dataset.riExpKind) { state.expKind = btn.dataset.riExpKind; state.expSelected = null; state.expLimit = 16; render(); return; }
    if (btn.dataset.riExpMore !== undefined) { state.expLimit += 24; patchExplorer(); return; }
    if (btn.dataset.riExpPick) { state.expSelected = Number(btn.dataset.riExpPick); patchExplorer(); return; }
    if (btn.dataset.riCtog) { const r = Number(btn.dataset.riCtog); state.chartHidden[r] = !state.chartHidden[r]; render(); return; }
    if (btn.dataset.riSong && state.onSelectSong) { state.onSelectSong(btn.dataset.riSong); }
  });
  container?.addEventListener('change', e => {
    if (e.target.dataset.riCmp === 'a') { state.cmpA = Number(e.target.value); render(); }
    else if (e.target.dataset.riCmp === 'b') { state.cmpB = Number(e.target.value); render(); }
    else if (e.target.hasAttribute('data-ri-diff-sort')) { state.diffSort = e.target.value; render(); }
  });
  container?.addEventListener('input', e => {
    if (e.target.hasAttribute('data-ri-exp-q')) {
      state.expQuery = e.target.value;
      patchExplorer();
    }
  });

  async function select(scope, { onSelectSong, onData } = {}) {
    state.scope = scope;
    if (onSelectSong) state.onSelectSong = onSelectSong;
    if (!scope?.serverId) { state.data = null; render(); return; }
    controller?.abort();
    controller = new AbortController();
    const mySeq = ++seq;
    const params = new URLSearchParams({ mode, server: scope.serverId });
    if (mode === 'arena') {
      if (scope.seasonId) params.set('season', String(scope.seasonId));
      if (scope.bandId) params.set('band', String(scope.bandId));
    } else {
      if (scope.eventId) params.set('event', String(scope.eventId));
      if (scope.musicId) params.set('music', String(scope.musicId));
    }
    const cacheKey = params.toString();
    const cached = responseCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < INSIGHTS_CACHE_TTL_MS) {
      state.data = cached.data;
      state.loading = false;
      state.error = null;
      state.member = null;
      state.matrixCell = null;
      state.chartHoverIdx = null;
      if (onData) onData(cached.data);
      render();
      return;
    }
    state.loading = true;
    state.error = null;
    render();
    try {
      const res = await fetcher('/api/v1/ranking-insights?' + cacheKey, { signal: controller.signal });
      if (mySeq !== seq) return;
      if (!res.ok) throw new Error(t('趣味统计暂时无法加载', 'Could not load ranking insights'));
      const data = await res.json();
      if (mySeq !== seq) return;
      if (responseCache.size >= INSIGHTS_CACHE_MAX) responseCache.clear();
      responseCache.set(cacheKey, { ts: Date.now(), data });
      state.data = data;
      state.loading = false;
      state.member = null;
      state.matrixCell = null;
      state.chartHoverIdx = null;
      if (onData) onData(data);
      render();
    } catch (err) {
      if (mySeq !== seq || err.name === 'AbortError') return;
      state.loading = false;
      state.error = err.message || t('加载失败', 'Load failed');
      render();
    }
  }

  return { select, render };
}
