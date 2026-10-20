const ID = /^[a-f0-9]{24}$/;
const logicalPath = /^\/(?:[A-Za-z0-9_-]+\/)*$/;
const noticePaths = row => Object.hasOwn(row,'paths') ? row.paths : [row.path];

export function deliveredVersion(value, region) {
  const manifest = value?.pointer?.manifest;
  const match = typeof manifest === 'string' && manifest.match(/^\/content\/releases\/([a-f0-9]{24})\/manifest\.json$/);
  if (value?.schemaVersion !== 1 || value.region !== region || typeof value.codeId !== 'string' || !ID.test(value.codeId)
      || value.pointer?.schemaVersion !== 1 || typeof value.pointer?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.pointer.sha256)
      || !match || typeof value.pair !== 'string'
      || !new RegExp(`^${value.codeId}-[a-f0-9]{24}$`).test(value.pair)) return null;
  // A render pair may hash in the optional counterpart edition. Its suffix
  // is not necessarily this edition's content ID; counterpart-only changes
  // must not reshow a deferred native-edition update.
  return {code: value.codeId, content: match[1], key: `${value.codeId}-${match[1]}`};
}

export function updateKind(current, next) {
  if (!current || !next || !ID.test(current.code) || !ID.test(current.content)) return null;
  const code = current.code !== next.code, content = current.content !== next.content;
  return code && content ? 'both' : code ? 'code' : content ? 'content' : null;
}

export function validNotice(row) {
  if (!row || typeof row.id !== 'string' || !/^[a-f0-9]{32}$/.test(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1
      || !['info', 'maintenance', 'incident'].includes(row.kind) || !['all', 'global', 'jp'].includes(row.region)) return false;
  const paths=noticePaths(row);
  if (Object.hasOwn(row,'paths') && Object.hasOwn(row,'path') || !Array.isArray(paths) || !paths.length || paths.length>32
      || paths.some(path=>typeof path!=='string'||path.length>200||!logicalPath.test(path))) return false;
  for (const [field, max] of [['title',120], ['body',2000], ['titleEn',120], ['bodyEn',2000], ['href',300]]) {
    // Match Python's Unicode code-point limits, including supplementary emoji.
    if (typeof row[field] !== 'string' || [...row[field]].length > max || row[field].includes('\0')) return false;
  }
  if (!row.title.trim() || !row.body.trim() || row.href && !logicalPath.test(row.href)) return false;
  for (const field of ['startsAt', 'endsAt']) {
    if (row[field] !== null && (!Number.isFinite(row[field]) || row[field] < 0 || row[field] > 253402300799)) return false;
  }
  return row.endsAt === null || row.startsAt === null || row.endsAt > row.startsAt;
}

export function activeNotices(value, {region, route}, now, dismissed = new Set()) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.notices) || value.notices.length > 32) return [];
  return value.notices.filter(row => validNotice(row) && (row.region === 'all' || row.region === region)
    && noticePaths(row).some(path=>route.startsWith(path)) && (row.startsAt === null || row.startsAt <= now)
    && (row.endsAt === null || now < row.endsAt)
    && (row.kind !== 'info' || !dismissed.has(`${row.id}:${row.revision}`)))
    .sort((a,b) => ['incident','maintenance','info'].indexOf(a.kind) - ['incident','maintenance','info'].indexOf(b.kind));
}

function memory(storage, key) {
  let values;
  try { values = JSON.parse(storage?.getItem(key) ?? '[]'); } catch { /* Storage is optional. */ }
  const set = new Set(Array.isArray(values) ? values.filter(x => typeof x === 'string').slice(-128) : []);
  const save = () => {try { storage?.setItem(key, JSON.stringify([...set])); } catch { /* Keep document memory. */ }};
  return {set, add(value) {
    set.add(value);
    while (set.size > 128) set.delete(set.values().next().value);
    save();
  }, delete(value) {set.delete(value); save();}};
}

