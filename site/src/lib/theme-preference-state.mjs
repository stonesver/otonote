/** Manual choices win; overlapping campaigns use the most recently started window. */
export function resolveThemePreference(preference, themes, campaigns, defaultTheme, now = Date.now()) {
  const manual = themes.find(theme => theme.id === preference);
  const windows = campaigns.map(campaign => ({
    ...campaign,
    theme: campaign.theme ?? (campaign.attribute == null ? undefined : themes.find(theme => theme.attribute === campaign.attribute)?.id)
  })).filter(campaign => themes.some(theme => theme.id === campaign.theme));
  const active = manual ? null : windows
    .filter(campaign => Date.parse(campaign.startsAt) <= now && now < Date.parse(campaign.endsAt))
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))[0] ?? null;
  const theme = manual ?? themes.find(theme => theme.id === (active?.theme ?? defaultTheme));
  const boundaries = manual ? [] : windows.flatMap(campaign => [Date.parse(campaign.startsAt), Date.parse(campaign.endsAt)]).filter(time => time > now);
  return {preference:manual ? manual.id : 'auto', theme, campaign:active, nextChangeAt:boundaries.length ? Math.min(...boundaries) : null};
}
