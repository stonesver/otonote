import {
  NOTE_VISUAL_WIDTH_RATIO,
  TRACK_UNITS,
  describeTrackSpan,
  flickArrowGeometry,
  getLogicalLaneBoundaries,
  layoutScoreTrack
} from "./score-track-layout.mjs";
import { getCurrentCombo } from "./auto-timeline.mjs";

export type ChartNote = {
  id: string;
  type: "tap" | "flick" | "trace" | "long" | "guide";
  time?: number;
  position?: number;
  size?: number;
  direction?: string;
  nodes?: Array<{
    time: number;
    position: number | null;
    size: number | null;
    visible: boolean;
    easing: string;
    easingRight: string;
    critical: boolean;
    operateType: "normal" | "flick" | "trace";
    flick?: boolean;
    direction?: string;
  }>;
};

export type ChartData = {
  id: string;
  difficulty: string;
  duration: number;
  bpmEvents: Array<{ time: number; bpm: number }>;
  timeSignatureEvents: Array<{
    time: number;
    numerator: number;
    denominator: number;
  }>;
  skillTimings: number[];
  feverRanges: Array<{ start: number; end: number }>;
  comboEvents: Array<{
    time: number;
    combo: number;
    markerId: string | null;
    noteId: string;
    nodeIndex: number | null;
  }>;
  notes: ChartNote[];
  density: Array<{ start: number; end: number; count: number }>;
  statistics: {
    noteCounts: { tap: number; flick: number; trace: number; long: number };
    averageDensity: number;
    peakDensity: number;
    bpm: { min: number; max: number };
  };
};

export type ScoreHitTarget = {
  key: string;
  kind: "tap" | "flick" | "trace" | "long-node" | "long-flick";
  x: number;
  y: number;
  width: number;
  detailTime: number;
  position: number;
  size: number;
  direction?: string;
};

type ScoreTrackMarker = ScoreHitTarget & {
  centerX: number;
};

export type ScoreTrackRenderPlan = {
  width: number;
  height: number;
  laneBoundaries: number[];
  secondLines: number[];
  feverBands: Array<{ top: number; height: number }>;
  skillLines: number[];
  longRibbons: Array<{
    note: ChartNote;
    points: Array<{ centerX: number; y: number; width: number }>;
  }>;
  markers: ScoreTrackMarker[];
  hitTargets: ScoreHitTarget[];
};

export type ScoreInspectorViewModel = {
  typeLabel: string;
  time: string;
  combo: string;
  lane: string;
  position: string;
  size: string;
  direction: string;
  bpm: string;
  timeSignature: string;
  fever: string;
};

export function renderScoreTrack({
  chart,
  width,
  pixelsPerSecond,
  enabled,
  start = 0,
  end = chart.duration
}: {
  chart: ChartData;
  width: number;
  pixelsPerSecond: number;
  enabled: Set<string>;
  start?: number;
  end?: number;
}): ScoreTrackRenderPlan {
  const height = Math.ceil((end - start) * pixelsPerSecond);
  const layout = layoutScoreTrack({
    chart,
    start,
    windowSeconds: end - start,
    width,
    height,
    enabled,
    pixelsPerSecond,
    timeDirection: "up",
    noteWidthRatio: NOTE_VISUAL_WIDTH_RATIO
  }) as {
    feverBands: Array<{ top: number; height: number }>;
    skillLines: number[];
    longRibbons: ScoreTrackRenderPlan["longRibbons"];
    markers: ScoreTrackMarker[];
  };
  const hitTargets = layout.markers.map(
    ({
      key,
      kind,
      centerX,
      y,
      width: markerWidth,
      detailTime,
      position,
      size,
      direction
    }) => ({
      key,
      kind,
      x: centerX,
      y,
      width: markerWidth,
      detailTime,
      position,
      size,
      direction
    })
  );

  return {
    width,
    height,
    laneBoundaries: getLogicalLaneBoundaries().map(
      (boundary: number) => (boundary / TRACK_UNITS) * width
    ),
    secondLines: Array.from(
      { length: Math.max(0, Math.floor(end) - Math.ceil(start) + 1) },
      (_, second) => height - (Math.ceil(start) + second - start) * pixelsPerSecond
    ),
    feverBands: layout.feverBands,
    skillLines: layout.skillLines,
    longRibbons: layout.longRibbons,
    markers: layout.markers,
    hitTargets
  };
}

