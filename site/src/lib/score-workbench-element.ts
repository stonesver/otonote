import { readThemePalette, observeTheme } from "./theme-palette.mjs";
import {
  MOBILE_SCORE_PIXELS_PER_SECOND,
  SCORE_PIXELS_PER_SECOND,
  getDensityTargetScrollTop,
  getTrackScrollState
} from "./score-track-layout.mjs";
import { getAtlasSegments, resolveAtlasRange, formatScoreTime } from "./score-atlas-range.mjs";
import { paintScoreSheet, paintScoreCard } from "./score-sheet-renderer.ts";
import { getCurrentCombo } from "./auto-timeline.mjs";
import {
  inspectScoreTarget,
  paintScoreTrack,
  renderScoreTrack,
  type ChartData,
  type ScoreHitTarget
} from "./score-workbench-renderer.ts";
import type { RuntimeUiLabels } from "./runtime-ui-labels";

type ScoreWorkbenchLabels = RuntimeUiLabels["scoreWorkbench"];

type LatestChartResult<T> =
  | { status: "current"; chart: T }
  | { status: "stale" };

export const SCORE_DIFFICULTY_REQUEST_EVENT =
  "score-workbench-difficulty-request";
export const SCORE_DIFFICULTY_CHANGE_EVENT =
  "score-workbench-difficulty-change";
export const SCORE_CHART_SUMMARY_CHANGE_EVENT =
  "score-workbench-chart-summary-change";

interface ScoreDifficultyCoordinatorOptions {
  difficulties: string[];
  readSearch: () => string;
  replaceDifficulty: (difficulty: string) => void;
  onSelect: (difficulty: string) => void;
}

export function createScoreDifficultyCoordinator({
  difficulties,
  readSearch,
  replaceDifficulty,
  onSelect
}: ScoreDifficultyCoordinatorOptions) {
  const available = new Set(difficulties);
  const fallback = available.has("expert")
    ? "expert"
    : difficulties[0];

  const normalize = (requested: string | null) =>
    requested && available.has(requested) ? requested : fallback;

  const select = (requested: string | null, updateUrl: boolean) => {
    const difficulty = normalize(requested);
    if (!difficulty) return;
    onSelect(difficulty);
    if (updateUrl) replaceDifficulty(difficulty);
  };

  return {
    selectFromSummary(difficulty: string) {
      select(difficulty, true);
    },
    syncFromLocation() {
      select(new URLSearchParams(readSearch()).get("difficulty"), false);
    }
  };
}

export function createLatestChartLoader<T>(
  loadChart: (url: string) => Promise<T>,
  cache: Map<string, T> = new Map()
) {
  let generation = 0;

  return async (
    chartId: string,
    url: string
  ): Promise<LatestChartResult<T>> => {
    const requestGeneration = ++generation;
    try {
      let chart = cache.get(chartId);
      if (!chart) {
        chart = await loadChart(url);
        cache.set(chartId, chart);
      }
      if (requestGeneration !== generation) return { status: "stale" };
      return { status: "current", chart };
    } catch (error) {
      if (requestGeneration !== generation) return { status: "stale" };
      throw error;
    }
  };
}

const chartCache = new Map<string, ChartData>();

async function fetchChart(url: string): Promise<ChartData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as ChartData;
}