export function installSiteNotifications(container, options = {}) {
  if (container.dataset.installed) return;
  container.dataset.installed = 'true';
  const doc = container.ownerDocument, win = doc.defaultView;
  const match = win.location.pathname.match(/^\/(global|jp)\/(zh-CN|en)(\/.*)?$/);
  if (!match) return;
  const context = {region:match[1], locale:match[2], route:match[3] || '/'};
  if (!context.route.endsWith('/')) context.route += '/';
  const en = context.locale === 'en';
  const say = (zh, english) => en ? english : zh;
  const storage = name => {try { return win[name]; } catch { return undefined; }};
  const dismissed = memory(storage('localStorage'), 'ournotes.notice-dismissed.v1');
  const deferred = memory(storage('sessionStorage'), 'ournotes.update-deferred.v1');
  const minimized = memory(storage('sessionStorage'), 'ournotes.notification-minimized.v1');
  const code = String(win[Symbol.for('ournotes.code-root.v1')] ?? '').match(/\/app\/releases\/([a-f0-9]{24})\//)?.[1];
  const content = String(win[Symbol.for('ournotes.content-root.v1')] ?? '').match(/\/content\/releases\/([a-f0-9]{24})\//)?.[1];
  const current = {code, content};
  const prerendered = Boolean(win[Symbol.for('ournotes.prerender.v1')]);
  const fetcher = options.fetcher ?? win.fetch.bind(win);
  const now = options.now ?? (() => Date.now());
  let notices = null, next = null, stopped = false, inFlight = false, lastCheck = -Infinity;
  let firstDelivery, waitingForDeliveryChange = false;
  const noticesBox = container.querySelector('[data-site-notice-list]');
  const updateBox = container.querySelector('[data-site-update]');
  const updateMessage = container.querySelector('[data-site-update-message]');
  const dialog = container.querySelector('[data-site-notification-dialog]');
  const dialogClose = container.querySelector('[data-site-notification-close]');
  const updateDetails = container.querySelector('[data-site-update-details]');
  function showDetails({kind, title, body, href = ''}) {
    container.querySelector('[data-site-notification-kind]').textContent = kind;
    container.querySelector('[data-site-notification-title]').textContent = title;
    container.querySelector('[data-site-notification-body]').textContent = body;
    const link = container.querySelector('[data-site-notification-link]');
    link.hidden = !href;
    if (href) link.href = `/${context.region}/${context.locale}${href}`;
    else link.removeAttribute('href');
    if (!dialog.open) dialog.showModal();
  }
  const panel = container.querySelector('[data-site-notifications-panel]');
  const noticeDock = container.querySelector('[data-site-notice-dock]');
  const openButton = container.querySelector('[data-site-notifications-open]');
  const collapsedBox = container.querySelector('[data-site-notifications-collapsed]');
  const dismissCollapsedButton = container.querySelector('[data-site-notifications-dismiss-collapsed]');
  const minimizeButton = container.querySelector('[data-site-notifications-minimize]');
  const summary = container.querySelector('[data-site-notifications-summary]');
  const count = container.querySelector('[data-site-notifications-count]');
  const make = (tag, text) => {const node = doc.createElement(tag); node.textContent = text; return node;};
  let rendered = '';
  let visibleKeys = [];
  let dismissibleRows = [];
  const sizeObserver = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(measureTickers) : null;
  function measureTickers() {
    container.querySelectorAll('[data-notification-ticker]').forEach(viewport => {
      const track = viewport.querySelector('[data-notification-track]');
      const distance = Math.max(0, track.scrollWidth - viewport.clientWidth);
      viewport.dataset.overflow = String(viewport.clientWidth > 0 && distance > 1);
      viewport.style.setProperty('--ticker-travel', `${-distance}px`);
      viewport.style.setProperty('--ticker-duration', `${Math.max(12, distance / 28 + 4)}s`);
    });
  }
  function observeTickers() {
    sizeObserver?.disconnect();
    container.querySelectorAll('[data-notification-ticker], [data-notification-track]').forEach(node => sizeObserver?.observe(node));
    measureTickers();
  }

  function render() {
    if (stopped) return;
    const rows = activeNotices(notices, context, now()/1000, dismissed.set);
    const signature = JSON.stringify(rows);
    if (signature !== rendered) {
      rendered = signature;
      noticesBox.replaceChildren(...rows.map(row => {
        const box = make('article', ''); box.className = 'site-notice'; box.dataset.kind = row.kind;
        const label = {info:say('公告','Notice'), maintenance:say('维护','Maintenance'), incident:say('服务异常','Service issue')}[row.kind];
        const title = en && row.titleEn || row.title, text = en && row.bodyEn || row.body;
        const ticker = make('button', ''); ticker.type = 'button'; ticker.className = 'site-notice-copy notification-ticker'; ticker.dataset.notificationTicker = ''; ticker.setAttribute('aria-haspopup','dialog');
        ticker.title = say('点击查看完整公告：','View full notice: ') + title;
        const track = make('span', ''); track.className = 'notification-track'; track.dataset.notificationTrack = '';
        const separator = make('span', '·'); separator.className = 'site-notice-separator';
        const textNode = make('span', text); textNode.className = 'site-notice-body';
        track.append(make('strong', title), separator, textNode); ticker.append(track);
        ticker.addEventListener('click', () => showDetails({kind:label, title, body:text, href:row.href}));
        box.append(make('small', label), ticker);
        if (row.kind === 'info') {
          const close = make('button', '×'); close.type = 'button'; close.className = 'site-notice-dismiss';
          close.title = say('关闭公告','Dismiss notice');
          close.setAttribute('aria-label', say('关闭公告：','Dismiss notice: ') + (en && row.titleEn || row.title));
          close.addEventListener('click', () => {dismissed.add(`${row.id}:${row.revision}`); render();}); box.append(close);
        }
        return box;
      }));
    }
    const kind = updateKind(current, next);
    updateBox.hidden = !kind || deferred.set.has(`${context.region}:${next.key}`);
    if (kind) {
      const message = {
      code:say('网站已有新版本，刷新后使用最新功能。','A new website version is available. Refresh to use it.'),
      content:say('当前区服资料已更新，刷新后查看最新内容。','Content for this edition has been updated. Refresh to view it.'),
      both:say('网站功能和当前区服资料已更新，刷新后使用最新版本。','The website and this edition’s content have been updated. Refresh to use them.')
      }[kind];
      if (updateMessage.textContent !== message) updateMessage.textContent = message;
    }
    container.hidden = !rows.length && updateBox.hidden && !dialog.open;
    visibleKeys = rows.map(row => `notice:${row.id}:${row.revision}`);
    dismissibleRows = rows.filter(row => row.kind === 'info');
    noticeDock.hidden = !rows.length;
    const collapsed = visibleKeys.length > 0 && visibleKeys.every(key => minimized.set.has(key));
    panel.hidden = collapsed;
    collapsedBox.hidden = !collapsed;
    dismissCollapsedButton.hidden = !dismissibleRows.length;
    dismissCollapsedButton.setAttribute('aria-label', say(`关闭普通公告（${dismissibleRows.length}）`, `Dismiss ordinary notices (${dismissibleRows.length})`));
    openButton.setAttribute('aria-expanded', String(!collapsed));
    openButton.setAttribute('aria-label', say(`展开公告（${visibleKeys.length}）`, `Open notices (${visibleKeys.length})`));
    openButton.dataset.kind = rows[0]?.kind ?? 'info';
    summary.textContent = rows[0]?.kind === 'incident' ? say('服务异常','Service issue')
      : rows[0]?.kind === 'maintenance' ? say('维护通知','Maintenance')
      : say('网站公告','Notices');
    count.textContent = String(visibleKeys.length);
    observeTickers();
  }

  async function read(url) {
    const response = await fetcher(url, {cache:'no-store', credentials:'same-origin', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw Error('Notification source unavailable');
    const body = await response.text();
    if (body.length > 1024 * 1024) throw Error('Notification source too large');
    return JSON.parse(body);
  }
  async function check() {
    if (stopped || inFlight || doc.hidden || now() - lastCheck < 15000) return;
    inFlight = true; lastCheck = now();
    const results = await Promise.allSettled([read('/site-notices.json'), read(`/site-status/${context.region}.json`)]);
    inFlight = false;
    if (stopped) return;
    if (results[0].status === 'fulfilled' && results[0].value?.schemaVersion === 1 && Array.isArray(results[0].value.notices)
        && results[0].value.notices.length <= 32 && results[0].value.notices.every(validNotice)) notices = results[0].value;
    if (results[1].status === 'fulfilled') {
      const candidate = deliveredVersion(results[1].value, context.region);
      if (candidate) {
        // A cold fallback may already run newer code/content while HTML is
        // still being prepared. Do not advertise the older initial render.
        if (firstDelivery === undefined) {
          firstDelivery = candidate.key;
          waitingForDeliveryChange = !prerendered && Boolean(updateKind(current, candidate));
        }
        if (candidate.key !== firstDelivery) waitingForDeliveryChange = false;
        if (!waitingForDeliveryChange) next = candidate;
      }
    }
    render();
  }
  const refresh = () => (options.reload ?? (() => win.location.reload()))();
  const later = () => {if (next) deferred.add(`${context.region}:${next.key}`); render();};
  const showUpdate = () => showDetails({kind:say('更新提醒','Update'), title:say('网站内容已更新','Website update'), body:updateMessage.textContent});
  const closeDetails = () => dialog.close();
  const minimize = () => {visibleKeys.forEach(key => minimized.add(key)); render(); openButton.focus({preventScroll:true});};
  const open = () => {visibleKeys.forEach(key => minimized.delete(key)); render(); minimizeButton.focus({preventScroll:true});};
  const dismissCollapsed = () => {
    dismissibleRows.forEach(row => dismissed.add(`${row.id}:${row.revision}`));
    render();
    if (!noticeDock.hidden) openButton.focus({preventScroll:true});
    else if (!updateBox.hidden) laterButton.focus({preventScroll:true});
  };
  const escape = event => {if (event.key === 'Escape' && !panel.hidden && panel.contains(event.target)) {event.preventDefault(); event.stopPropagation(); minimize();}};
  const visible = () => {if (!doc.hidden) {render(); void check();}};
  const timer = win.setInterval(() => {if (!container.isConnected) return stop(); if (!doc.hidden) {render(); if(now()-lastCheck >= 180000) void check();}}, 15000);
  const refreshButton = container.querySelector('[data-site-refresh]'), laterButton = container.querySelector('[data-site-update-later]');
  refreshButton.addEventListener('click', refresh); laterButton.addEventListener('click', later);
  openButton.addEventListener('click', open); minimizeButton.addEventListener('click', minimize);
  dismissCollapsedButton.addEventListener('click', dismissCollapsed);
  updateDetails.addEventListener('click', showUpdate); dialogClose.addEventListener('click', closeDetails);
  dialog.addEventListener('close', render);
  container.addEventListener('keydown', escape);
  doc.addEventListener('visibilitychange', visible); win.addEventListener('pageshow', visible);
  function stop() {
    stopped = true; win.clearInterval(timer);
    sizeObserver?.disconnect();
    doc.removeEventListener('visibilitychange', visible); win.removeEventListener('pageshow', visible);
    win.removeEventListener('pagehide', pagehide);
    refreshButton.removeEventListener('click', refresh); laterButton.removeEventListener('click', later);
    openButton.removeEventListener('click', open); minimizeButton.removeEventListener('click', minimize);
    dismissCollapsedButton.removeEventListener('click', dismissCollapsed);
    updateDetails.removeEventListener('click', showUpdate); dialogClose.removeEventListener('click', closeDetails);
    dialog.removeEventListener('close', render);
    if (dialog.open) dialog.close();
    container.removeEventListener('keydown', escape);
  }
  function pagehide(event) {if (!event.persisted) stop();}
  win.addEventListener('pagehide', pagehide);
  void check();
  return {check, render, stop};
}
