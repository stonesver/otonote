import { readThemePalette } from "./theme-palette.mjs";
import { shareImageHeight, wrapStoryText } from "./story-share-layout.mjs";

export interface ShareLine {
  kind: string; speaker: string; text: string; avatar: string; accent: string;
}
export interface ShareImageInput {
  title: string; chapter: string; category: string; excerpt: string;
  range: string; source: string; accent: string; font: string;
  cardTheme?: "light" | "dark";
  lines: ShareLine[];
}

interface CardPalette {
  backdrop: string;
  card: string;
  cardBorder: string;
  chatSurface: string;
  avatarBg: string;
  text: string;
  textSoft: string;
  muted: string;
  divider: string;
  accentFallback: string;
}

function resolveCardPalette(cardTheme?: "light" | "dark"): CardPalette {
  if (cardTheme === "light") {
    return {
      backdrop: "#f2efe9",
      card: "#fcfbf9",
      cardBorder: "#e4dfd6",
      chatSurface: "#f3f1ec",
      avatarBg: "#ece8e0",
      text: "#1d1c1a",
      textSoft: "#4a4742",
      muted: "#7a756c",
      divider: "#e7e2d9",
      accentFallback: "#4a6380",
    };
  }
  if (cardTheme === "dark") {
    return {
      backdrop: "#111317",
      card: "#191c22",
      cardBorder: "#292e38",
      chatSurface: "#22262f",
      avatarBg: "#252933",
      text: "#eceef2",
      textSoft: "#c4cbd6",
      muted: "#9aa3b5",
      divider: "#272c36",
      accentFallback: "#7ca4d6",
    };
  }
  const palette = readThemePalette();
  return {
    backdrop: palette.canvas,
    card: palette.surface,
    cardBorder: palette.border,
    chatSurface: palette.surfaceDeep,
    avatarBg: palette.surfaceDeep,
    text: palette.text,
    textSoft: palette.textSoft,
    muted: palette.muted,
    divider: palette.border,
    accentFallback: palette.secondaryInk,
  };
}