export function registerScoreWorkbenchElement(): void {
  if (customElements.get("score-workbench")) return;

  class ScoreWorkbenchElement extends HTMLElement {
    labels!: ScoreWorkbenchLabels;
    viewMode = "scroll";
    sheetDirty = true;
    disconnectTheme: (() => void) | undefined;
    focusedSegment: number | null = null;
    atlasRange: { start: number; end: number } | null = null;
    restoringScroll = false;
    chart: ChartData | null = null;
    start = 0;
    windowSeconds = 0;
    enabled = new Set(["tap", "flick", "trace", "long", "events"]);
    hitTargets: ScoreHitTarget[] = [];
    selectedHitKey: string | null = null;
    scrollFrame = 0;
    urlTimer: ReturnType<typeof setTimeout> | undefined;
    anchorTimer: ReturnType<typeof setTimeout> | undefined;
    anchorAligned = false;
    selectionGeneration = 0;
    pixelsPerSecond = SCORE_PIXELS_PER_SECOND;
    mobileScaleMedia = matchMedia("(max-width: 760px)");
    intersectionObserver: IntersectionObserver | undefined;
    difficultyCoordinator: ReturnType<typeof createScoreDifficultyCoordinator> | undefined;
    loadLatestChart = createLatestChartLoader(fetchChart, chartCache);
    handleScaleChange = () => {
      if (!this.chart) return;
      this.render();
    };
    handleDifficultyRequest = (event: Event) => {
      const difficulty = (event as CustomEvent<{ difficulty?: string }>).detail
        ?.difficulty;
      if (difficulty) this.difficultyCoordinator?.selectFromSummary(difficulty);
    };
    handleDifficultyPopState = () => {
      if (this.dataset.embedded === 'true') return;
      const requestedStart = Number(
        new URLSearchParams(location.search).get("t") || 0
      );
      if (Number.isFinite(requestedStart) && requestedStart >= 0) {
        this.start = requestedStart;
      }
      this.difficultyCoordinator?.syncFromLocation();
    };

    handleModuleChange = (event: Event) => {
      if ((event as CustomEvent<{view: string}>).detail?.view === "analysis" && this.chart) {
        requestAnimationFrame(() => { this.render(); this.updateUrl(); });
      }
    };

    connectedCallback() {
      this.disconnectTheme = observeTheme(this, () => { this.sheetDirty = true; this.render(); });
      window.addEventListener("song-detail-view-change", this.handleModuleChange);
      const labelsNode = this.querySelector<HTMLScriptElement>(
        "[data-score-runtime-labels]"
      );
      if (!labelsNode) return;
      this.labels = JSON.parse(labelsNode.textContent ?? "{}");
      const params = new URLSearchParams(this.dataset.embedded === 'true' ? '' : location.search);
      const requestedStart = Number(params.get("t") || 0);
      if (Number.isFinite(requestedStart) && requestedStart >= 0) {
        this.start = requestedStart;
      }
      this.mobileScaleMedia.addEventListener("change", this.handleScaleChange);

      const difficultyButtons = Array.from(
        this.querySelectorAll<HTMLElement>("[data-chart-id]")
      );
      this.difficultyCoordinator = createScoreDifficultyCoordinator({
        difficulties: difficultyButtons
          .map((button) => button.dataset.difficulty)
          .filter((difficulty): difficulty is string => Boolean(difficulty)),
        readSearch: () => this.dataset.embedded === 'true'
          ? new URLSearchParams({difficulty:this.dataset.initialDifficulty ?? 'expert'}).toString() : location.search,
        replaceDifficulty: (difficulty) => {
          if (this.dataset.embedded === 'true') { this.dataset.initialDifficulty=difficulty; return; }
          const url = new URL(location.href);
          url.searchParams.set("difficulty", difficulty);
          history.replaceState(null, "", url);
        },
        onSelect: (difficulty) => {
          const button = this.querySelector<HTMLElement>(
            `[data-difficulty="${difficulty}"]`
          );
          if (!button) return;
          this.intersectionObserver?.disconnect();
          this.intersectionObserver = undefined;
          void this.selectDifficulty(button);
          window.dispatchEvent(new CustomEvent(SCORE_DIFFICULTY_CHANGE_EVENT, {
            detail: { difficulty }
          }));
        }
      });
      window.addEventListener(
        SCORE_DIFFICULTY_REQUEST_EVENT,
        this.handleDifficultyRequest
      );
      window.addEventListener("popstate", this.handleDifficultyPopState);
      this.querySelectorAll<HTMLButtonElement>("[data-score-view]").forEach(button => {
        button.addEventListener("click", () => this.setView(button.dataset.scoreView ?? "scroll"));
      });
      this.querySelector("[data-sheet-range-form]")?.addEventListener("submit", event => {
        event.preventDefault();
        if (!this.chart) return;
        const start = this.querySelector<HTMLInputElement>("[data-sheet-range-start]")!;
        const end = this.querySelector<HTMLInputElement>("[data-sheet-range-end]")!;
        const error = this.querySelector<HTMLElement>("[data-sheet-range-error]")!;
        try {
          const range = resolveAtlasRange(start.value, end.value, this.chart.duration);
          this.atlasRange = range.start === 0 && range.end === this.chart.duration ? null : range;
          error.textContent = "";
          start.removeAttribute("aria-invalid"); end.removeAttribute("aria-invalid");
          this.focusedSegment = null;
          this.sheetDirty = true;
          this.drawSheet();
        } catch (reason) {
          error.textContent = reason instanceof Error ? reason.message : this.labels.atlas.invalidRange;
          start.setAttribute("aria-invalid", "true"); end.setAttribute("aria-invalid", "true");
        }
      });
      this.querySelector("[data-sheet-range-reset]")?.addEventListener("click", () => {
        this.atlasRange = null;
        this.querySelector<HTMLFormElement>("[data-sheet-range-form]")?.reset();
        this.querySelector<HTMLElement>("[data-sheet-range-error]")!.textContent = "";
        this.querySelectorAll(".score-range-form [aria-invalid]").forEach(input => input.removeAttribute("aria-invalid"));
        this.focusedSegment = null;
        this.sheetDirty = true;
        this.drawSheet();
      });
      this.querySelector("[data-sheet-back]")?.addEventListener("click", () => this.focusSegment(null));
      this.querySelectorAll<HTMLButtonElement>("[data-sheet-step]").forEach(button => {
        button.addEventListener("click", () => this.focusSegment((this.focusedSegment ?? 0) + Number(button.dataset.sheetStep)));
      });
      this.querySelector<HTMLSelectElement>("[data-sheet-jump]")?.addEventListener("change", event => this.focusSegment((event.target as HTMLSelectElement).value === "" ? null : Number((event.target as HTMLSelectElement).value)));
      this.querySelector("[data-sheet-download]")?.addEventListener("click", () => {
        if (!this.chart || this.sheetDirty) return;
        const canvas = document.createElement("canvas");
        paintScoreSheet(canvas, this.chart, this.dataset.trackTitle ?? "", this.enabled, this.atlasRange);
        const filename = `${this.chart.id}-atlas${this.atlasRange ? `-${formatScoreTime(this.atlasRange.start)}-${formatScoreTime(this.atlasRange.end)}` : ""}.png`;
        canvas.toBlob(blob => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url; link.download = filename; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
      });
      this.querySelectorAll<HTMLButtonElement>("[data-move]").forEach(
        (button) => {
          button.addEventListener("click", () => {
            this.moveViewport(Number(button.dataset.move));
          });
        }
      );
      this.querySelectorAll<HTMLInputElement>("[data-note-toggle]").forEach(
        (input) => {
          input.addEventListener("change", () => {
            input.checked
              ? this.enabled.add(input.value)
              : this.enabled.delete(input.value);
            this.drawDensity();
            this.sheetDirty = true;
            this.drawTrack();
            this.drawSheet();
          });
        }
      );

      const canvas =
        this.querySelector<HTMLCanvasElement>("[data-score-canvas]");
      canvas?.addEventListener("click", (event) => this.inspectAt(event));
      const trackScroll =
        this.querySelector<HTMLElement>("[data-track-scroll]");
      trackScroll?.addEventListener("scroll", () => {
        if (this.scrollFrame) return;
        this.scrollFrame = requestAnimationFrame(() => {
          this.scrollFrame = 0;
          this.syncScrollState();
        });
      });

      if (difficultyButtons.length === 0) return;
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            this.intersectionObserver?.disconnect();
            this.intersectionObserver = undefined;
            this.difficultyCoordinator?.syncFromLocation();
          }
        },
        { rootMargin: "300px" }
      );
      this.intersectionObserver.observe(this);
    }

    async selectDifficulty(button: HTMLElement) {
      this.querySelectorAll<HTMLElement>("[data-chart-id]").forEach(
        (item) => {
          item.toggleAttribute("data-selected", item === button);
        }
      );
      const id = button.dataset.chartId;
      const url = button.dataset.url;
      if (!id || !url) return;
      const selectionGeneration = ++this.selectionGeneration;
      this.toggleAttribute("data-ready", false);
      this.querySelector<HTMLElement>(
        "[data-score-loading]"
      )?.removeAttribute("hidden");
      this.querySelector<HTMLElement>("[data-score-error]")?.setAttribute(
        "hidden",
        ""
      );
      try {
        const result = await this.loadLatestChart(id, url);
        if (result.status === "stale") return;
        this.chart = result.chart;
        if (this.atlasRange && this.atlasRange.end > this.chart.duration) {
          this.atlasRange = this.atlasRange.start < this.chart.duration ? { ...this.atlasRange, end: this.chart.duration } : null;
          this.querySelector<HTMLInputElement>("[data-sheet-range-start]")!.value = this.atlasRange ? formatScoreTime(this.atlasRange.start) : "";
          this.querySelector<HTMLInputElement>("[data-sheet-range-end]")!.value = "";
          this.querySelector<HTMLElement>("[data-sheet-range-error]")!.textContent = this.labels.atlas.adjustedRange;
        }
        this.sheetDirty = true;
        this.selectedHitKey = null;
        this.render();
        this.setAttribute("data-ready", "");
      } catch (error) {
        console.error("Score chart loading failed", error);
        this.querySelector<HTMLElement>(
          "[data-score-error]"
        )?.removeAttribute("hidden");
      } finally {
        if (selectionGeneration === this.selectionGeneration) {
          this.querySelector<HTMLElement>(
            "[data-score-loading]"
          )?.setAttribute("hidden", "");
        }
      }
    }

    getTrackScroll() {
      return this.querySelector<HTMLElement>("[data-track-scroll]");
    }

    getScrollBehavior(): ScrollBehavior {
      return matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
    }

    moveViewport(direction: number) {
      const trackScroll = this.getTrackScroll();
      if (!trackScroll) return;
      trackScroll.scrollBy({
        top: -direction * trackScroll.clientHeight * 0.88,
        behavior: this.getScrollBehavior()
      });
    }

    scrollToTime(
      time: number,
      center = false,
      behavior: ScrollBehavior = "auto"
    ) {
      if (!this.chart) return;
      const trackScroll = this.getTrackScroll();
      if (!trackScroll) return;
      const targetTop = center
        ? getDensityTargetScrollTop({
            targetTime: time,
            clientHeight: trackScroll.clientHeight,
            duration: this.chart.duration,
            pixelsPerSecond: this.pixelsPerSecond
          })
        : getTrackScrollState({
            scrollTop: Math.ceil(this.chart.duration * this.pixelsPerSecond) - trackScroll.clientHeight - time * this.pixelsPerSecond,
            clientHeight: trackScroll.clientHeight,
            duration: this.chart.duration,
            pixelsPerSecond: this.pixelsPerSecond
          }).scrollTop;
      trackScroll.scrollTo({ top: targetTop, behavior });
    }

    syncScrollState(updateUrl = true) {
      if (!this.chart) return;
      const trackScroll = this.getTrackScroll();
      if (!trackScroll || !trackScroll.clientHeight || this.viewMode !== "scroll" || this.restoringScroll) return;
      const state = getTrackScrollState({
        scrollTop: trackScroll.scrollTop,
        clientHeight: trackScroll.clientHeight,
        duration: this.chart.duration,
        pixelsPerSecond: this.pixelsPerSecond
      });
      this.start = state.start;
      this.windowSeconds = state.visibleSeconds;
      this.updateCurrentCombo();
      this.updateVisibleRange(state.end);
      this.updateDensityWindow();
      if (updateUrl) this.queueUrlUpdate();
    }

    updateVisibleRange(
      end = Math.min(
        this.start + this.windowSeconds,
        this.chart?.duration ?? 0
      )
    ) {
      const range =
        this.querySelector<HTMLOutputElement>("[data-current-range]");
      if (range) {
        range.textContent =
          `${this.start.toFixed(1)}–${end.toFixed(1)} ${this.labels.seconds}`;
      }
    }

    updateCurrentCombo() {
      if (!this.chart) return;
      window.dispatchEvent(new CustomEvent(SCORE_CHART_SUMMARY_CHANGE_EVENT, {
        detail: { combo: String(getCurrentCombo(this.chart, this.start)) }
      }));
    }

    updateDensityWindow() {
      if (!this.chart) return;
      const windowRect = this.querySelector<SVGRectElement>(
        "[data-density-window]"
      );
      if (!windowRect) return;
      windowRect.setAttribute(
        "x",
        String((this.start / this.chart.duration) * 1000)
      );
      windowRect.setAttribute(
        "width",
        String((this.windowSeconds / this.chart.duration) * 1000)
      );
    }

    queueUrlUpdate() {
      clearTimeout(this.urlTimer);
      this.urlTimer = setTimeout(() => this.updateUrl(), 120);
    }

    render() {
      if (!this.chart) return;
      const requestedStart = this.start;
      this.restoringScroll = true;
      // Keep long songs below browser canvas dimension limits.
      this.pixelsPerSecond = Math.min(
        this.mobileScaleMedia.matches ? MOBILE_SCORE_PIXELS_PER_SECOND : SCORE_PIXELS_PER_SECOND,
        30000 / Math.max(1, this.chart.duration)
      );
      const trackScroll = this.getTrackScroll();
      if (trackScroll) {
        this.windowSeconds =
          trackScroll.clientHeight / this.pixelsPerSecond;
      }
      const bpm = this.chart.statistics.bpm;
      const values: Record<string, string> = {
        combo: String(getCurrentCombo(this.chart, this.start)),
        bpm:
          bpm.min === bpm.max ? String(bpm.min) : `${bpm.min}–${bpm.max}`,
        average: `${this.chart.statistics.averageDensity}/s`,
        peak: `${this.chart.statistics.peakDensity}`,
        notes: `${this.chart.statistics.noteCounts.tap} / ${this.chart.statistics.noteCounts.flick} / ${this.chart.statistics.noteCounts.trace} / ${this.chart.statistics.noteCounts.long}`,
        events: String(this.chart.skillTimings.length)
      };
      window.dispatchEvent(new CustomEvent(SCORE_CHART_SUMMARY_CHANGE_EVENT, {
        detail: values
      }));
      this.updateVisibleRange();
      this.drawDensity();
      this.drawTrack();
      this.drawSheet();
      requestAnimationFrame(() => {
        if (!this.anchorAligned && location.hash === "#score-track") {
          this.querySelector("#score-track")?.scrollIntoView({
            block: "start"
          });
          this.anchorAligned = true;
          this.anchorTimer = setTimeout(() => {
            this.querySelector("#score-track")?.scrollIntoView({
              block: "start"
            });
          }, 250);
        }
        if (this.viewMode === "scroll" && this.getTrackScroll()?.clientHeight) this.scrollToTime(requestedStart);
        this.restoringScroll = false;
        this.syncScrollState(false);
        this.updateUrl();
      });
    }

    setView(view: string) {
      this.viewMode = view === "sheet" ? "sheet" : "scroll";
      this.dataset.scoreMode = this.viewMode;
      this.querySelectorAll<HTMLElement>("[data-score-scroll-only]").forEach(panel => { panel.hidden = this.viewMode !== "scroll"; });
      const sheet = this.querySelector<HTMLElement>("[data-score-sheet]");
      if (sheet) sheet.hidden = this.viewMode !== "sheet";
      this.querySelectorAll<HTMLElement>("[data-score-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.scoreView === this.viewMode)));
      this.render();
    }

    focusSegment(index: number | null, moveFocus = true) {
      if (!this.chart) return;
      const previousIndex = this.focusedSegment ?? 0;
      const segments = getAtlasSegments(this.chart.duration, this.atlasRange);
      this.focusedSegment = index === null ? null : Math.max(0, Math.min(segments.length - 1, index));
      const grid = this.querySelector<HTMLElement>("[data-sheet-grid]");
      if (!grid) return;
      grid.classList.toggle("is-focused", this.focusedSegment !== null);
      grid.querySelectorAll<HTMLElement>("[data-segment]").forEach(card => { card.hidden = this.focusedSegment !== null && Number(card.dataset.segment) !== this.focusedSegment; });
      const controls = this.querySelector<HTMLElement>("[data-sheet-focus-controls]");
      if (controls) controls.hidden = this.focusedSegment === null;
      const jump = this.querySelector<HTMLSelectElement>("[data-sheet-jump]");
      if (jump) jump.value = String(this.focusedSegment ?? "");
      this.querySelectorAll<HTMLButtonElement>("[data-sheet-step]").forEach(button => { button.disabled = Number(button.dataset.sheetStep) < 0 ? this.focusedSegment === 0 : this.focusedSegment === segments.length - 1; });
      if (moveFocus) {
        if (this.focusedSegment === null) {
          grid.querySelector<HTMLButtonElement>(`[data-segment="${previousIndex}"] [data-segment-focus]`)?.focus();
        } else {
          this.querySelector<HTMLButtonElement>("[data-sheet-back]")?.focus({ preventScroll: true });
          this.querySelector(".score-atlas-navigation")?.scrollIntoView({ block: "nearest" });
        }
      }
    }

    drawSheet() {
      if (!this.chart || this.viewMode !== "sheet" || !this.sheetDirty) return;
      const grid = this.querySelector<HTMLElement>("[data-sheet-grid]");
      const jump = this.querySelector<HTMLSelectElement>("[data-sheet-jump]");
      if (!grid || !jump) return;
      const segments = getAtlasSegments(this.chart.duration, this.atlasRange);
      const count = this.querySelector("[data-sheet-count]");
      if (count) count.textContent = `${segments.length} ${this.labels.atlas.segments} / ${this.atlasRange ? `${formatScoreTime(this.atlasRange.start)}–${formatScoreTime(this.atlasRange.end)} ${this.labels.seconds}` : `${this.labels.atlas.fullSong} ${formatScoreTime(this.chart.duration)} ${this.labels.seconds}`}`;
      grid.replaceChildren();
      jump.replaceChildren(new Option(this.atlasRange ? this.labels.atlas.selectedOverview : this.labels.atlas.fullOverview, ""));
      segments.forEach(segment => {
        const number = String(segment.index + 1).padStart(2, "0");
        const range = `${formatScoreTime(segment.start)}–${formatScoreTime(segment.end)} s`;
        jump.add(new Option(`${number} · ${range}`, String(segment.index)));
        const card = document.createElement("article");
        card.className = "score-segment";
        card.dataset.segment = String(segment.index);
        card.setAttribute("role", "listitem");
        card.innerHTML = `<header><span class="score-segment-number">${number}</span><strong>${range}</strong><button type="button" data-segment-focus aria-label="${this.labels.atlas.focusSegment.replace("{index}", String(segment.index + 1))}">${this.labels.atlas.expand}</button></header><canvas role="img"></canvas><footer><span>${this.labels.atlas.fromHere}</span><button type="button" data-segment-analyze>${this.labels.atlas.analyze}</button></footer>`;
        const canvas = card.querySelector("canvas")!;
        canvas.setAttribute("aria-label", `${this.dataset.trackTitle} ${this.chart!.difficulty.toUpperCase()} ${this.labels.atlas.segment.replace("{index}", String(segment.index + 1))} ${range}`);
        paintScoreCard(canvas, this.chart!, segment, this.enabled);
        card.querySelector("[data-segment-focus]")!.addEventListener("click", () => this.focusSegment(segment.index));
        card.querySelector("[data-segment-analyze]")!.addEventListener("click", () => {
          this.start = segment.start;
          this.setView("scroll");
          this.getTrackScroll()?.focus({ preventScroll: true });
          this.getTrackScroll()?.scrollIntoView({ block: "nearest" });
        });
        grid.append(card);
      });
      this.sheetDirty = false;
      this.focusSegment(this.focusedSegment, false);
    }

    drawDensity() {
      if (!this.chart) return;
      const svg = this.querySelector<SVGSVGElement>("[data-density]");
      if (!svg) return;
      const namespace = "http://www.w3.org/2000/svg";
      svg.replaceChildren();
      const maxCount = Math.max(
        1,
        ...this.chart.density.map((bucket) => bucket.count)
      );
      this.chart.feverRanges.forEach((range) => {
        if (!this.enabled.has("events")) return;
        const rect = document.createElementNS(namespace, "rect");
        rect.setAttribute("class", "density-fever");
        rect.setAttribute(
          "x",
          String((range.start / this.chart!.duration) * 1000)
        );
        rect.setAttribute(
          "width",
          String(
            ((range.end - range.start) / this.chart!.duration) * 1000
          )
        );
        rect.setAttribute("y", "0");
        rect.setAttribute("height", "180");
        svg.append(rect);
      });
      this.chart.density.forEach((bucket) => {
        const rect = document.createElementNS(namespace, "rect");
        const height = (bucket.count / maxCount) * 132;
        rect.setAttribute("class", "density-bar");
        rect.setAttribute(
          "x",
          String((bucket.start / this.chart!.duration) * 1000)
        );
        rect.setAttribute(
          "width",
          String(Math.max(2, (1 / this.chart!.duration) * 1000 - 1))
        );
        rect.setAttribute("y", String(156 - height));
        rect.setAttribute("height", String(height));
        svg.append(rect);
      });
      this.chart.skillTimings.forEach((time) => {
        if (!this.enabled.has("events")) return;
        const line = document.createElementNS(namespace, "line");
        line.setAttribute("class", "density-skill");
        line.setAttribute(
          "x1",
          String((time / this.chart!.duration) * 1000)
        );
        line.setAttribute(
          "x2",
          String((time / this.chart!.duration) * 1000)
        );
        line.setAttribute("y1", "12");
        line.setAttribute("y2", "168");
        svg.append(line);
      });
      const windowRect = document.createElementNS(namespace, "rect");
      windowRect.setAttribute("class", "density-window");
      windowRect.setAttribute("data-density-window", "");
      windowRect.setAttribute(
        "x",
        String((this.start / this.chart.duration) * 1000)
      );
      windowRect.setAttribute(
        "width",
        String((this.windowSeconds / this.chart.duration) * 1000)
      );
      windowRect.setAttribute("y", "4");
      windowRect.setAttribute("height", "172");
      svg.append(windowRect);
      svg.onclick = (event) => {
        const bounds = svg.getBoundingClientRect();
        const targetTime =
          ((event.clientX - bounds.left) / bounds.width) *
          this.chart!.duration;
        this.scrollToTime(targetTime, true, this.getScrollBehavior());
        this.getTrackScroll()?.focus({ preventScroll: true });
      };
    }

    drawTrack() {
      if (!this.chart || this.viewMode !== "scroll") return;
      const canvas =
        this.querySelector<HTMLCanvasElement>("[data-score-canvas]");
      if (!canvas) return;
      const plan = renderScoreTrack({
        chart: this.chart,
        width: canvas.width,
        pixelsPerSecond: this.pixelsPerSecond,
        enabled: this.enabled
      });
      canvas.height = plan.height;
      canvas.style.height = `${plan.height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      paintScoreTrack(context, plan, this.selectedHitKey, readThemePalette(canvas));
      this.hitTargets = plan.hitTargets;
    }

    inspectAt(event: MouseEvent) {
      const canvas = event.currentTarget;
      if (!(canvas instanceof HTMLCanvasElement) || !this.chart) return;
      const bounds = canvas.getBoundingClientRect();
      const x =
        ((event.clientX - bounds.left) / bounds.width) * canvas.width;
      const y =
        ((event.clientY - bounds.top) / bounds.height) * canvas.height;
      const nearest = this.hitTargets
        .map((target) => ({
          target,
          distance: Math.hypot(
            Math.max(0, Math.abs(target.x - x) - target.width / 2),
            target.y - y
          )
        }))
        .sort((left, right) => left.distance - right.distance)[0];
      if (!nearest || nearest.distance > 36) return;
      const inspector =
        this.querySelector<HTMLElement>("[data-inspector]");
      if (!inspector) return;
      const view = inspectScoreTarget(
        this.chart,
        nearest.target,
        {
          direction: this.labels.direction,
          fever: this.labels.fever
        }
      );
      inspector.innerHTML = `
        <span>NOTE INSPECTOR</span>
        <h3>${view.typeLabel}</h3>
        <dl>
          <div><dt>${this.labels.terms.time}</dt><dd>${view.time}</dd></div>
          <div><dt>${this.labels.terms.combo}</dt><dd>${view.combo}</dd></div>
          <div><dt>${this.labels.terms.lane}</dt><dd>${view.lane}</dd></div>
          <div><dt>${this.labels.terms.position}</dt><dd>${view.position}</dd></div>
          <div><dt>${this.labels.terms.width}</dt><dd>${view.size}</dd></div>
          <div><dt>${this.labels.terms.direction}</dt><dd>${view.direction}</dd></div>
          <div><dt>BPM</dt><dd>${view.bpm}</dd></div>
          <div><dt>${this.labels.terms.timeSignature}</dt><dd>${view.timeSignature}</dd></div>
          <div><dt>${this.labels.terms.fever}</dt><dd>${view.fever}</dd></div>
        </dl>
      `;
      this.selectedHitKey = nearest.target.key;
      this.drawTrack();
    }

    disconnectedCallback() {
      this.disconnectTheme?.();
      window.removeEventListener("song-detail-view-change", this.handleModuleChange);
      this.intersectionObserver?.disconnect();
      this.intersectionObserver = undefined;
      cancelAnimationFrame(this.scrollFrame);
      clearTimeout(this.urlTimer);
      clearTimeout(this.anchorTimer);
      this.mobileScaleMedia.removeEventListener(
        "change",
        this.handleScaleChange
      );
      window.removeEventListener(
        SCORE_DIFFICULTY_REQUEST_EVENT,
        this.handleDifficultyRequest
      );
      window.removeEventListener("popstate", this.handleDifficultyPopState);
    }

    updateUrl() {
      if (this.dataset?.embedded === 'true') return;
      // Hidden analysis rendering must not overwrite the playback cursor.
      const panel = this.closest<HTMLElement>('[data-song-panel]');
      const dialog = this.closest<HTMLDialogElement>('dialog');
      if (panel?.hidden || (dialog && !dialog.open)) return;
      const selected = this.querySelector<HTMLElement>(
        '[data-chart-id][data-selected]'
      );
      if (!selected) return;
      const params = new URLSearchParams(location.search);
      params.set(
        "difficulty",
        selected.dataset.difficulty || "expert"
      );
      params.set("t", this.start.toFixed(1));
      params.delete("window");
      history.replaceState(
        null,
        "",
        `${location.pathname}?${params}${location.hash}`
      );
    }
  }

  customElements.define("score-workbench", ScoreWorkbenchElement);
}
