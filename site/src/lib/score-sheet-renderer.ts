import { readThemePalette } from "./theme-palette.mjs";
import { getAtlasSegments, formatScoreTime, SHEET_SEGMENT_SECONDS } from './score-atlas-range.mjs';
import { paintScoreTrack, renderScoreTrack, type ChartData } from './score-workbench-renderer.ts';

export { SHEET_SEGMENT_SECONDS } from './score-atlas-range.mjs';
const PIXELS_PER_SECOND = 168;
const TRACK_WIDTH = 216;
const CARD_WIDTH = 260;
const CARD_HEIGHT = SHEET_SEGMENT_SECONDS * PIXELS_PER_SECOND + 40;

type Segment = { index: number; start: number; end: number; includeEnd?: boolean };

function paintCard(context: CanvasRenderingContext2D, chart: ChartData, segment: Segment, enabled: Set<string>, palette: Record<string, string>) {
  const bottom = CARD_HEIGHT - 20;
  const plan = renderScoreSegment(chart, segment, enabled);
  context.fillStyle = palette.inverseSurface;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  context.save();
  context.translate(32, bottom - plan.height);
  context.beginPath();
  context.rect(0, -18, TRACK_WIDTH, plan.height + 36);
  context.clip();
  paintScoreTrack(context, plan, null, palette);
  context.restore();
  context.fillStyle = palette.inverseMuted;
  context.font = '11px monospace';
  context.textAlign = 'right';
  for (let time = Math.ceil(segment.start); time <= segment.end; time++) {
    context.fillText(String(time), 25, bottom - (time - segment.start) * PIXELS_PER_SECOND + 4);
  }
  context.textAlign = 'left';
}

export function paintScoreCard(canvas: HTMLCanvasElement, chart: ChartData, segment: Segment, enabled: Set<string>) {
  canvas.width = CARD_WIDTH * 2;
  canvas.height = CARD_HEIGHT * 2;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(2, 2);
  paintCard(context, chart, segment, enabled, readThemePalette(canvas));
}

// The downloadable contact sheet follows the same row-by-row reading order.
export function paintScoreSheet(canvas: HTMLCanvasElement, chart: ChartData, title: string, enabled: Set<string>, range: { start: number; end: number } | null = null) {
  const segments = getAtlasSegments(chart.duration, range);
  const columns = Math.min(4, Math.max(1, segments.length));
  const cellWidth = CARD_WIDTH + 24, cellHeight = CARD_HEIGHT + 72;
  canvas.width = columns * cellWidth + 24;
  canvas.height = Math.ceil(segments.length / columns) * cellHeight + 96;
  const context = canvas.getContext('2d');
  if (!context) return;
  const palette = readThemePalette(canvas);
  context.fillStyle = palette.canvas;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = palette.accent;
  context.font = 'bold 22px sans-serif';
  context.fillText(`${title} · ${chart.difficulty.toUpperCase()} · 谱段图册`, 24, 36);
  context.font = '13px sans-serif';
  context.fillText(`${range ? `${formatScoreTime(range.start)}–${formatScoreTime(range.end)} 秒` : '全曲'} · 按编号逐段阅读 · 每段从底部开始`, 24, 62);
  segments.forEach(segment => {
    const x = 24 + segment.index % columns * cellWidth;
    const y = 96 + Math.floor(segment.index / columns) * cellHeight;
    context.fillStyle = palette.accent;
    context.font = 'bold 14px sans-serif';
    context.fillText(`${String(segment.index + 1).padStart(2, '0')}  /  ${formatScoreTime(segment.start)}–${formatScoreTime(segment.end)} s`, x, y);
    context.save();
    context.translate(x, y + 16);
    paintCard(context, chart, segment, enabled, palette);
    context.restore();
  });
}

export function renderScoreSegment(chart: ChartData, segment: { start: number; end: number; includeEnd?: boolean }, enabled: Set<string>) {
  // Boundary notes belong to the next column; ribbons continue across both.
  const belongs = (time: number) => time >= segment.start && (time < segment.end || (segment.includeEnd || segment.end === chart.duration) && time <= segment.end);
  const plan = renderScoreTrack({ chart, width: TRACK_WIDTH, pixelsPerSecond: PIXELS_PER_SECOND, enabled, start: segment.start, end: segment.end });
  plan.markers = plan.markers.filter(marker => belongs(marker.detailTime));
  plan.hitTargets = plan.hitTargets.filter(marker => belongs(marker.detailTime));
  plan.skillLines = chart.skillTimings.filter(time => enabled.has('events') && belongs(time)).map(time => plan.height - (time - segment.start) * PIXELS_PER_SECOND);
  return plan;
}