// A dedicated 2x canvas keeps exports independent of viewport, scroll and lazy images.
export async function createStoryImage(input: ShareImageInput) {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  const width = 560;
  const padX = 24;
  const padY = 24;
  const innerX = padX + 28;
  const innerWidth = width - innerX * 2; // 456px

  const bodyFont = `16px ${input.font}`;
  const narrationFont = `italic 15px ${input.font}`;
  const smallFont = `12px ${input.font}`;
  const kickerFont = `600 12px ${input.font}`;
  const nameFont = `600 13px ${input.font}`;
  const titleFont = `700 23px ${input.font}`;
  const sourceFont = `11px ${input.font}`;

  const wrap = (text: string, font: string, max: number) => {
    ctx.font = font;
    return wrapStoryText(text, max, (value: string) => ctx.measureText(value).width) as string[];
  };

  const title = wrap(input.title, titleFont, innerWidth);
  const chapterMeta = [input.chapter, input.range].filter(Boolean).join("  ·  ");
  const chapter = chapterMeta ? wrap(chapterMeta, smallFont, innerWidth) : [];
  const category = input.category ? wrap(input.category, kickerFont, innerWidth) : [];

  const headerHeight = padY + 34 + (category.length ? category.length * 18 + 8 : 0) + title.length * 32 + (chapter.length ? chapter.length * 18 + 10 : 0) + 22;

  const messageTextX = innerX + 48;
  const messageMaxWidth = innerWidth - 48; // 408px
  let prevSpeaker = "";
  let prevWasMessage = false;

  const rows = input.lines.map((line, index) => {
    const message = Boolean(line.speaker) && !["location", "narration"].includes(line.kind);
    const continuation = message && prevWasMessage && line.speaker === prevSpeaker;
    const isChat = message && line.kind === "chat";
    const isLocation = line.kind === "location";

    prevWasMessage = message;
    prevSpeaker = message ? line.speaker : "";

    if (message) {
      const textMax = isChat ? messageMaxWidth - 28 : messageMaxWidth;
      const text = wrap(line.text, bodyFont, textMax);
      const names = !continuation && line.speaker ? wrap(line.speaker, nameFont, messageMaxWidth - 14) : [];
      const topGap = continuation ? 6 : index === 0 ? 6 : 16;
      const nameBlock = names.length ? names.length * 19 + 4 : 0;
      const textBlockHeight = text.length * 26 + (isChat ? 18 : 0);
      const minAvatarHeight = continuation ? 0 : 38;
      const height = topGap + Math.max(minAvatarHeight, nameBlock + textBlockHeight) + 4;
      return { ...line, message, continuation, isChat, isLocation, text, names, topGap, height };
    }

    if (isLocation) {
      const text = wrap(line.text, kickerFont, innerWidth - 72);
      const topGap = index === 0 ? 8 : 20;
      const height = topGap + text.length * 20 + 14;
      return { ...line, message: false, continuation: false, isChat: false, isLocation: true, text, names: [] as string[], topGap, height };
    }

    const text = wrap(line.text, narrationFont, innerWidth - 24);
    const names = line.speaker ? wrap(line.speaker, smallFont, innerWidth - 24) : [];
    const topGap = index === 0 ? 8 : 16;
    const height = topGap + (names.length ? names.length * 18 + 4 : 0) + text.length * 25 + 10;
    return { ...line, message: false, continuation: false, isChat: false, isLocation: false, text, names, topGap, height };
  });

  const cleanSource = input.source.replace(/^https?:\/\//, "");
  const source = wrap(cleanSource, sourceFont, innerWidth);
  const footerHeight = 28 + 22 + source.length * 16 + 24 + padY;
  const height = shareImageHeight(headerHeight, rows.map(row => row.height), footerHeight);

  const images = new Map<string, HTMLImageElement | null>();
  await Promise.all([...new Set(input.lines.map(line => line.avatar).filter(Boolean))].map(async url => {
    images.set(url, await loadAvatar(url));
  }));
  const missingAvatars = [...images.values()].some(image => !image);

  canvas.width = width * 2;
  canvas.height = height * 2;
  const p = resolveCardPalette(input.cardTheme);
  const accent = input.accent || p.accentFallback;

  ctx.scale(2, 2);

  // Outer backdrop
  ctx.fillStyle = p.backdrop;
  ctx.fillRect(0, 0, width, height);

  // Editorial rounded card
  const cardX = padX;
  const cardY = padY;
  const cardW = width - padX * 2;
  const cardH = height - padY * 2;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 16);
  ctx.fillStyle = p.card;
  ctx.fill();
  ctx.clip();

  // Top band accent bar inside clipped card
  ctx.fillStyle = accent;
  ctx.fillRect(cardX, cardY, cardW, 4);
  ctx.restore();

  // Subtle card border
  ctx.beginPath();
  ctx.roundRect(cardX + 0.5, cardY + 0.5, cardW - 1, cardH - 1, 16);
  ctx.strokeStyle = p.cardBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  const textBlock = (lines: string[], x: number, y: number, lineHeight: number, font: string, color: string) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = "top";
    for (const text of lines) {
      ctx.fillText(text, x, y);
      y += lineHeight;
    }
    return y;
  };

  const rule = (y: number) => {
    ctx.fillStyle = p.divider;
    ctx.fillRect(innerX, y, innerWidth, 1);
  };

  // Header
  let y = cardY + 26;
  ctx.font = kickerFont;
  ctx.fillStyle = p.muted;
  ctx.textBaseline = "top";
  ctx.fillText(`OTONOTE  ·  ${input.excerpt}`, innerX, y);
  y += 24;

  if (category.length) {
    y = textBlock(category, innerX, y, 18, kickerFont, accent) + 6;
  }
  y = textBlock(title, innerX, y, 32, titleFont, p.text);
  if (chapter.length) {
    y = textBlock(chapter, innerX, y + 6, 18, smallFont, p.muted);
  }
  rule(headerHeight - 8);

  // Transcript rows
  y = headerHeight;
  for (const row of rows) {
    const rowY = y + row.topGap;
    if (row.message) {
      if (!row.continuation) {
        const image = images.get(row.avatar);
        const cx = innerX + 18;
        const cy = rowY + 19;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, 18, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = p.avatarBg;
        ctx.fillRect(innerX, rowY + 1, 36, 36);
        if (image) {
          ctx.drawImage(image, innerX, rowY + 1, 36, 36);
        } else {
          ctx.textAlign = "center";
          const initials = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(row.speaker)]
            .slice(0, 2)
            .map(item => item.segment)
            .join("");
          textBlock([initials], cx, rowY + 12, 16, `600 11px ${input.font}`, p.textSoft);
          ctx.textAlign = "left";
        }
        ctx.restore();

        // Speaker color dot + name
        ctx.beginPath();
        ctx.arc(messageTextX + 3, rowY + 8, 3, 0, Math.PI * 2);
        ctx.fillStyle = row.accent || accent;
        ctx.fill();
        const nameBottom = textBlock(row.names, messageTextX + 11, rowY + 1, 19, nameFont, p.textSoft);
        const contentY = nameBottom + 4;

        if (row.isChat) {
          ctx.font = bodyFont;
          const bubbleW = Math.min(messageMaxWidth, Math.max(52, ...row.text.map(t => ctx.measureText(t).width + 26)));
          ctx.beginPath();
          ctx.roundRect(messageTextX, contentY, bubbleW, row.text.length * 26 + 16, [4, 12, 12, 12]);
          ctx.fillStyle = p.chatSurface;
          ctx.fill();
          textBlock(row.text, messageTextX + 13, contentY + 8, 26, bodyFont, p.text);
        } else {
          textBlock(row.text, messageTextX, contentY, 26, bodyFont, p.text);
        }
      } else {
        if (row.isChat) {
          ctx.font = bodyFont;
          const bubbleW = Math.min(messageMaxWidth, Math.max(52, ...row.text.map(t => ctx.measureText(t).width + 26)));
          ctx.beginPath();
          ctx.roundRect(messageTextX, rowY, bubbleW, row.text.length * 26 + 16, [4, 12, 12, 12]);
          ctx.fillStyle = p.chatSurface;
          ctx.fill();
          textBlock(row.text, messageTextX + 13, rowY + 8, 26, bodyFont, p.text);
        } else {
          textBlock(row.text, messageTextX, rowY, 26, bodyFont, p.text);
        }
      }
    } else if (row.isLocation) {
      ctx.font = kickerFont;
      const labelW = Math.min(innerWidth - 72, Math.max(40, ...row.text.map(t => ctx.measureText(t).width)));
      const midY = rowY + (row.text.length * 20) / 2 - 2;
      const sideW = Math.max(16, (innerWidth - labelW - 24) / 2);
      ctx.fillStyle = p.divider;
      ctx.fillRect(innerX, midY, sideW, 1);
      ctx.fillRect(innerX + innerWidth - sideW, midY, sideW, 1);
      ctx.textAlign = "center";
      textBlock(row.text, width / 2, rowY, 20, kickerFont, p.muted);
      ctx.textAlign = "left";
    } else {
      ctx.fillStyle = p.divider;
      ctx.fillRect(innerX + 2, rowY + 2, 2, Math.max(20, row.height - row.topGap - 14));
      let ny = rowY;
      if (row.names.length) {
        ny = textBlock(row.names, innerX + 14, ny, 18, smallFont, p.muted) + 3;
      }
      textBlock(row.text, innerX + 14, ny, 25, narrationFont, p.textSoft);
    }
    y += row.height;
  }

  // Footer
  const footerRuleY = y + 18;
  rule(footerRuleY);
  textBlock(["OtoNote · BanG Dream! Our Notes"], innerX, footerRuleY + 16, 18, kickerFont, p.textSoft);
  textBlock(source, innerX, footerRuleY + 38, 16, sourceFont, p.muted);

  try {
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(value => (value ? resolve(value) : reject(new Error("PNG encoding failed"))), "image/png"),
    );
    return { blob, width: canvas.width, height: canvas.height, missingAvatars };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

function loadAvatar(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const finish = (value: HTMLImageElement | null) => {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 5000);
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = url;
  });
}
