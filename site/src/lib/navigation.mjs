export const NAVIGATION_GROUPS = Object.freeze([
  { id: "events", labelKey: "events", href: "/events/", matchPrefixes:["/events/","/rankings/","/recruitment/","/missions/"], children: [
    {labelKey:"eventOverview",href:"/events/"},
    {labelKey:"recruitment",href:"/recruitment/"},
    {labelKey:"missions",href:"/missions/"},
    {labelKey:"playerRankings",href:"/rankings/"}
  ] },
  { id: "catalog", labelKey: "navCatalog", href: "/catalog/",
    matchPrefixes: ["/catalog/", "/characters/", "/costumes/", "/cards/", "/database/"],
    children: [
      { labelKey: "characters", href: "/characters/" },
      { labelKey: "costumes", href: "/costumes/" },
      { labelKey: "memberCards", href: "/cards/members/" },
      { labelKey: "supportCards", href: "/cards/supports/" },
      { labelKey: "skillArchive", href: "/database/skills/" },
      { labelKey: "itemArchive", href: "/database/items/" },
      { labelKey: "bandItemArchive", href: "/database/band-items/" },
      { labelKey: "globalSystems", href: "/database/global-systems/" }
    ] },
  { id: "music", labelKey: "navMusic", href: "/music/", children: [
    { labelKey: "musicScores", href: "/music/" },
    { labelKey: "bgmLibrary", href: "/music/bgm/" }
  ] },
  { id: "immersive", labelKey: "navImmersive", href: "/immersive/", children: [] },
  { id: "comics", labelKey: "navComics", href: "/comics/", children: [] },
  { id: "stamps", labelKey: "navStamps", href: "/stamps/", children: [] },
  { id: "decorations", labelKey: "navDecorations", href: "/profile-decorations/", children: [] },
  { id: "stories", labelKey: "navStories", href: "/stories/main/", matchPrefixes: ["/stories/"], children: [
    { labelKey: "storyMain", href: "/stories/main/" },
    { labelKey: "storyExtra", href: "/stories/extra/" },
    { labelKey: "storyViewpoint", href: "/stories/viewpoint/" },
    { labelKey: "storyFriendship", href: "/stories/friendship/" },
    { labelKey: "eventStories", href: "/stories/events/" }
  ] },
  { id: "my-growth", labelKey: "myGrowth", href: "/my-growth/", children: [] },
  { id: "tools", labelKey: "navTools", href: "/tools/", matchPrefixes: ["/tools/"],
    children: [
      { labelKey: "live2dWorkbench", href: "/tools/live2d/" },
      { labelKey: "teamBuilder", href: "/tools/deck-builder/" },
      { labelKey: "songCalculator", href: "/tools/song-calculator/" },
      { labelKey: "songRanking", href: "/tools/song-ranking/" },
      { labelKey: "apGrade", href: "/tools/ap-grade/" },
      { labelKey: "eventEfficiency", href: "/tools/event-efficiency/" },
      { labelKey: "resourceFinder", href: "/tools/resources/" },
    ] }
]);

export function navigationRoutes() {
  return NAVIGATION_GROUPS.flatMap((group) => [
    group.href,
    ...group.children.map((item) => item.href)
  ]).filter((route, index, routes) => routes.indexOf(route) === index);
}

export function activeNavigationChild(pathname, children) {
  return children.filter(child => pathname.startsWith(child.href))
    .sort((left, right) => right.href.length - left.href.length)[0];
}

export function activeNavigationGroup(pathname) {
  if (pathname === "/") return "home";
  const match = NAVIGATION_GROUPS.find((group) => {
    if (group.id === "home") return false;
    const prefixes = group.matchPrefixes ?? [group.href];
    return prefixes.some((prefix) => pathname.startsWith(prefix));
  });
  return match?.id;
}
