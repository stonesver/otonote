import { readThemePalette } from "./theme-palette.mjs";
import { MAX_SHARE_LINES, selectedRange } from "./story-share-layout.mjs";
import type { StoryShareCopy } from "./story-share-copy";
import type { ShareLine } from "./story-share-image";

export function setupStoryShare(reader: HTMLElement) {
  const copy: StoryShareCopy = JSON.parse(reader.dataset.shareCopy!);
  const find = <T extends HTMLElement>(selector: string) => reader.querySelector<T>(selector)!;
  const toggle = find<HTMLButtonElement>("[data-share-toggle]");
  const panel = find<HTMLElement>(".st-selection");
  const status = find<HTMLElement>("[data-selection-status]");
  const hint = find<HTMLElement>("[data-selection-hint]");
  const error = find<HTMLElement>("[data-selection-error]");
  const generate = find<HTMLButtonElement>("[data-selection-generate]");
  const reset = find<HTMLButtonElement>("[data-selection-reset]");
  const dialog = find<HTMLDialogElement>("[data-share-dialog]");
  const preview = find<HTMLImageElement>("[data-share-image]");
  const save = find<HTMLAnchorElement>("[data-share-save]");
  const native = find<HTMLButtonElement>("[data-share-native]");
  const result = find<HTMLElement>("[data-share-result]");
  const shareError = find<HTMLElement>("[data-share-error]");
  const lines = [...reader.querySelectorAll<HTMLElement>("[data-story-line]")];
  let active = false;
  let anchor: number | null = null;
  let end: number | null = null;
  let busy = false;
  let generation = 0;
  let objectUrl = "";
  let file: File | null = null;
  const range = () => selectedRange(anchor, end ?? anchor);
  const describe = (value: { start: number; end: number; count: number }) => copy.chosen
    .replace("{start}", String(value.start + 1)).replace("{end}", String(value.end + 1)).replace("{count}", String(value.count));
  const showError = (node: HTMLElement, message = "") => { node.textContent = message; node.hidden = !message; };
  const releaseImage = () => {
    preview.removeAttribute("src"); save.removeAttribute("href");
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = ""; file = null;
  };
  const update = () => {
    const selected = range();
    panel.hidden = !active;
    reader.toggleAttribute("data-selecting", active);
    reader.setAttribute("aria-busy", String(busy));
    toggle.setAttribute("aria-pressed", String(active));
    toggle.querySelector("span")!.textContent = active ? copy.cancel : copy.select;
    hint.textContent = anchor !== null && end === null ? copy.chooseEnd : copy.hint;
    status.textContent = selected ? describe(selected) : copy.empty;
    generate.disabled = busy || !selected || selected.count > MAX_SHARE_LINES;
    generate.textContent = busy ? copy.busy : copy.generate;
    reset.disabled = busy || !selected;
    lines.forEach((line, index) => {
      const selectedLine = Boolean(active && selected && index >= selected.start && index <= selected.end);
      line.toggleAttribute("data-selected", selectedLine);
      const button = line.querySelector<HTMLButtonElement>("[data-select-line]")!;
      button.setAttribute("aria-pressed", String(selectedLine));
      button.disabled = busy;
    });
    showError(error, selected && selected.count > MAX_SHARE_LINES ? copy.limit : "");
  };
  const cancel = () => {
    generation++; busy = false; active = false; anchor = null; end = null;
    update(); toggle.focus({ preventScroll: true });
  };
  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    if (active) { cancel(); return; }
    active = true; update();
  });
  reader.querySelector(".st-transcript")!.addEventListener("click", event => {
    if (!active || busy || !(event.target instanceof Element)) return;
    const line = event.target.closest<HTMLElement>("[data-story-line]");
    if (!line) return;
    const index = lines.indexOf(line);
    if (anchor === null || end !== null) { anchor = index; end = null; }
    else end = index;
    update();
  });
  reset.addEventListener("click", () => { anchor = null; end = null; update(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && active && !dialog.open && !event.defaultPrevented) cancel();
  });
  generate.addEventListener("click", async () => {
    const selected = range();
    if (!selected || selected.count > MAX_SHARE_LINES || busy) return;
    const request = ++generation;
    busy = true; update();
    try {
      const palette = readThemePalette(reader);
      const content: ShareLine[] = lines.slice(selected.start, selected.end + 1).map(line => ({
        kind: line.dataset.lineKind || "dialogue",
        speaker: line.dataset.storySpeaker || "",
        text: line.querySelector("p, h2 span")?.textContent || "",
        avatar: line.querySelector<HTMLImageElement>(".st-avatar img")?.src || "",
        accent: getComputedStyle(line).getPropertyValue("--speaker-accent").trim() || palette.secondaryInk,
      }));
      const { createStoryImage } = await import("./story-share-image");
      if (request !== generation) return;
      const image = await createStoryImage({
        title: find<HTMLElement>("h1").textContent || "",
        chapter: find<HTMLElement>(".st-reader-subtitle").textContent || "",
        category: [...reader.querySelectorAll(".st-reader-kicker > span")].map(node => node.textContent).join(" · "),
        excerpt: copy.excerpt, range: describe(selected),
        source: `${location.origin}${location.pathname}#${lines[selected.start].id}`,
        accent: getComputedStyle(reader).getPropertyValue("--band-accent").trim() || palette.secondaryInk,
        font: getComputedStyle(reader).fontFamily, lines: content,
      });
      if (request !== generation) return;
      releaseImage();
      objectUrl = URL.createObjectURL(image.blob);
      const filename = `OtoNote-${reader.dataset.storyId}-${selected.start + 1}-${selected.end + 1}.png`;
      file = new File([image.blob], filename, { type: "image/png" });
      preview.src = objectUrl;
      preview.width = image.width; preview.height = image.height;
      save.href = objectUrl; save.download = filename;
      native.hidden = !(typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }));
      result.textContent = `${copy.ready} · ${image.width} × ${image.height}${image.missingAvatars ? ` · ${copy.avatarFallback}` : ""}`;
      showError(shareError);
      dialog.showModal();
      document.body.classList.add("st-share-open");
    } catch (failure) {
      if (request === generation) showError(error, failure instanceof RangeError ? copy.tooTall : copy.error);
    } finally {
      if (request === generation) {
        busy = false;
        reader.setAttribute("aria-busy", "false");
        generate.disabled = false; generate.textContent = copy.generate; reset.disabled = false;
        lines.forEach(line => { line.querySelector<HTMLButtonElement>("[data-select-line]")!.disabled = false; });
      }
    }
  });
  reader.querySelectorAll("[data-share-close], [data-share-edit]").forEach(button => button.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("click", event => { if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  } });
  dialog.addEventListener("close", () => {
    document.body.classList.remove("st-share-open"); releaseImage(); generate.focus({ preventScroll: true });
  });
  native.addEventListener("click", async () => {
    if (!file) return;
    try { await navigator.share({ files: [file] }); }
    catch (failure) { if (!(failure instanceof DOMException && failure.name === "AbortError")) showError(shareError, copy.shareError); }
  });
  window.addEventListener("pagehide", () => { generation++; releaseImage(); });
}
