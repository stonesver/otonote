// Stable decoration keys shared by cold entry, navigation and tool readiness.
// Cold entry embeds its art; prerender uses checked, pinned content media.
// The original stamps contain no lettering: copy stays in localized HTML.
export const loadingArtFiles = ['stamps-1000000008.webp', 'stamps-1000000004.webp'];

// Always present in a clean code build. Game decorations belong to the pinned
// content release and are selected only after their availability is checked.
export function fallbackLoadingArt(codeRoot) {
  return Object.fromEntries(loadingArtFiles.map(file => [file, codeRoot + 'loading/brand-fallback.svg']));
}

const scenes = {
  home: [0, '开演前，先打个招呼。', 'A little hello before the show.'],
  cards: [0, '你的下一张心动，正在候场。', 'Your next favourite is waiting in the wings.'],
  music: [0, '下一首，马上响起。', 'The next song is almost on.'],
  detail: [1, '把这一刻，再看仔细一点。', 'A closer look at this moment.'],
  story: [1, '故事，正翻到下一页。', 'Turning to the next page of the story.'],
  scene: [0, '灯光就位，等你入场。', 'Lights up. Your scene awaits.'],
  tool: [1, '好演出，从准备开始。', 'Every great show starts with preparation.'],
  list: [1, '舞台之外，也有新发现。', 'More to discover beyond the stage.']
};

export function loadingPresentation(kind, locale = 'zh-CN') {
  const [art, zh, en] = scenes[kind] ?? scenes.list;
  return { art: loadingArtFiles[art], caption: locale === 'en' ? en : zh };
}
