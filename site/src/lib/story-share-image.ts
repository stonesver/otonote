import { readThemePalette } from "./theme-palette.mjs";
import { shareImageHeight, wrapStoryText } from "./story-share-layout.mjs";

export interface ShareLine {
  kind: string; speaker: string; text: string; avatar: string; accent: string;
}
export interface ShareImageInput {
  title: string; chapter: string; category: string; excerpt: string;
  range: string; source: string; accent: string; font: string; lines: ShareLine[];
}

// A dedicated canvas keeps exports independent of viewport, scroll and lazy images.
export async function createStoryImage(input: ShareImageInput) {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const width = 540;
  const bodyFont = `16px ${input.font}`;
  const smallFont = `12px ${input.font}`;
  const nameFont = `600 12px ${input.font}`;
  const titleFont = `600 25px ${input.font}`;
  const wrap = (text: string, font: string, max: number) => {
    ctx.font = font;
    return wrapStoryText(text, max, (value: string) => ctx.measureText(value).width) as string[];
  };
  const title = wrap(input.title, titleFont, 460);
  const chapter = wrap(input.chapter, smallFont, 460);
  const category = wrap(input.category, smallFont, 460);
  const range = wrap(input.range, smallFont, 460);
  const headerHeight = 86 + category.length * 19 + chapter.length * 19 + title.length * 35 + range.length * 19;
  const rows = input.lines.map(line => {
    const message = Boolean(line.speaker) && !["location", "narration"].includes(line.kind);
    const text = wrap(line.text, bodyFont, message ? 370 : 440);
    const names = line.speaker ? wrap(line.speaker, nameFont, message ? 394 : 440) : [];
    return { ...line, message, text, names, height: names.length * 18 + text.length * 27 + 32 };
  });
  const source = wrap(input.source, `10px ${input.font}`, 460);
  const height = shareImageHeight(headerHeight, rows.map(row => row.height), 88 + source.length * 16);
  const images = new Map<string, HTMLImageElement | null>();
  await Promise.all([...new Set(input.lines.map(line => line.avatar).filter(Boolean))].map(async url => {
    images.set(url, await loadAvatar(url));
  }));
  const missingAvatars = [...images.values()].some(image => !image);
  canvas.width = width * 2;
  canvas.height = height * 2;
  const palette = readThemePalette();
  ctx.scale(2, 2);
  ctx.fillStyle = palette.canvas;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = input.accent;
  ctx.fillRect(0, 0, width, 6);
  const textBlock = (lines: string[], x: number, y: number, lineHeight: number, font: string, color: string) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = "top";
    for (const text of lines) { ctx.fillText(text, x, y); y += lineHeight; }
    return y;
  };
  const rule = (y: number) => {
    ctx.fillStyle = palette.border;
    ctx.fillRect(40, y, 460, 1);
  };
  textBlock([`OTONOTE  /  ${input.excerpt}`], 40, 30, 18, nameFont, palette.muted);
  let y = textBlock(category, 40, 60, 19, smallFont, input.accent);
  y = textBlock(chapter, 40, y + 8, 19, smallFont, palette.muted);
  y = textBlock(title, 40, y + 4, 35, titleFont, palette.text);
  textBlock(range, 40, y + 8, 19, smallFont, palette.muted);
  rule(headerHeight - 12);
  y = headerHeight;
  for (const row of rows) {
    if (row.message) {
      const image = images.get(row.avatar);
      ctx.save();
      ctx.beginPath(); ctx.arc(54, y + 20, 19, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = palette.surfaceDeep; ctx.fillRect(35, y + 1, 38, 38);
      if (image) ctx.drawImage(image, 35, y + 1, 38, 38);
      else {
        ctx.textAlign = "center";
        const initials = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(row.speaker)].slice(0, 2).map(item => item.segment).join("");
        textBlock([initials], 54, y + 13, 16, `11px ${input.font}`, palette.secondaryInk);
      }
      ctx.restore();
      const nameBottom = textBlock(row.names, 88, y + 2, 18, nameFont, palette.textSoft);
      const bubbleY = nameBottom + 4;
      ctx.font = bodyFont;
      const bubbleWidth = Math.min(394, Math.max(48, ...row.text.map(text => ctx.measureText(text).width + 24)));
      ctx.beginPath(); ctx.roundRect(88, bubbleY, bubbleWidth, row.text.length * 27 + 16, [3, 10, 10, 10]);
      ctx.fillStyle = row.kind === "chat" ? palette.surfaceDeep : palette.surface; ctx.fill();
      textBlock(row.text, 100, bubbleY + 8, 27, bodyFont, palette.text);
    } else {
      ctx.textAlign = "center";
      const labelBottom = textBlock(row.names, width / 2, y + 12, 18, nameFont, palette.muted);
      textBlock(row.text, width / 2, labelBottom, 27, bodyFont, palette.muted);
      ctx.textAlign = "left";
    }
    y += row.height;
  }
  rule(y + 10);
  textBlock([`OtoNote · BanG Dream! Our Notes`], 40, y + 28, 18, nameFont, palette.textSoft);
  textBlock(source, 40, y + 52, 16, `10px ${input.font}`, palette.muted);
  try {
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG encoding failed")), "image/png"));
    return { blob, width: canvas.width, height: canvas.height, missingAvatars };
  } finally {
    // Release backing storage after the browser finishes encoding.
    canvas.width = 1; canvas.height = 1;
  }
}

function loadAvatar(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const finish = (value: HTMLImageElement | null) => {
      clearTimeout(timer); image.onload = null; image.onerror = null; resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 5000);
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = url;
  });
}
