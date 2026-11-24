const SENTENCE_END = /[。！？!?\u2026—~～』」）】"']$/;
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;

const TIME_BREAK_PATTERN =
  /(?:\d+\s*(?:秒|分|分钟|分鐘|小时|小時|時間|日|天|周|週|週間|个月|個月|か月|ヶ月|年)\s*(?:前|后|後))|(?:数|數|几|幾|一|二|两|兩|三|四|五|半)?(?:秒|分钟|分鐘|小时|小時|時間|日|天|周|週|週間|个月|個月|年)(?:前|后|後)$|(?:^(?:次日|翌日|第二天|隔天|当天|當天|当日|當日|某日|某天|几天后|數日後|数日后|不久后|不久後|片刻后|片刻後|稍后|稍後|那之后|那之後|从那以后|從那以後|与此同时|與此同時|此时|此時|当时|當時|深夜|清晨|傍晚|黄昏|黃昏|早晨|中午|午后|午後|夜晚|放学后|放學後|ある日|ある休日|翌日|数日後|数分後|数時間後|その後|お買い物当日))|(?:\b(?:later|ago|next day|meanwhile|morning|afternoon|evening|night|midnight|days? later|hours? later|minutes? later|weeks? later|years? ago)\b)|(?:(?:ライブ|セッション|練習|本番|公演|演出)(?:前|後|后|当日|当天|から))/i;

/**
 * Classify a `location` ADV command into `"time"` (temporal jump) vs `"location"` (place change).
 */
export function classifySceneBreak(text) {
  const value = String(text ?? "").trim();
  if (!value) return "location";
  return TIME_BREAK_PATTERN.test(value) ? "time" : "location";
}

/**
 * Normalize hard Unity ADV dialog-box width wraps while preserving intentional
 * sentence/paragraph breaks and subtitle/lyric line breaks.
 */
export function formatStoryLineText(text, kind = "dialogue") {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!raw || kind === "subtitle" || kind === "location" || kind === "stamp") {
    return raw;
  }
  const paragraphs = raw.split(/\n{2,}/);
  return paragraphs
    .map(paragraph => {
      const lines = paragraph.split("\n").map(part => part.trim()).filter(Boolean);
      if (lines.length <= 1) return lines[0] ?? "";
      let result = lines[0];
      for (let i = 1; i < lines.length; i++) {
        const prev = result;
        const next = lines[i];
        if (SENTENCE_END.test(prev)) {
          result += "\n" + next;
        } else {
          const prevChar = prev[prev.length - 1] || "";
          const nextChar = next[0] || "";
          const joiner = CJK_CHAR.test(prevChar) || CJK_CHAR.test(nextChar) ? "" : " ";
          result += joiner + next;
        }
      }
      return result;
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Group rendered story items into visual staging blocks:
 * - Consecutive `chat` / `stamp` lines become a single `chat-stage` block
 * - Consecutive `subtitle` lines become a single `subtitle-stage` block
 * - All other lines remain individual `line` blocks
 * Also computes `isContinuation` for consecutive lines by the same speaker,
 * and `sceneKind` ("time" | "location") for `location` breaks.
 */
export function groupStoryBlocks(items) {
  const blocks = [];
  let prevSpeaker = "";
  let prevKind = "";
  let prevIsMessage = false;

  for (const item of items) {
    const isChatKind = item.kind === "chat" || item.kind === "stamp";
    const isSubtitleKind = item.kind === "subtitle";
    const isMessage = Boolean(item.speaker) && item.kind !== "location" && item.kind !== "narration" && !isSubtitleKind;
    const isContinuation =
      (isMessage || (isSubtitleKind && Boolean(item.speaker))) &&
      prevIsMessage === isMessage &&
      item.speaker === prevSpeaker &&
      (isChatKind ? prevKind === "chat" || prevKind === "stamp" : prevKind === item.kind);

    const enriched = {
      ...item,
      isMessage,
      isContinuation,
      sceneKind: item.kind === "location" ? classifySceneBreak(item.text ?? item.formattedText) : undefined,
    };

    prevIsMessage = isMessage;
    prevSpeaker = isMessage || isSubtitleKind ? item.speaker : "";
    prevKind = item.kind;

    if (isChatKind) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === "chat-stage") {
        last.items.push(enriched);
      } else {
        blocks.push({ type: "chat-stage", items: [enriched] });
      }
    } else if (isSubtitleKind) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === "subtitle-stage") {
        last.items.push(enriched);
      } else {
        blocks.push({ type: "subtitle-stage", items: [enriched] });
      }
    } else {
      blocks.push({ type: "line", item: enriched });
    }
  }

  // Enrich chat-stage blocks with participant list & right-aligned self speaker for 2-person chats
  for (const block of blocks) {
    if (block.type === "chat-stage") {
      const participants = [...new Set(block.items.map(i => i.speaker).filter(Boolean))];
      block.participants = participants;
      const rightSpeaker = participants.length === 2 ? participants[1] : null;
      for (const item of block.items) {
        item.chatSide = rightSpeaker && item.speaker === rightSpeaker ? "right" : "left";
      }
    }
  }
  return blocks;
}