export function paintScoreTrack(
  context: CanvasRenderingContext2D,
  plan: ScoreTrackRenderPlan,
  selectedHitKey: string | null,
  palette: Record<string, string>
): void {
  const { width, height } = plan;
  context.clearRect(0, 0, width, height);
  context.fillStyle = palette.inverseSurface;
  context.fillRect(0, 0, width, height);
  context.save();
  context.lineWidth = 1;
  for (const [index, x] of plan.laneBoundaries.entries()) {
    context.strokeStyle = index === (plan.laneBoundaries.length - 1) / 2 ? palette.secondary : palette.inverseText;
    context.globalAlpha = index === 0 || index === plan.laneBoundaries.length - 1 || index === (plan.laneBoundaries.length - 1) / 2 ? .28 : .1;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
  }
  context.strokeStyle = palette.inverseText;
  context.globalAlpha = .08;
  for (const y of plan.secondLines) {
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  context.restore();

  context.fillStyle = "rgba(121,174,194,.11)";
  for (const band of plan.feverBands) {
    context.fillRect(0, band.top, width, band.height);
  }

  for (const ribbon of plan.longRibbons) {
    const points = ribbon.points;
    if (points.length < 2) continue;
    context.save();
    context.beginPath();
    points.forEach((point, index) => {
      const x = point.centerX - point.width / 2;
      index ? context.lineTo(x, point.y) : context.moveTo(x, point.y);
    });
    [...points].reverse().forEach((point) => {
      context.lineTo(point.centerX + point.width / 2, point.y);
    });
    context.closePath();
    context.fillStyle = "rgba(161,74,115,.2)";
    context.fill();
    context.strokeStyle = "rgba(232,151,190,.42)";
    context.lineWidth = 1.5;
    context.stroke();
    context.restore();
  }

  context.save();
  context.strokeStyle = "#e3bd66";
  context.lineWidth = 2;
  context.setLineDash([10, 8]);
  for (const y of plan.skillLines) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.restore();

  const roundedRect = (
    x: number,
    y: number,
    markerWidth: number,
    markerHeight: number,
    radius: number
  ) => {
    const right = x + markerWidth;
    const bottom = y + markerHeight;
    const safeRadius = Math.min(radius, markerWidth / 2, markerHeight / 2);
    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.lineTo(right - safeRadius, y);
    context.quadraticCurveTo(right, y, right, y + safeRadius);
    context.lineTo(right, bottom - safeRadius);
    context.quadraticCurveTo(right, bottom, right - safeRadius, bottom);
    context.lineTo(x + safeRadius, bottom);
    context.quadraticCurveTo(x, bottom, x, bottom - safeRadius);
    context.lineTo(x, y + safeRadius);
    context.quadraticCurveTo(x, y, x + safeRadius, y);
    context.closePath();
  };

  for (const marker of plan.markers) {
    const markerHeight = marker.kind.includes("flick") ? 7 : 5;
    const markerY = marker.y - markerHeight / 2;
    context.save();
    roundedRect(marker.x, markerY, marker.width, markerHeight, 3.5);
    const isFlick = marker.kind.includes("flick");
    const isTrace = marker.kind === "trace";
    const isLong = marker.kind.startsWith("long");
    context.fillStyle = isFlick
      ? "#e3bd66"
      : isTrace
        ? "#83d7cf"
        : isLong
          ? "#b85b84"
          : "#dff5ff";
    context.shadowColor = isFlick
      ? "rgba(227,189,102,.52)"
      : isTrace
        ? "rgba(131,215,207,.52)"
        : isLong
          ? "rgba(184,91,132,.48)"
          : "rgba(121,174,194,.52)";
    context.shadowBlur = 1.5;
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = isFlick
      ? "#fff0b3"
      : isTrace
        ? "#d9fffb"
        : isLong
          ? "#f0aac9"
          : "#79aec2";
    context.lineWidth = 1;
    context.stroke();

    if (isFlick) {
      const arrow = flickArrowGeometry(
        marker.direction,
        marker.centerX,
        marker.y
      );
      context.beginPath();
      context.moveTo(arrow[0].x, arrow[0].y);
      context.lineTo(arrow[1].x, arrow[1].y);
      context.lineTo(arrow[2].x, arrow[2].y);
      context.closePath();
      context.fillStyle = "#fff4c9";
      context.shadowColor = "rgba(227,189,102,.75)";
      context.shadowBlur = 2;
      context.fill();
    }

    if (marker.key === selectedHitKey) {
      context.shadowBlur = 0;
      roundedRect(
        marker.x - 5,
        markerY - 5,
        marker.width + 10,
        markerHeight + 10,
        8
      );
      context.strokeStyle = palette.secondary;
      context.lineWidth = 4;
      context.stroke();
    }
    context.restore();
  }
}

export function inspectScoreTarget(
  chart: ChartData,
  target: ScoreHitTarget,
  labels = {
    direction: { left: "Left", right: "Right", none: "None" },
    fever: { inside: "Inside range", outside: "Outside range" }
  }
): ScoreInspectorViewModel {
  const currentBpm = [...chart.bpmEvents]
    .reverse()
    .find((event) => event.time <= target.detailTime);
  const currentSignature = [...chart.timeSignatureEvents]
    .reverse()
    .find((item) => item.time <= target.detailTime);
  const inFever = chart.feverRanges.some(
    (range) =>
      target.detailTime >= range.start && target.detailTime <= range.end
  );
  const typeLabel = {
    tap: "TAP",
    flick: "FLICK",
    trace: "TRACE",
    "long-node": "LONG NODE",
    "long-flick": "LONG FLICK"
  }[target.kind];
  const direction =
    {
      left: labels.direction.left,
      right: labels.direction.right
    }[target.direction ?? ""] ?? labels.direction.none;
  const trackSpan = describeTrackSpan(target.position, target.size);
  const combo =
    chart.comboEvents.find((item) => item.markerId === target.key)?.combo ??
    getCurrentCombo(chart, target.detailTime);

  return {
    typeLabel,
    time: `${target.detailTime.toFixed(3)} s`,
    combo: String(combo),
    lane: `${trackSpan.laneLabel} / 12`,
    position: `${target.position.toFixed(1)} / 24`,
    size: target.size.toFixed(1),
    direction,
    bpm: String(currentBpm?.bpm ?? "—"),
    timeSignature: currentSignature
      ? `${currentSignature.numerator}/${currentSignature.denominator}`
      : "—",
    fever: inFever ? labels.fever.inside : labels.fever.outside
  };
}
