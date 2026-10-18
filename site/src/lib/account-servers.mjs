/** Account source identities are independent of website language and catalog edition. */
export const ACCOUNT_SERVERS = Object.freeze(['global-hmt','global-en','global-kr']);
export const accountServer = id => ACCOUNT_SERVERS.includes(id);
export const accountCapabilitiesUrl = id => '/api/growth-export/capabilities/'
  + (id === 'global-hmt' ? '' : `?serverId=${encodeURIComponent(id)}`);

export function snapshotServer(source, {legacyHmt = false} = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('资料缺少区服身份');
  const id = source.serverId ?? (legacyHmt && source.region === 'TW/HK/MO' ? 'global-hmt' : null);
  if (!accountServer(id) || (source.edition && source.edition !== 'global')
      || (source.region && !['global','TW/HK/MO'].includes(source.region))
      || (source.region === 'TW/HK/MO' && id !== 'global-hmt')) throw Error('资料区服身份不一致');
  return id;
}

// EN uses explicit UTC as a presentation policy, not a guessed game-day reset.
export function historyZone(id = 'global-hmt') {
  const offset = {'global-hmt':8,'global-en':0,'global-kr':9}[id];
  if (offset === undefined) throw Error('未知抽卡记录区服');
  return {offset, label:offset ? `UTC+${offset}` : 'UTC'};
}
