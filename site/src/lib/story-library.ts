import type {EditionRecord} from "./catalog";
import { activeReleaseContext } from "./release-context";
import { gameModeDatabase } from "./game-modes";
import { validatedEvents, decorateEventStories } from "./event-content.mjs";
import { eventCopy } from "./event-copy";

export type StoryCategory = "band" | "viewpoint" | "friendship";
export type StoryKind = "main" | "extra" | "viewpoint" | "friendship" | "event";
export const storyKinds = ["main", "extra", "viewpoint", "friendship"] as const;
export function storyKind(entry: Pick<TextStoryEntry, "category" | "isExtra" | "eventId">): StoryKind {
  if (entry.eventId != null) return "event";
  return entry.category === "band" ? (entry.isExtra ? "extra" : "main") : entry.category;
}

export interface TextStoryEntry extends EditionRecord {
  contentIdentity?:string; sourceSha256?:string;
  eventId?: number;
  eventSection?: "main" | "another" | "extra";
  fallbackTextCount?: number;
  id: string; category: StoryCategory; title: string; description: string;
  chapterId: number | null; chapterName: string; characterIds: number[];
  bandIds: number[]; group: string; episodeNumber: number; isExtra: boolean;
  friendshipLevel: number; lineCount: number; previousId: string | null; nextId: string | null;
}
export interface TextStoryLine {
  locale?: string;
  fallbackLocales?: string[];
  id: string; sourceIndex: number;
  kind: "dialogue" | "chat" | "narration" | "location" | "subtitle" | "stamp";
  speaker: string; text: string;
}
interface StoryLibrary {
  schemaVersion: number; sourceReleaseId: string; locale: string; entries: TextStoryEntry[];
  chapters: Array<{ id: number; name: string; bandId: number }>;
  characters: Array<{ id: number; name: string }>;
  bands: Array<{ id: number; name: string }>;
}

// Server/build only: one episode is rendered per page. No full script database
// or runtime command stream is sent to the directory's browser bundle.
const libraries = import.meta.glob<StoryLibrary>("@projection-data/story-library.json", { eager: true, import: "default" });
export const storyLibrary: StoryLibrary = Object.values(libraries)[0]
  ?? { schemaVersion: 1, sourceReleaseId: activeReleaseContext.contentReleaseId,
      locale: activeReleaseContext.locale, entries: [], chapters: [], characters: [], bands: [] };
if (storyLibrary.schemaVersion !== 1 || storyLibrary.sourceReleaseId !== activeReleaseContext.contentReleaseId
    || storyLibrary.locale !== activeReleaseContext.locale) {
  throw new Error("Story library does not match this release and locale");
}
storyLibrary.entries = decorateEventStories(storyLibrary.entries, validatedEvents(gameModeDatabase.events, activeReleaseContext));
const categoryOrder = { band: 0, viewpoint: 1, friendship: 2 };
storyLibrary.entries.sort((a, b) => categoryOrder[a.category] - categoryOrder[b.category]
  || Math.min(...a.bandIds) - Math.min(...b.bandIds)
  || Number(a.group.split("-").at(-1)) - Number(b.group.split("-").at(-1))
  || a.episodeNumber - b.episodeNumber);
export const storyEntries = new Map(storyLibrary.entries.map((entry) => [entry.id, entry]));
export const storyCharacters = new Map(storyLibrary.characters.map((entry) => [entry.id, entry.name]));
export const storyBands = new Map(storyLibrary.bands.map((entry) => [entry.id, entry.name]));
const storyDocuments = import.meta.glob<{ id: string; sourceReleaseId: string; locale: string; lines: TextStoryLine[] }>(
  "@projection-data/story-text/*.json", { eager: true, import: "default" });
export function readTextStory(id: string): TextStoryLine[] {
  if (!storyEntries.has(id)) throw new Error("Unknown story");
  const document = Object.values(storyDocuments).find(document => document.id === id);
  if (!document || document.sourceReleaseId !== storyLibrary.sourceReleaseId
      || document.locale !== storyLibrary.locale || !Array.isArray(document.lines) || !document.lines.length) {
    throw new Error("Story document does not match this release and locale");
  }
  return document.lines;
}

