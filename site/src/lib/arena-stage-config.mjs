/** Resolve published stage conditions within the page's immutable content release. */
export function resolveArenaStage(data, { region, serverId, sourceReleaseId, bandId, seasonId, regulationId, now = Date.now() }) {
  if (!data) throw Error('当前资料未收录舞台安排，可切换手动试配');
  if (data.schemaVersion !== 1 || data.sourceReleaseId !== sourceReleaseId || data.region !== region) throw Error('舞台配置与当前内容版本不一致');
  if (!serverId) throw Error('请先选择账号区服');
  if (!data.serverScopes.includes(serverId)) throw Error('当前区服尚未收录舞台安排');
  if (!data.capabilities.conditions) throw Error('当前舞台条件暂不可用');
  const contains = row => Date.parse(row.validFrom) <= now && now < Date.parse(row.validUntil);
  const seasons = data.seasons.filter(s => seasonId ? s.id === String(seasonId) : contains(s));
  if (seasons.length !== 1) throw Error(seasonId ? '所选赛季不存在或配置冲突' : '当前没有唯一有效的舞台赛季');
  const season = seasons[0];
  const leagues = data.leagues.filter(l => String(l.bandId) === String(bandId));
  if (leagues.length !== 1) throw Error('所选乐队没有唯一的舞台联赛');
  const league = leagues[0];
  const periods = data.regulations.filter(r => r.leagueId === league.id && Date.parse(r.validFrom) < Date.parse(season.validUntil) && Date.parse(r.validUntil) > Date.parse(season.validFrom));
  const matches = periods.filter(r => regulationId ? r.id === String(regulationId) : contains(r));
  if (matches.length !== 1) throw Error(regulationId ? '所选场次不存在或不属于该乐队与赛季' : matches.length ? '当前舞台配置冲突' : '新一期舞台条件尚未收录');
  const regulation = matches[0];
  const validFrom = new Date(Math.max(Date.parse(season.validFrom), Date.parse(regulation.validFrom), league.opensAt ? Date.parse(league.opensAt) : -Infinity)).toISOString();
  const validUntil = new Date(Math.min(Date.parse(season.validUntil), Date.parse(regulation.validUntil))).toISOString();
  if (Date.parse(validFrom) >= Date.parse(validUntil)) throw Error('所选场次尚未开放');
  const status = now < Date.parse(validFrom) ? 'upcoming' : now >= Date.parse(validUntil) ? 'past' : 'current';
  return { season, league, regulation, periods, status,
    stage: { source: 'schedule', sourceReleaseId, sourceRevision: data.sourceRevision, serverId,
      seasonId: season.id, leagueId: league.id, regulationId: regulation.id, validFrom, validUntil,
      bandId: Number(league.bandId), musicType: regulation.attribute, missions: [...regulation.missions] } };
}

export function arenaStageTime(value, timeZone) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
