import {GAME_SERVERS, currentServerContext} from './game-servers.mjs';

export function maintenanceNotice(observation, locale = 'zh', now = Date.now()) {
  if (observation?.status !== 'maintenance') return '';
  const en = locale === 'en';
  const end = Date.parse(observation.maintenance?.expectedEndAt);
  const time = Number.isFinite(end) ? new Intl.DateTimeFormat(en ? 'en-GB' : 'zh-CN', {
    timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
  }).format(end) : null;
  return en ? `Official game maintenance. Online reads are paused.${time ? end <= now
    ? ' The expected end time has passed; recovery is not confirmed.' : ` Expected end: ${time} (UTC+8).` : ''}`
    : `游戏官方维护中，在线读取暂时停止。${time ? end <= now
      ? '预计结束时间已过，等待官方恢复确认。' : `预计 ${time}（UTC+8）结束。` : ''}`;
}

// Automatic observations live only for the current page, never in the notice store.
export function retainMaintenance(previous, servers = {}) {
  const result = {};
  for (const {id} of GAME_SERVERS.filter(server => server.region === 'global')) {
    const row = servers?.[id];
    if (row?.status === 'maintenance') result[id] = {...row, uncertain:false};
    else if (previous[id] && row?.status !== 'no_maintenance_signal') result[id] = {...previous[id], uncertain:true};
  }
  return result;
}

export function maintenanceStatusRows(observations, {region, serverId, locale = 'zh-CN'}, now = Date.now()) {
  if (region !== 'global') return [];
  const en = locale === 'en';
  return GAME_SERVERS.filter(server => server.region === 'global' && (!serverId || server.id === serverId))
    .flatMap(server => {
      const row = observations[server.id];
      if (row?.status !== 'maintenance') return [];
      const end = Date.parse(row.maintenance?.expectedEndAt);
      const time = Number.isFinite(end) ? new Intl.DateTimeFormat(en ? 'en-GB' : 'zh-CN', {
        timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
      }).format(end) : null;
      const pending = row.uncertain || Number.isFinite(end) && end <= now;
      return [{serverId:server.id,
        title:en ? `${server.englishLabel} · Game server updating` : `${server.label} · 游戏服务器更新中`,
        timing:(time ? en ? `Expected end: ${time} (UTC+8)` : `预计 ${time}（UTC+8）结束`
          : en ? 'End time to be confirmed' : '结束时间待定')
          + (pending ? en ? ' · Recovery not confirmed' : ' · 恢复待确认' : '')}];
    });
}

export function installGameServiceNotice(root) {
  if (!root) return;
  let rendered = '';
  return watchGameServiceStatus(observations => {
    let context;
    try { context = currentServerContext(); } catch { root.hidden = true; return; }
    const rows = maintenanceStatusRows(observations, {...context, locale:root.dataset.locale});
    root.hidden = !rows.length;
    const signature = JSON.stringify(rows);
    if (signature === rendered) return;
    rendered = signature;
    const doc = root.ownerDocument;
    root.querySelector('[data-game-service-rows]').replaceChildren(...rows.map(row => {
      const item = doc.createElement('div'); item.className = 'game-service-notice__row';
      const title = doc.createElement('strong'); title.textContent = row.title;
      const timing = doc.createElement('span'); timing.textContent = row.timing;
      item.append(title, timing);
      return item;
    }));
  });
}

function watchGameServiceStatus(onChange, {fetcher = globalThis.fetch} = {}) {
  let disposed = false, inFlight = false, timer, controller;
  let observations = {};
  const events = new AbortController();
  const publish = data => {
    observations = retainMaintenance(observations, data.servers);
    onChange(observations);
    window.dispatchEvent(new CustomEvent('game-service-status-change', {detail:data}));
  };
  const refresh = async () => {
    if (disposed || inFlight) return;
    clearTimeout(timer);
    inFlight = true;
    const request = controller = new AbortController();
    const timeout = setTimeout(() => request.abort(), 9000);
    try {
      const response = await fetcher('/api/growth-export/status/', {
        credentials:'omit', cache:'no-store', signal:request.signal
      });
      if (!response.ok) throw Error();
      const data = await response.json();
      if (data.schemaVersion !== 1 || !data.servers || Date.parse(data.validUntil) <= Date.now()
          || !Number.isFinite(Date.parse(data.validUntil))) throw Error();
      if (!disposed) publish(data);
    } catch {
      if (!disposed) publish({servers:{}});
    } finally {
      clearTimeout(timeout);
      inFlight = false;
      if (!disposed) timer = setTimeout(refresh,60000);
    }
  };
  const stop = () => { disposed=true; clearTimeout(timer); controller?.abort(); events.abort(); };
  window.addEventListener('pagehide',event => { if (!event.persisted) stop(); },{signal:events.signal});
  window.addEventListener('pageshow',event => { if (event.persisted) refresh(); },{signal:events.signal});
  document.addEventListener('ournotes:shell-dispose',stop,{once:true,signal:events.signal});
  refresh();
  return stop;
}