const zh = {
  title: "剧情故事", intro: "从乐队的相遇，到每个人眼中的故事。按原始对白顺序，慢慢读下去。",
  main: "乐队主线", extraStory: "乐队额外故事", mainHint: "从相遇开始，沿着乐队的足迹", extraHint: "主线之外，故事仍在继续", category: "故事类型", collection: "故事目录", cast: "登场角色",
  band: "乐队故事", viewpoint: "视角故事", friendship: "角色羁绊故事",
  bandHint: "五支乐队的故事与番外", viewpointHint: "走进角色眼中的另一面", friendshipHint: "两个人，一点点靠近的日常",
  all: "全部故事", search: "搜索标题、角色、章节", bandFilter: "乐队", character: "角色", allBands: "全部乐队", allCharacters: "全部角色",
  results: "篇故事", lines: "条对白", extra: "番外", episode: "第", episodeEnd: "话", read: "阅读故事", clear: "清除筛选",
  noResults: "没有符合条件的故事", tryAgain: "试试其他关键词，或清除筛选条件。",
  unavailable: "这个服务器版本尚未接入剧情正文。", back: "返回剧情目录", previous: "上一篇", next: "下一篇",
  narration: "旁白", subtitle: "字幕", chat: "聊天消息", stamp: "贴图（文字版未展示）", start: "开始阅读",
  directory: "本组目录", bondLevel: "羁绊等级", textOnly: "文字版", notice: "按游戏中的顺序整理对白、聊天和字幕。",
  source: "来源与限制", sourceNote: "剧情文字来自所选服务器的游戏内容。这里提供文字阅读，不包含画面、动作和声音，聊天贴图以文字提示代替。",
  font: "文字大小", normal: "标准", large: "大字", end: "本话完", group: "同组故事", top: "回到顶部"
};
type Copy = Record<keyof typeof zh, string>;
const en: Copy = {
  title: "Stories", intro: "Five bands. Twenty-five perspectives. Read their stories, one conversation at a time.",
  main: "Band main stories", extraStory: "Band extra stories", mainHint: "Follow each band from the beginning", extraHint: "More moments beyond the main story", category: "Story type", collection: "Story collection", cast: "Characters",
  band: "Band stories", viewpoint: "Viewpoint stories", friendship: "Bond stories",
  bandHint: "Band chapters and extra episodes", viewpointHint: "Another side of each character", friendshipHint: "Small moments that bring two people closer",
  all: "All stories", search: "Search titles, characters, chapters", bandFilter: "Band", character: "Character", allBands: "All bands", allCharacters: "All characters",
  results: "stories", lines: "lines", extra: "Extra", episode: "Episode ", episodeEnd: "", read: "Read story", clear: "Clear filters",
  noResults: "No matching stories", tryAgain: "Try another keyword or clear the filters.",
  unavailable: "Story text is not available for this server release yet.", back: "Story directory", previous: "Previous", next: "Next",
  narration: "Narration", subtitle: "Subtitle", chat: "Chat message", stamp: "Sticker (not shown in text edition)", start: "Start reading",
  directory: "In this collection", bondLevel: "Bond level", textOnly: "Text edition", notice: "Dialogue, chat and subtitles follow their order in the game.",
  source: "Sources & limitations", sourceNote: "Story text comes from the selected game server. This reading edition omits visuals, motion and audio; chat stickers are described in text.",
  font: "Text size", normal: "Standard", large: "Large", end: "End of episode", group: "Related stories", top: "Back to top"
};
const tw: Copy = { ...zh, title: "劇情故事", intro: "從樂隊的相遇，到每個人眼中的故事。按原始對白順序，慢慢讀下去。",
  main: "樂隊主線", extraStory: "樂隊額外故事", mainHint: "從相遇開始，沿著樂隊的足跡", extraHint: "主線之外，故事仍在繼續", category: "故事類型", collection: "故事目錄", cast: "登場角色",
  band: "樂隊故事", viewpoint: "視角故事", friendship: "角色羈絆故事", bandHint: "五支樂隊的故事與番外", viewpointHint: "走進角色眼中的另一面", friendshipHint: "兩個人，一點點靠近的日常",
  search: "搜尋標題、角色、章節", bandFilter: "樂隊", allBands: "全部樂隊", lines: "條對白", episodeEnd: "話", read: "閱讀故事", clear: "清除篩選",
  noResults: "沒有符合條件的故事", tryAgain: "試試其他關鍵詞，或清除篩選條件。", unavailable: "這個伺服器版本尚未接入劇情正文。", back: "返回劇情目錄",
  narration: "旁白", subtitle: "字幕", chat: "聊天訊息", stamp: "貼圖（文字版未展示）", start: "開始閱讀", directory: "本組目錄", bondLevel: "羈絆等級",
  notice: "按遊戲中的順序整理對白、聊天和字幕。", source: "來源與限制", sourceNote: "劇情文字來自所選伺服器的遊戲內容。這裡提供文字閱讀，不包含畫面、動作和聲音，聊天貼圖以文字提示代替。", end: "本話完", group: "同組故事", top: "回到頂部" };
