import { readThemePalette } from "./theme-palette.mjs";
import { MAX_SHARE_LINES, selectedRange } from "./story-share-layout.mjs";
import type { StoryShareCopy } from "./story-share-copy";
import type { ShareLine } from "./story-share-image";

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none;left:-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function flashFeedback(button: HTMLElement, label?: string) {
  const original = button.dataset.origLabel ?? button.textContent ?? "";
  if (!button.dataset.origLabel) button.dataset.origLabel = original;
  button.setAttribute("data-copied", "true");
  if (label) {
    const span = button.querySelector("span");
    if (span) span.textContent = label;
    else button.textContent = label;
  }
  window.clearTimeout(Number(button.dataset.copyTimer || 0));
  const timer = window.setTimeout(() => {
    button.removeAttribute("data-copied");
    if (label) {
      const span = button.querySelector("span");
      if (span) span.textContent = original;
      else button.textContent = original;
    }
  }, 1600);
  button.dataset.copyTimer = String(timer);
}

export function setupStoryShare(reader: HTMLElement) {
  const copy: StoryShareCopy = JSON.parse(reader.dataset.shareCopy!);
  const find = <T extends HTMLElement>(selector: string) => reader.querySelector<T>(selector)!;
  const maybe = <T extends HTMLElement>(selector: string) => reader.querySelector<T>(selector);

  const toggle = find<HTMLButtonElement>("[data-share-toggle]");
  const panel = find<HTMLElement>(".st-selection");
  const status = find<HTMLElement>("[data-selection-status]");
  const hint = find<HTMLElement>("[data-selection-hint]");
  const error = find<HTMLElement>("[data-selection-error]");
  const generate = find<HTMLButtonElement>("[data-selection-generate]");
  const copyRangeBtn = maybe<HTMLButtonElement>("[data-selection-copy]");
  const cancelBtn = maybe<HTMLButtonElement>("[data-selection-cancel]");
  const reset = find<HTMLButtonElement>("[data-selection-reset]");
  const popover = maybe<HTMLElement>("[data-selection-popover]");
  const popCard = maybe<HTMLButtonElement>("[data-pop-card]");
  const popCopy = maybe<HTMLButtonElement>("[data-pop-copy]");
  const popLink = maybe<HTMLButtonElement>("[data-pop-link]");
  const dialog = find<HTMLDialogElement>("[data-share-dialog]");
  const preview = find<HTMLImageElement>("[data-share-image]");
  const save = find<HTMLAnchorElement>("[data-share-save]");
  const copyImageBtn = maybe<HTMLButtonElement>("[data-share-copy-image]");
  const native = find<HTMLButtonElement>("[data-share-native]");
  const result = find<HTMLElement>("[data-share-result]");
  const shareError = find<HTMLElement>("[data-share-error]");
  const themeButtons = [...reader.querySelectorAll<HTMLButtonElement>("[data-share-theme]")];
  const lines = [...reader.querySelectorAll<HTMLElement>("[data-story-line]")];

  let active = false;
  let anchor: number | null = null;
  let end: number | null = null;
  let busy = false;
  let generation = 0;
  let objectUrl = "";
  let currentBlob: Blob | null = null;
  let file: File | null = null;
  let cardTheme: "light" | "dark" =
    document.documentElement.dataset.theme === "night" ? "dark" : "light";

  const range = () => selectedRange(anchor, end ?? anchor);
  const describe = (value: { start: number; end: number; count: number }) =>
    copy.chosen
      .replace("{start}", String(value.start + 1))
      .replace("{end}", String(value.end + 1))
      .replace("{count}", String(value.count));
  const showError = (node: HTMLElement, message = "") => {
    node.textContent = message;
    node.hidden = !message;
  };
  const releaseImage = () => {
    preview.removeAttribute("src");
    save.removeAttribute("href");
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    currentBlob = null;
    file = null;
  };

  const lineText = (line: HTMLElement) =>
    (line.querySelector(".st-line-text, .st-message > p, .st-system-message > p, h2 span")?.textContent || "").trim();

  const formatLinesAsText = (slice: HTMLElement[], startLineId: string) => {
    const title = (find<HTMLElement>("h1").textContent || "").trim();
    const chapter = (maybe<HTMLElement>(".st-reader-subtitle")?.textContent || "").trim();
    const body = slice
      .map(line => {
        const speaker = (line.dataset.storySpeaker || "").trim();
        const text = lineText(line);
        if (!text) return "";
        if (line.dataset.lineKind === "location") return `【${text}】`;
        return speaker ? `${speaker}：「${text}」` : text;
      })
      .filter(Boolean)
      .join("\n");
    const header = chapter ? `《${title}》（${chapter}）` : `《${title}》`;
    const url = `${location.origin}${location.pathname}#${startLineId}`;
    return `${body}\n\n—— ${header}\n${url}`;
  };

  const syncThemeButtons = () => {
    themeButtons.forEach(btn => {
      btn.setAttribute("aria-pressed", String(btn.dataset.shareTheme === cardTheme));
    });
  };
  syncThemeButtons();

  const update = () => {
    const selected = range();
    panel.hidden = !active;
    reader.toggleAttribute("data-selecting", active);
    reader.setAttribute("aria-busy", String(busy));
    toggle.setAttribute("aria-pressed", String(active));
    const toggleSpan = toggle.querySelector("span");
    if (toggleSpan) toggleSpan.textContent = active ? copy.cancel : copy.select;
    hint.textContent = anchor !== null && end === null ? copy.chooseEnd : copy.hint;
    status.textContent = selected ? describe(selected) : copy.empty;
    generate.disabled = busy || !selected || selected.count > MAX_SHARE_LINES;
    generate.textContent = busy ? copy.busy : copy.generate;
    if (copyRangeBtn) copyRangeBtn.disabled = busy || !selected;
    reset.disabled = busy || !selected;
    lines.forEach((line, index) => {
      const selectedLine = Boolean(active && selected && index >= selected.start && index <= selected.end);
      line.toggleAttribute("data-selected", selectedLine);
      const button = line.querySelector<HTMLButtonElement>("[data-select-line]");
      if (button) {
        button.setAttribute("aria-pressed", String(selectedLine));
        button.disabled = busy;
      }
    });
    showError(error, selected && selected.count > MAX_SHARE_LINES ? copy.limit : "");
  };

  const cancel = () => {
    generation++;
    busy = false;
    active = false;
    anchor = null;
    end = null;
    update();
    toggle.focus({ preventScroll: true });
  };

  const renderCard = async (openModal: boolean) => {
    const selected = range();
    if (!selected || selected.count > MAX_SHARE_LINES || busy) return;
    const request = ++generation;
    busy = true;
    update();
    try {
      const palette = readThemePalette(reader);
      const content: ShareLine[] = lines.slice(selected.start, selected.end + 1).map(line => ({
        kind: line.dataset.lineKind || "dialogue",
        speaker: line.dataset.storySpeaker || "",
        text: lineText(line),
        avatar: line.querySelector<HTMLImageElement>(".st-avatar img")?.src || "",
        accent: getComputedStyle(line).getPropertyValue("--speaker-accent").trim() || palette.secondaryInk,
      }));
      const { createStoryImage } = await import("./story-share-image");
      if (request !== generation) return;
      const image = await createStoryImage({
        title: (find<HTMLElement>("h1").textContent || "").trim(),
        chapter: (maybe<HTMLElement>(".st-reader-subtitle")?.textContent || "").trim(),
        category: [...reader.querySelectorAll(".st-reader-kicker > span")]
          .map(node => (node.textContent || "").trim())
          .filter(Boolean)
          .join(" · "),
        excerpt: copy.excerpt,
        range: describe(selected),
        source: `${location.origin}${location.pathname}#${lines[selected.start].id}`,
        accent: getComputedStyle(reader).getPropertyValue("--band-accent").trim() || palette.secondaryInk,
        font: getComputedStyle(reader).fontFamily,
        cardTheme,
        lines: content,
      });
      if (request !== generation) return;
      releaseImage();
      currentBlob = image.blob;
      objectUrl = URL.createObjectURL(image.blob);
      const filename = `OtoNote-${reader.dataset.storyId}-${selected.start + 1}-${selected.end + 1}.png`;
      file = new File([image.blob], filename, { type: "image/png" });
      preview.src = objectUrl;
      preview.width = image.width;
      preview.height = image.height;
      save.href = objectUrl;
      save.download = filename;
      native.hidden = !(typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }));
      if (copyImageBtn) {
        copyImageBtn.hidden = !(typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined");
      }
      result.textContent = `${copy.ready} · ${image.width} × ${image.height}${image.missingAvatars ? ` · ${copy.avatarFallback}` : ""}`;
      showError(shareError);
      if (openModal && !dialog.open) {
        dialog.showModal();
        document.body.classList.add("st-share-open");
      }
    } catch (failure) {
      if (request === generation) {
        showError(openModal ? error : shareError, failure instanceof RangeError ? copy.tooTall : copy.error);
      }
    } finally {
      if (request === generation) {
        busy = false;
        reader.setAttribute("aria-busy", "false");
        generate.disabled = false;
        generate.textContent = copy.generate;
        if (copyRangeBtn) copyRangeBtn.disabled = false;
        reset.disabled = false;
        lines.forEach(line => {
          const btn = line.querySelector<HTMLButtonElement>("[data-select-line]");
          if (btn) btn.disabled = false;
        });
      }
    }
  };

  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    if (active) {
      cancel();
      return;
    }
    cardTheme = document.documentElement.dataset.theme === "night" ? "dark" : "light";
    syncThemeButtons();
    active = true;
    update();
  });

  // Transcript click: either selection mode OR line-level quick actions
  reader.querySelector(".st-transcript")!.addEventListener("click", async event => {
    if (!(event.target instanceof Element)) return;

    const lineCopyBtn = event.target.closest<HTMLButtonElement>("[data-line-copy]");
    if (lineCopyBtn) {
      event.stopPropagation();
      const line = lineCopyBtn.closest<HTMLElement>("[data-story-line]");
      if (line) {
        const ok = await copyTextToClipboard(formatLinesAsText([line], line.id));
        if (ok) flashFeedback(lineCopyBtn);
      }
      return;
    }

    const lineLinkBtn = event.target.closest<HTMLButtonElement>("[data-line-link]");
    if (lineLinkBtn) {
      event.stopPropagation();
      const line = lineLinkBtn.closest<HTMLElement>("[data-story-line]");
      if (line) {
        const url = `${location.origin}${location.pathname}#${line.id}`;
        const ok = await copyTextToClipboard(url);
        if (ok) flashFeedback(lineLinkBtn);
      }
      return;
    }

    const lineQuoteBtn = event.target.closest<HTMLButtonElement>("[data-line-quote]");
    if (lineQuoteBtn) {
      event.stopPropagation();
      const line = lineQuoteBtn.closest<HTMLElement>("[data-story-line]");
      if (line) {
        const index = lines.indexOf(line);
        if (index >= 0) {
          cardTheme = document.documentElement.dataset.theme === "night" ? "dark" : "light";
          syncThemeButtons();
          active = true;
          anchor = index;
          end = null;
          update();
        }
      }
      return;
    }

    if (!active || busy) return;
    const line = event.target.closest<HTMLElement>("[data-story-line]");
    if (!line) return;
    const index = lines.indexOf(line);
    if (anchor === null || end !== null) {
      anchor = index;
      end = null;
    } else {
      end = index;
    }
    update();
  });

  // Episode-level copy link buttons
  reader.querySelectorAll<HTMLButtonElement>("[data-copy-episode-link]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const ok = await copyTextToClipboard(`${location.origin}${location.pathname}`);
      if (ok) flashFeedback(btn, copy.copiedLink);
    });
  });

  // Copy selected range as formatted quote text
  copyRangeBtn?.addEventListener("click", async () => {
    const selected = range();
    if (!selected || busy) return;
    const slice = lines.slice(selected.start, selected.end + 1);
    const ok = await copyTextToClipboard(formatLinesAsText(slice, lines[selected.start].id));
    if (ok) flashFeedback(copyRangeBtn, copy.copiedText);
  });

  reset.addEventListener("click", () => {
    anchor = null;
    end = null;
    update();
  });

  cancelBtn?.addEventListener("click", cancel);

  // Direct text-selection floating share pill (划词即分享)
  let popRange: { start: number; end: number } | null = null;
  let popTimer = 0;
  const hidePopover = () => {
    popRange = null;
    if (popover) popover.hidden = true;
  };
  const syncTextSelection = () => {
    if (!popover || active || dialog.open) {
      hidePopover();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) {
      hidePopover();
      return;
    }
    const nodeLine = (node: Node | null): HTMLElement | null => {
      const el = node instanceof Element ? node : node?.parentElement;
      return el?.closest<HTMLElement>("[data-story-line]") ?? null;
    };
    const startLine = nodeLine(sel.anchorNode);
    const endLine = nodeLine(sel.focusNode);
    if (!startLine || !endLine || !reader.contains(startLine) || !reader.contains(endLine)) {
      hidePopover();
      return;
    }
    const i1 = lines.indexOf(startLine);
    const i2 = lines.indexOf(endLine);
    if (i1 < 0 || i2 < 0) {
      hidePopover();
      return;
    }
    const start = Math.min(i1, i2);
    const stop = Math.max(i1, i2);
    if (stop - start + 1 > MAX_SHARE_LINES) {
      hidePopover();
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) {
      hidePopover();
      return;
    }
    popRange = { start, end: stop };
    popover.hidden = false;
    const popWidth = popover.offsetWidth || 220;
    const left = Math.min(window.innerWidth - popWidth - 12, Math.max(12, rect.left + rect.width / 2 - popWidth / 2));
    const top = Math.max(68, rect.top - 44);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  };
  const scheduleSelectionSync = () => {
    window.clearTimeout(popTimer);
    popTimer = window.setTimeout(syncTextSelection, 90);
  };
  document.addEventListener("selectionchange", scheduleSelectionSync);
  window.addEventListener("scroll", hidePopover, { passive: true });
  popover?.addEventListener("mousedown", event => event.preventDefault());

  popCard?.addEventListener("click", () => {
    if (!popRange) return;
    anchor = popRange.start;
    end = popRange.end;
    hidePopover();
    window.getSelection()?.removeAllRanges();
    cardTheme = document.documentElement.dataset.theme === "night" ? "dark" : "light";
    syncThemeButtons();
    renderCard(true);
  });

  popCopy?.addEventListener("click", async () => {
    if (!popRange) return;
    const slice = lines.slice(popRange.start, popRange.end + 1);
    const ok = await copyTextToClipboard(formatLinesAsText(slice, lines[popRange.start].id));
    if (ok) flashFeedback(popCopy, copy.copiedText);
  });

  popLink?.addEventListener("click", async () => {
    if (!popRange) return;
    const url = `${location.origin}${location.pathname}#${lines[popRange.start].id}`;
    const ok = await copyTextToClipboard(url);
    if (ok) flashFeedback(popLink, copy.copiedLink);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && active && !dialog.open && !event.defaultPrevented) cancel();
  });

  generate.addEventListener("click", () => renderCard(true));

  themeButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const nextTheme = btn.dataset.shareTheme === "dark" ? "dark" : "light";
      if (nextTheme === cardTheme || busy) return;
      cardTheme = nextTheme;
      syncThemeButtons();
      renderCard(false);
    });
  });

  copyImageBtn?.addEventListener("click", async () => {
    if (!currentBlob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": currentBlob })]);
      flashFeedback(copyImageBtn, copy.copiedImage);
      showError(shareError);
    } catch {
      showError(shareError, copy.copyImageError);
    }
  });

  reader.querySelectorAll("[data-share-close], [data-share-edit]").forEach(button =>
    button.addEventListener("click", () => dialog.close()),
  );

  dialog.addEventListener("click", event => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      ) {
        dialog.close();
      }
    }
  });

  dialog.addEventListener("close", () => {
    document.body.classList.remove("st-share-open");
    releaseImage();
    generate.focus({ preventScroll: true });
  });

  native.addEventListener("click", async () => {
    if (!file) return;
    try {
      await navigator.share({ files: [file] });
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === "AbortError")) {
        showError(shareError, copy.shareError);
      }
    }
  });

  window.addEventListener("pagehide", () => {
    generation++;
    releaseImage();
  });
}
