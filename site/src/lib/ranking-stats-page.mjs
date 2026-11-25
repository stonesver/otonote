/**
 * Standalone "数据统计" (Data Stats) page controller for /rankings/stats/.
 * Coordinates mode (arena/activity), server, band/event/song selectors with createRankingInsightsClient.
 */
import { createRankingInsightsClient } from './ranking-insights-ui.mjs';

export function installRankingStatsPage(root) {
  if (!root || root.dataset.installed) return;
  root.dataset.installed = 'true';

  const en = root.dataset.locale === 'en';
  const catalog = JSON.parse(root.querySelector('[data-stats-cards]')?.textContent || '{}');
  const ctx = JSON.parse(root.querySelector('[data-stats-context]')?.textContent || '{}');
  const host = root.querySelector('[data-stats-host]');

  const params = new URLSearchParams(location.search);
  const eventSel = root.querySelector('[data-stats-event]');
  const songSel = root.querySelector('[data-stats-song]');
  const bandRail = root.querySelector('[data-stats-band-rail]');
  const eventWrap = root.querySelector('[data-stats-event-wrap]');
  const songWrap = root.querySelector('[data-stats-song-wrap]');

  const validTabs = ['overview', 'pairs', 'tiers', 'explorer', 'closing'];
  const state = {
    mode: params.get('mode') === 'activity' ? 'activity' : 'arena',
    server: ['global-hmt', 'global-en', 'global-kr', 'jp'].includes(params.get('server')) ? params.get('server') : 'global-hmt',
    season: params.get('season') || '1',
    band: params.get('band') || (ctx.bands?.[0]?.id ?? '1'),
    event: params.get('event') || (eventSel?.options?.[0]?.value ?? ctx.events?.[0]?.id ?? ''),
    music: params.get('music') || '',
    tab: validTabs.includes(params.get('tab')) ? params.get('tab') : 'overview',
  };

  let activeClient = null;
  let activeMode = null;

  const syncUrl = () => {
    const u = new URL(location.href);
    u.searchParams.set('mode', state.mode);
    u.searchParams.set('server', state.server);
    if (state.mode === 'arena') {
      u.searchParams.set('season', state.season);
      u.searchParams.set('band', state.band);
      u.searchParams.delete('event');
      u.searchParams.delete('music');
    } else {
      if (state.event) u.searchParams.set('event', state.event);
      if (state.music) u.searchParams.set('music', state.music);
      u.searchParams.delete('season');
      u.searchParams.delete('band');
    }
    history.replaceState(history.state, '', u);
  };

  const ensureClient = () => {
    if (activeClient && activeMode === state.mode) return activeClient;
    activeMode = state.mode;
    host.replaceChildren();
    activeClient = createRankingInsightsClient({
      container: host,
      mode: state.mode,
      en,
      catalog,
      bands: ctx.bands || [],
      songs: ctx.songs || {},
      initialTab: state.tab,
      serverId: state.server,
    });
    return activeClient;
  };

  const refreshControls = () => {
    root.querySelectorAll('[data-stats-mode]').forEach(b => {
      const on = b.dataset.statsMode === state.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    root.querySelectorAll('[data-stats-server]').forEach(b => {
      const on = b.dataset.statsServer === state.server;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (bandRail) {
      bandRail.hidden = state.mode !== 'arena';
      bandRail.querySelectorAll('[data-stats-band]').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.statsBand === state.band));
      });
    }
    if (eventWrap) eventWrap.hidden = state.mode !== 'activity';
    if (songWrap) songWrap.hidden = state.mode !== 'activity';
    if (eventSel && state.event) eventSel.value = state.event;
  };

  const load = () => {
    refreshControls();
    syncUrl();
    const client = ensureClient();
    client.select(
      state.mode === 'arena'
        ? { serverId: state.server, seasonId: state.season, bandId: state.band }
        : { serverId: state.server, eventId: state.event || null, musicId: state.music || '' },
      {
        onSelectSong: id => {
          state.music = id;
          if (songSel) songSel.value = id;
          load();
        },
        onData: data => {
          if (state.mode !== 'activity' || !songSel || !Array.isArray(data?.songs) || !data.songs.length) return;
          songSel.innerHTML = data.songs
            .map(s => `<option value="${String(s.id).replace(/"/g, '&quot;')}">${String(s.name).replace(/</g, '&lt;')}</option>`)
            .join('');
          const chosen = data.musicId || data.songs[0].id;
          state.music = chosen;
          songSel.value = chosen;
          syncUrl();
        },
      }
    );
  };

  root.addEventListener('click', e => {
    document.querySelectorAll('details.ui-tip-disclosure[open]').forEach(det => {
      if (!det.contains(e.target)) det.open = false;
    });
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.statsMode) { state.mode = btn.dataset.statsMode; load(); return; }
    if (btn.dataset.statsServer) { state.server = btn.dataset.statsServer; load(); return; }
    if (btn.dataset.statsBand) { state.band = btn.dataset.statsBand; load(); return; }
  });

  eventSel?.addEventListener('change', () => { state.event = eventSel.value; state.music = ''; load(); });
  songSel?.addEventListener('change', () => { state.music = songSel.value; load(); });

  load();
}

if (typeof document !== 'undefined') {
  document.querySelectorAll('[data-ranking-stats-page]').forEach(installRankingStatsPage);
}