const ja: Copy = { ...en, title: "ストーリー", intro: "バンドの出会いから、一人ひとりの視点へ。会話を順に、ゆっくり読み進めよう。",
  main: "バンドメイン", extraStory: "バンド追加ストーリー", mainHint: "出会いから、バンドの足跡をたどる", extraHint: "本編の先にも、物語は続く", category: "ストーリーの種類", collection: "ストーリー一覧", cast: "登場キャラクター",
  band: "バンドストーリー", viewpoint: "視点ストーリー", friendship: "キズナストーリー", bandHint: "5つのバンドの物語と番外編", viewpointHint: "キャラクターのもうひとつの視点", friendshipHint: "二人の距離が近づく日常",
  all: "すべて", search: "タイトル・キャラクター・章を検索", bandFilter: "バンド", character: "キャラクター", allBands: "すべてのバンド", allCharacters: "すべてのキャラクター", results: "話", lines: "行", extra: "番外編", episode: "第", episodeEnd: "話", read: "読む", clear: "絞り込みを解除",
  noResults: "該当するストーリーはありません", tryAgain: "検索条件を変更してください。", unavailable: "このサーバーのバージョンでは本文がまだ利用できません。", back: "ストーリー一覧", previous: "前の話", next: "次の話",
  narration: "ナレーション", subtitle: "字幕", chat: "チャット", stamp: "スタンプ（テキスト版では非表示）", start: "読み始める", directory: "このシリーズ", bondLevel: "キズナレベル", textOnly: "テキスト版", notice: "会話・チャット・字幕をゲーム内の順番で掲載しています。",
  source: "出典と注意事項", sourceNote: "選択したサーバーのゲーム内の物語を掲載しています。テキスト版のため、映像・動作・音声は含みません。スタンプは説明文で表示します。", font: "文字サイズ", normal: "標準", large: "大きい", end: "この話はここまで", group: "同じシリーズ", top: "先頭へ" };
export const storyCopy: Copy = ({ "zh-CN": zh, "zh-TW": tw, ja, en })[activeReleaseContext.locale];
export function episodeLabel(entry: TextStoryEntry): string {
  if (entry.eventSection === "another") return `Another · ${storyCopy.episode}${entry.episodeNumber}${storyCopy.episodeEnd}`;
  return `${entry.isExtra ? `${storyCopy.extra} · ` : ""}${storyCopy.episode}${entry.episodeNumber}${storyCopy.episodeEnd}`;
}

export function storyKindLabel(kind: StoryKind): string {
  if (kind === "event") return eventCopy(activeReleaseContext.locale).stories;
  return kind === "extra" ? storyCopy.extraStory : storyCopy[kind];
}
