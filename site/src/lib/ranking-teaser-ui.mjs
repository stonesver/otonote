/**
 * Lightweight hot-stats teaser strip mounted near Event & Arena leaderboards.
 * Kept separate from ranking-insights-ui.mjs so /rankings/ and /arena/ do not
 * download the full 5-tab analytics UI on initial page load.
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n ?? 0).toLocaleString('en-US');
const pct = (a, n) => (n ? (100 * a / n).toFixed(1).replace(/\.0$/, '') + '%' : '0%');

const TEASER_CACHE_TTL_MS = 120_000;
const TEASER_CACHE_MAX = 16;

export function createRankingTeaserClient({ container, mode, en = false, catalog = {}, statsBaseHref = '/rankings/stats/', fetcher = fetch }) {
  const t = (zh, eng) => (en ? eng : zh);
  const cache = new Map();
  let controller = null;
  let seq = 0;
  let hostEl = container;

  const getCard = (kind, id) => (catalog[kind] || {})[String(id)] || { name: `#${id}`, image: null, rarityLabel: '', bandIds: [] };

  const buildStatsUrl = (scope, tab = 'overview') => {
    const qs = new URLSearchParams({ mode, server: scope.serverId, tab });
    if (mode === 'arena') {
      if (scope.seasonId) qs.set('season', String(scope.seasonId));
      if (scope.bandId) qs.set('band', String(scope.bandId));
    } else {
      if (scope.eventId) qs.set('event', String(scope.eventId));
      if (scope.musicId) qs.set('music', String(scope.musicId));
    }
    return `${statsBaseHref}?${qs}`;
  };

  function setContainer(el) {
    hostEl = el;
  }

  function renderTeaser(d, scope) {
    if (!hostEl) return;
    if (d?.status !== 'available' || !d.stats?.n) {
      hostEl.hidden = true;
      return;
    }

    const st = d.stats;
    const top1 = st.members?.top?.[0];
    const pills = [];
    if (top1) {
      pills.push(`<a class="ri-teaser-pill" href="${esc(buildStatsUrl(scope, 'overview'))}"><small>${t('Top 1 阵容', 'Top 1 team')}</small><strong>${pct(top1.count, st.n)}</strong></a>`);
    }

    if (mode === 'arena') {
      let lowBest = null;
      for (const kind of ['member', 'support']) {
        for (const [id, ranks] of Object.entries(st.headCardRanks?.[kind] || {})) {
          const c = getCard(kind, id);
          if (!['R', 'SR'].includes(c.rarityLabel)) continue;
          if (!lowBest || ranks[0] < lowBest.rank) lowBest = { kind, id, rank: ranks[0], card: c };
        }
      }
      if (lowBest) {
        const isSup = lowBest.kind === 'support';
        pills.push(`<a class="ri-teaser-pill" href="${esc(buildStatsUrl(scope, 'overview'))}">${lowBest.card.image ? `<img class="${isSup ? 'is-support' : ''}" src="${esc(lowBest.card.image)}" alt="" width="${isSup ? 38 : 24}" height="${isSup ? 22 : 24}" loading="lazy" decoding="async">` : ''}<small>${t('低稀有度', 'Low-rarity')}</small><strong>#${lowBest.rank}</strong></a>`);
      }
      const topCross = (d.crossBand || []).map(x => {
        const own = (getCard('support', x.support).bandIds || []).map(String);
        const total = x.boards.filter(b => !own.includes(String(b.band))).reduce((a, b) => a + b.count, 0);
        return { support: x.support, total };
      }).sort((a, b) => b.total - a.total)[0];
      if (topCross && topCross.total > 0) {
        const sc = getCard('support', topCross.support);
        pills.push(`<a class="ri-teaser-pill" href="${esc(buildStatsUrl(scope, 'pairs'))}">${sc.image ? `<img class="is-support" src="${esc(sc.image)}" alt="" width="38" height="22" loading="lazy" decoding="async">` : ''}<small>${t('跨队打工王', 'Top cross-band')}</small><strong>${fmt(topCross.total)}</strong></a>`);
      }
    } else {
      const songCount = d.songs?.length || 0;
      const allSame = d.sameTeamSongsHistogram?.[String(songCount)] || 0;
      if (songCount >= 2 && allSame > 0) {
        pills.push(`<a class="ri-teaser-pill" href="${esc(buildStatsUrl(scope, 'overview'))}"><small>${t(`同队打满 ${songCount} 曲`, `1 team × ${songCount} songs`)}</small><strong>${allSame}${t('人', '')}</strong></a>`);
      }
      const hist = (d.closingHistory || []).find(x => String(x.music) === String(d.musicId));
      const c100 = hist?.changes?.find(z => z.rank === 100);
      if (c100) {
        pills.push(`<a class="ri-teaser-pill" href="${esc(buildStatsUrl(scope, 'closing'))}"><small>${t('24h 百名线', '24h Top-100')}</small><strong>+${c100.pct.toFixed(2)}%</strong></a>`);
      }
    }

    hostEl.innerHTML = `<div class="ri-teaser-items">${pills.join('')}</div><a class="ui-btn-soft ri-teaser-cta" href="${esc(buildStatsUrl(scope, 'overview'))}">${t('数据统计 →', 'Data stats →')}</a>`;
    hostEl.hidden = false;
  }

  async function select(scope) {
    if (!hostEl) return;
    if (!scope?.serverId) { hostEl.hidden = true; hostEl.innerHTML = ''; return; }
    controller?.abort();
    controller = new AbortController();
    const mySeq = ++seq;
    const qs = new URLSearchParams({ mode, server: scope.serverId, view: 'teaser' });
    if (mode === 'arena') {
      if (scope.seasonId) qs.set('season', String(scope.seasonId));
      if (scope.bandId) qs.set('band', String(scope.bandId));
    } else {
      if (scope.eventId) qs.set('event', String(scope.eventId));
      if (scope.musicId) qs.set('music', String(scope.musicId));
    }
    const key = qs.toString();
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.ts) < TEASER_CACHE_TTL_MS) {
      renderTeaser(cached.data, scope);
      return;
    }
    try {
      const res = await fetcher('/api/v1/ranking-insights?' + key, { signal: controller.signal });
      if (mySeq !== seq || !res.ok) { if (mySeq === seq && hostEl) hostEl.hidden = true; return; }
      const d = await res.json();
      if (mySeq !== seq) return;
      if (cache.size >= TEASER_CACHE_MAX) cache.clear();
      cache.set(key, { ts: Date.now(), data: d });
      renderTeaser(d, scope);
    } catch {
      if (mySeq === seq && hostEl) hostEl.hidden = true;
    }
  }

  return { select, setContainer };
}
