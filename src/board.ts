import type { BoardDocument, BoardTheme, Bounds, ImageObject, Point, Stroke, TextObject } from "./types";

export const BOARD_STORAGE_KEY = "whiteboard.document.v1";
export const SETTINGS_STORAGE_KEY = "whiteboard.recognition.v1";

const MAX_STROKES = 20_000;
const MAX_POINTS_PER_STROKE = 100_000;
const MAX_TOTAL_POINTS = 500_000;
const MAX_TEXT_OBJECTS = 10_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_TOTAL_TEXT_LENGTH = 1_000_000;
const MAX_IMAGE_OBJECTS = 256;
const MAX_IMAGE_DATA_LENGTH = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_DATA_LENGTH = 24 * 1024 * 1024;
const MAX_COORDINATE = 10_000_000;
const MAX_OBJECT_SIZE = 100_000;
export const MAX_LIVE_STROKE_POINTS = 20_000;
export const MAX_DISPLAY_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_DISPLAY_CANVAS_DIMENSION = 8192;

export function canvasPixelRatio(width: number, height: number, requestedRatio: number) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const safeRequested = Number.isFinite(requestedRatio) && requestedRatio > 0 ? requestedRatio : 1;
  let ratio = Math.max(Number.EPSILON, Math.min(
    safeRequested,
    Math.sqrt(MAX_DISPLAY_CANVAS_PIXELS / (safeWidth * safeHeight)),
    MAX_DISPLAY_CANVAS_DIMENSION / safeWidth,
    MAX_DISPLAY_CANVAS_DIMENSION / safeHeight,
  ));
  const roundedPixels = Math.round(safeWidth * ratio) * Math.round(safeHeight * ratio);
  if (roundedPixels > MAX_DISPLAY_CANVAS_PIXELS) {
    ratio *= Math.sqrt(MAX_DISPLAY_CANVAS_PIXELS / roundedPixels) * 0.999999;
  }
  return ratio;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validBoardIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,80}$/.test(value);
}

function validShortString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128;
}

export function defaultBoardTitle(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `Whiteboard ${value("year")}-${value("month")}-${value("day")} ${value("hour")}-${value("minute")}-${value("second")}`;
}

export const createBoard = (): BoardDocument => ({
  version: 1,
  id: crypto.randomUUID(),
  title: defaultBoardTitle(),
  theme: "white",
  grid: true,
  strokes: [],
  textObjects: [],
  imageObjects: [],
  updatedAt: new Date().toISOString(),
});

export function parseBoard(value: string): BoardDocument {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.strokes) || !Array.isArray(parsed.textObjects)) {
    throw new Error("This is not a supported Whiteboard file.");
  }

  const strokes: Stroke[] = [];
  let totalPoints = 0;
  for (const item of parsed.strokes.slice(0, MAX_STROKES)) {
    if (!isRecord(item) || !validIdentifier(item.id) || !validShortString(item.color)
      || !finiteNumber(item.width) || !validShortString(item.pointerType) || !Array.isArray(item.points)) continue;

    const remainingPoints = MAX_TOTAL_POINTS - totalPoints;
    if (remainingPoints <= 0) break;
    const points: Point[] = [];
    for (const point of item.points.slice(0, Math.min(MAX_POINTS_PER_STROKE, remainingPoints))) {
      if (!isRecord(point) || !finiteNumber(point.x) || !finiteNumber(point.y)
        || !finiteNumber(point.pressure)) continue;
      points.push({
        x: clamp(point.x, -MAX_COORDINATE, MAX_COORDINATE),
        y: clamp(point.y, -MAX_COORDINATE, MAX_COORDINATE),
        pressure: clamp(point.pressure, 0, 1),
      });
    }
    if (!points.length) continue;
    totalPoints += points.length;
    strokes.push({
      id: item.id,
      color: item.color,
      width: clamp(item.width, 0.25, 256),
      pointerType: item.pointerType,
      points,
    });
  }

  const textObjects: TextObject[] = [];
  let totalTextLength = 0;
  for (const item of parsed.textObjects.slice(0, MAX_TEXT_OBJECTS)) {
    if (!isRecord(item) || !validIdentifier(item.id) || !finiteNumber(item.x) || !finiteNumber(item.y)
      || typeof item.value !== "string" || !validShortString(item.color)
      || (item.kind !== "text" && item.kind !== "latex")) continue;
    const remainingTextLength = MAX_TOTAL_TEXT_LENGTH - totalTextLength;
    if (remainingTextLength <= 0) break;
    const text = item.value.slice(0, Math.min(MAX_TEXT_LENGTH, remainingTextLength));
    totalTextLength += text.length;
    textObjects.push({
      id: item.id,
      x: clamp(item.x, -MAX_COORDINATE, MAX_COORDINATE),
      y: clamp(item.y, -MAX_COORDINATE, MAX_COORDINATE),
      value: text,
      color: item.color,
      kind: item.kind,
      fontSize: finiteNumber(item.fontSize) ? clamp(item.fontSize, 8, 256) : undefined,
    });
  }

  const imageObjects: ImageObject[] = [];
  let totalImageDataLength = 0;
  if (Array.isArray(parsed.imageObjects)) {
    for (const item of parsed.imageObjects.slice(0, MAX_IMAGE_OBJECTS)) {
      if (!isRecord(item) || !validIdentifier(item.id) || !finiteNumber(item.x) || !finiteNumber(item.y)
        || !finiteNumber(item.width) || !finiteNumber(item.height) || item.width <= 0 || item.height <= 0
        || typeof item.dataUrl !== "string" || item.dataUrl.length > MAX_IMAGE_DATA_LENGTH
        || !/^data:image\/(png|jpeg|webp);base64,/.test(item.dataUrl)) continue;
      if (totalImageDataLength + item.dataUrl.length > MAX_TOTAL_IMAGE_DATA_LENGTH) break;
      totalImageDataLength += item.dataUrl.length;
      imageObjects.push({
        id: item.id,
        x: clamp(item.x, -MAX_COORDINATE, MAX_COORDINATE),
        y: clamp(item.y, -MAX_COORDINATE, MAX_COORDINATE),
        width: clamp(item.width, 1, MAX_OBJECT_SIZE),
        height: clamp(item.height, 1, MAX_OBJECT_SIZE),
        dataUrl: item.dataUrl,
      });
    }
  }

  return {
    version: 1,
    id: validBoardIdentifier(parsed.id) ? parsed.id : crypto.randomUUID(),
    title: typeof parsed.title === "string" ? parsed.title.slice(0, 512) : defaultBoardTitle(),
    theme: parsed.theme === "black" ? "black" : "white",
    grid: parsed.grid !== false,
    strokes,
    textObjects,
    imageObjects,
    updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.length <= 64
      ? parsed.updatedAt
      : new Date().toISOString(),
  };
}

// Uniform-grid spatial index over a strokes array, used to narrow hit-testing
// and viewport culling from an O(n) scan down to the strokes near a query
// region. It is a broad-phase filter only: every consumer still runs the same
// exact narrow-phase check (pointHitsStroke / overlapsBounds / intersectsBounds)
// that the plain linear scan uses, so results are identical by construction.
const SPATIAL_CELL_SIZE = 512;

type StrokeIndex = {
  cellSize: number;
  cells: Map<string, number[]>;
  maxHalfWidth: number;
};

const strokeIndexCache = new WeakMap<Stroke[], StrokeIndex>();

function cellKey(cx: number, cy: number) {
  return `${cx},${cy}`;
}

function cellRange(bounds: Bounds, cellSize: number, pad: number) {
  return {
    minCx: Math.floor((bounds.x - pad) / cellSize),
    maxCx: Math.floor((bounds.x + bounds.width + pad) / cellSize),
    minCy: Math.floor((bounds.y - pad) / cellSize),
    maxCy: Math.floor((bounds.y + bounds.height + pad) / cellSize),
  };
}

function buildStrokeIndex(strokes: Stroke[]): StrokeIndex {
  const cells = new Map<string, number[]>();
  let maxHalfWidth = 0;
  for (let index = 0; index < strokes.length; index += 1) {
    const stroke = strokes[index];
    if (!stroke.points.length) continue;
    maxHalfWidth = Math.max(maxHalfWidth, stroke.width / 2);
    const bounds = cachedStrokeBounds(stroke);
    if (!bounds) continue;
    const { minCx, maxCx, minCy, maxCy } = cellRange(bounds, SPATIAL_CELL_SIZE, 0);
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const key = cellKey(cx, cy);
        let bucket = cells.get(key);
        if (!bucket) {
          bucket = [];
          cells.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  }
  return { cellSize: SPATIAL_CELL_SIZE, cells, maxHalfWidth };
}

function strokeIndexFor(strokes: Stroke[]): StrokeIndex {
  let index = strokeIndexCache.get(strokes);
  if (!index) {
    index = buildStrokeIndex(strokes);
    strokeIndexCache.set(strokes, index);
  }
  return index;
}

// Returns the indices (ascending, matching document order) of strokes whose
// unpadded bounds could fall within `pad` of `bounds`, widened further by the
// widest stroke's half-width so no stroke that a narrow-phase check could
// still accept is ever excluded.
export function queryStrokeIndices(strokes: Stroke[], bounds: Bounds, pad: number): number[] {
  const index = strokeIndexFor(strokes);
  const { minCx, maxCx, minCy, maxCy } = cellRange(bounds, index.cellSize, pad + index.maxHalfWidth);
  const seen = new Set<number>();
  for (let cx = minCx; cx <= maxCx; cx += 1) {
    for (let cy = minCy; cy <= maxCy; cy += 1) {
      const bucket = index.cells.get(cellKey(cx, cy));
      if (!bucket) continue;
      for (const strokeIndex of bucket) seen.add(strokeIndex);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

const imageCache = new Map<string, HTMLImageElement>();
const strokeBoundsCache = new WeakMap<Stroke, Bounds>();
type StrokeRenderGeometry =
  | { kind: "single"; pressure: number; path: Path2D }
  | { kind: "uniform"; pressure: number; path: Path2D }
  | { kind: "variable"; paths: Array<[number, Path2D]> };
const strokeRenderCache = new WeakMap<Stroke, StrokeRenderGeometry>();

function overlapsBounds(item: Bounds, visible: Bounds, padding = 0) {
  return item.x <= visible.x + visible.width + padding
    && item.x + item.width >= visible.x - padding
    && item.y <= visible.y + visible.height + padding
    && item.y + item.height >= visible.y - padding;
}

function cachedStrokeBounds(stroke: Stroke) {
  const cached = strokeBoundsCache.get(stroke);
  if (cached) return cached;
  const bounds = strokeBounds([stroke]);
  if (bounds) strokeBoundsCache.set(stroke, bounds);
  return bounds;
}

function cachedStrokeGeometry(stroke: Stroke): StrokeRenderGeometry {
  const cached = strokeRenderCache.get(stroke);
  if (cached) return cached;
  const first = stroke.points[0];
  if (stroke.points.length === 1) {
    const path = new Path2D();
    path.moveTo(first.x, first.y);
    path.lineTo(first.x + 0.01, first.y + 0.01);
    const geometry = { kind: "single", pressure: first.pressure, path } satisfies StrokeRenderGeometry;
    strokeRenderCache.set(stroke, geometry);
    return geometry;
  }
  let minimumPressure = 1;
  let maximumPressure = 0;
  for (const point of stroke.points) {
    minimumPressure = Math.min(minimumPressure, point.pressure);
    maximumPressure = Math.max(maximumPressure, point.pressure);
  }
  if (maximumPressure - minimumPressure <= 0.025) {
    const path = new Path2D();
    path.moveTo(first.x, first.y);
    for (let index = 1; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1];
      const point = stroke.points[index];
      if (index === stroke.points.length - 1) path.quadraticCurveTo(previous.x, previous.y, point.x, point.y);
      else path.quadraticCurveTo(previous.x, previous.y, (previous.x + point.x) / 2, (previous.y + point.y) / 2);
    }
    const geometry = { kind: "uniform", pressure: first.pressure, path } satisfies StrokeRenderGeometry;
    strokeRenderCache.set(stroke, geometry);
    return geometry;
  }
  const pressureSteps = 12;
  const paths = new Map<number, Path2D>();
  for (let index = 1; index < stroke.points.length; index += 1) {
    const previous = stroke.points[index - 1];
    const point = stroke.points[index];
    const pressure = Math.min(1, Math.max(0, (previous.pressure + point.pressure) / 2));
    const step = Math.round(pressure * (pressureSteps - 1));
    let path = paths.get(step);
    if (!path) {
      path = new Path2D();
      paths.set(step, path);
    }
    path.moveTo(previous.x, previous.y);
    path.lineTo(point.x, point.y);
  }
  const geometry = { kind: "variable", paths: [...paths] } satisfies StrokeRenderGeometry;
  strokeRenderCache.set(stroke, geometry);
  return geometry;
}

export function pruneImageCache(imageObjects: readonly ImageObject[]) {
  const activeSources = new Set(imageObjects.map((item) => item.dataUrl));
  for (const [source, image] of imageCache) {
    if (activeSources.has(source)) continue;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    imageCache.delete(source);
  }
}

function cachedImage(source: string) {
  let image = imageCache.get(source);
  if (image) return image;
  image = new Image();
  image.onload = () => window.dispatchEvent(new Event("whiteboard-image-loaded"));
  image.src = source;
  imageCache.set(source, image);
  return image;
}

export function strokeBounds(strokes: Stroke[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

export function intersectsBounds(stroke: Stroke, bounds: Bounds): boolean {
  const padding = stroke.width / 2;
  const left = bounds.x - padding;
  const right = bounds.x + bounds.width + padding;
  const top = bounds.y - padding;
  const bottom = bounds.y + bounds.height + padding;
  const inside = (point: Point) => point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
  if (stroke.points.some(inside)) return true;

  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = stroke.points[index - 1];
    const end = stroke.points[index];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    let minimum = 0;
    let maximum = 1;
    for (const [p, q] of [[-dx, start.x - left], [dx, right - start.x], [-dy, start.y - top], [dy, bottom - start.y]]) {
      if (p === 0 && q < 0) {
        minimum = 1;
        maximum = 0;
        break;
      }
      if (p === 0) continue;
      const ratio = q / p;
      if (p < 0) minimum = Math.max(minimum, ratio);
      else maximum = Math.min(maximum, ratio);
    }
    if (minimum <= maximum) return true;
  }
  return false;
}

export function pointHitsStroke(x: number, y: number, stroke: Stroke, radius: number): boolean {
  const hitRadius = radius + stroke.width / 2;
  const bounds = cachedStrokeBounds(stroke);
  if (!bounds || x < bounds.x - hitRadius || x > bounds.x + bounds.width + hitRadius
    || y < bounds.y - hitRadius || y > bounds.y + bounds.height + hitRadius) return false;
  if (stroke.points.length === 1) return Math.hypot(stroke.points[0].x - x, stroke.points[0].y - y) <= hitRadius;
  for (let index = 1; index < stroke.points.length; index += 1) {
    if (pointToSegment(stroke.points[index - 1], stroke.points[index], x, y).distance <= hitRadius) return true;
  }
  return false;
}

// Plain O(n) scan, kept for the equivalence benchmark/tests and as a reference
// implementation of the exact semantics eraseStrokesAt must preserve.
export function eraseStrokesAtLinear(strokes: Stroke[], x: number, y: number, radius: number): Stroke[] {
  let remaining: Stroke[] | null = null;
  for (let index = 0; index < strokes.length; index += 1) {
    const stroke = strokes[index];
    if (pointHitsStroke(x, y, stroke, radius)) {
      remaining ??= strokes.slice(0, index);
    } else if (remaining) {
      remaining.push(stroke);
    }
  }
  return remaining ?? strokes;
}

export function eraseStrokesAt(strokes: Stroke[], x: number, y: number, radius: number): Stroke[] {
  const bounds: Bounds = { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 };
  const candidates = queryStrokeIndices(strokes, bounds, 0);
  if (!candidates.length) return strokes;
  const hits = new Set<number>();
  for (const index of candidates) {
    if (pointHitsStroke(x, y, strokes[index], radius)) hits.add(index);
  }
  if (!hits.size) return strokes;
  return strokes.filter((_, index) => !hits.has(index));
}

// Same result as strokes.filter((stroke) => intersectsBounds(stroke, bounds)),
// narrowed first by the spatial index instead of scanning every stroke.
export function strokesIntersectingBounds(strokes: Stroke[], bounds: Bounds): Stroke[] {
  const candidates = queryStrokeIndices(strokes, bounds, 0);
  const result: Stroke[] = [];
  for (const index of candidates) {
    const stroke = strokes[index];
    if (intersectsBounds(stroke, bounds)) result.push(stroke);
  }
  return result;
}

function pointToSegment(start: Point, end: Point, x: number, y: number) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared > 0 ? Math.min(1, Math.max(0, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared)) : 0;
  return {
    distance: Math.hypot(x - (start.x + dx * projection), y - (start.y + dy * projection)),
    projection,
  };
}

function redundantPointScore(start: Point, point: Point, end: Point, geometryTolerance: number, pressureTolerance: number) {
  const geometry = pointToSegment(start, end, point.x, point.y);
  const expectedPressure = start.pressure + (end.pressure - start.pressure) * geometry.projection;
  return Math.max(geometry.distance / geometryTolerance, Math.abs(point.pressure - expectedPressure) / pressureTolerance);
}

function compactStrokePoints(points: Point[], geometryTolerance: number, pressureTolerance: number) {
  if (points.length < 3) return points;
  const compacted = [points[0]];
  const lastIndex = points.length - 1;
  for (let index = 1; index < lastIndex; index += 2) {
    const next = points[Math.min(lastIndex, index + 2)];
    const first = points[index];
    const second = points[Math.min(lastIndex - 1, index + 1)];
    const start = compacted[compacted.length - 1];
    compacted.push(
      redundantPointScore(start, first, next, geometryTolerance, pressureTolerance)
        >= redundantPointScore(start, second, next, geometryTolerance, pressureTolerance)
        ? first
        : second,
    );
  }
  if (compacted[compacted.length - 1] !== points[lastIndex]) compacted.push(points[lastIndex]);
  return compacted;
}

export function appendStrokePoint(stroke: Stroke, point: Point) {
  strokeBoundsCache.delete(stroke);
  strokeRenderCache.delete(stroke);
  const geometryTolerance = Math.min(0.6, Math.max(0.08, stroke.width * 0.06));
  const pressureTolerance = Math.min(0.05, Math.max(0.012, 0.1 / (0.65 * Math.max(stroke.width, 0.25))));
  const maximumSpan = Math.min(24, Math.max(8, stroke.width * 3));
  if (stroke.points.length >= MAX_LIVE_STROKE_POINTS) {
    stroke.points = compactStrokePoints(stroke.points, geometryTolerance, pressureTolerance);
  }
  if (!stroke.points.length) {
    stroke.points.push(point);
    return;
  }
  if (stroke.points.length === 1) {
    const first = stroke.points[0];
    if (Math.hypot(point.x - first.x, point.y - first.y) <= geometryTolerance
      && Math.abs(point.pressure - first.pressure) <= pressureTolerance) {
      stroke.points[0] = point;
    } else {
      stroke.points.push(point);
    }
    return;
  }
  const start = stroke.points[stroke.points.length - 2];
  const current = stroke.points[stroke.points.length - 1];
  const directionContinues = (current.x - start.x) * (point.x - current.x) + (current.y - start.y) * (point.y - current.y) >= 0;
  const spanWithinLimit = Math.hypot(point.x - start.x, point.y - start.y) <= maximumSpan;
  if (directionContinues && spanWithinLimit && redundantPointScore(start, current, point, geometryTolerance, pressureTolerance) <= 1) {
    stroke.points[stroke.points.length - 1] = point;
  } else {
    stroke.points.push(point);
  }
}

export function textObjectBounds(item: TextObject): Bounds {
  const lines = item.value.split("\n");
  const fontSize = item.fontSize ?? 20;
  return {
    x: item.x,
    y: item.y,
    width: Math.max(fontSize * 2, Math.min(fontSize * 24, Math.max(...lines.map((line) => line.length), 1) * fontSize * 0.6)),
    height: Math.max(fontSize * 1.4, lines.length * fontSize * 1.4),
  };
}

export function inkColor(color: string, theme: BoardTheme): string {
  return color === "auto" ? (theme === "white" ? "#17191c" : "#f3f4f1") : color;
}

export function drawGrid(
  context: CanvasRenderingContext2D,
  bounds: Bounds,
  theme: BoardTheme,
  scale: number,
) {
  const minorSpacing = scale < 0.55 ? 160 : 32;
  const majorSpacing = 160;
  const startX = Math.floor(bounds.x / minorSpacing) * minorSpacing;
  const endX = bounds.x + bounds.width;
  const startY = Math.floor(bounds.y / minorSpacing) * minorSpacing;
  const endY = bounds.y + bounds.height;

  context.save();
  context.lineWidth = 1 / scale;
  for (let x = startX; x <= endX; x += minorSpacing) {
    const major = Math.round(x) % majorSpacing === 0;
    context.strokeStyle = theme === "white"
      ? `rgba(32, 35, 40, ${major ? 0.105 : 0.052})`
      : `rgba(243, 244, 241, ${major ? 0.105 : 0.05})`;
    context.beginPath();
    context.moveTo(x, bounds.y);
    context.lineTo(x, endY);
    context.stroke();
  }
  for (let y = startY; y <= endY; y += minorSpacing) {
    const major = Math.round(y) % majorSpacing === 0;
    context.strokeStyle = theme === "white"
      ? `rgba(32, 35, 40, ${major ? 0.105 : 0.052})`
      : `rgba(243, 244, 241, ${major ? 0.105 : 0.05})`;
    context.beginPath();
    context.moveTo(bounds.x, y);
    context.lineTo(endX, y);
    context.stroke();
  }
  context.restore();
}

export function drawBoard(
  context: CanvasRenderingContext2D,
  strokes: Stroke[],
  textObjects: TextObject[],
  imageObjects: ImageObject[],
  theme: BoardTheme,
  selectedIds: Set<string> = new Set(),
  drawLatexSource = false,
  drawPlainText = true,
  visibleBounds?: Bounds,
) {
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const item of imageObjects) {
    if (visibleBounds && !overlapsBounds(item, visibleBounds)) continue;
    const image = cachedImage(item.dataUrl);
    if (image.complete && image.naturalWidth) context.drawImage(image, item.x, item.y, item.width, item.height);
    if (selectedIds.has(item.id)) {
      context.save();
      context.strokeStyle = "#377d6a";
      context.lineWidth = 1;
      context.setLineDash([5, 4]);
      context.strokeRect(item.x - 5, item.y - 5, item.width + 10, item.height + 10);
      context.restore();
    }
  }

  const strokeIndices = visibleBounds ? queryStrokeIndices(strokes, visibleBounds, 0) : strokes.keys();
  for (const strokeIndex of strokeIndices) {
    const stroke = strokes[strokeIndex];
    if (!stroke.points.length) continue;
    const bounds = visibleBounds ? cachedStrokeBounds(stroke) : null;
    if (visibleBounds && (!bounds || !overlapsBounds(bounds, visibleBounds, stroke.width / 2))) continue;
    context.strokeStyle = inkColor(stroke.color, theme);
    const geometry = cachedStrokeGeometry(stroke);
    if (geometry.kind === "single" || geometry.kind === "uniform") {
      context.lineWidth = stroke.width * (0.55 + geometry.pressure * 0.65);
      context.stroke(geometry.path);
    } else {
      const pressureSteps = 12;
      for (const [step, path] of geometry.paths) {
        context.lineWidth = stroke.width * (0.55 + (step / (pressureSteps - 1)) * 0.65);
        context.stroke(path);
      }
    }

    if (selectedIds.has(stroke.id)) {
      context.save();
      context.strokeStyle = "#377d6a";
      context.lineWidth = 1;
      context.setLineDash([5, 4]);
      const selectedBounds = bounds ?? cachedStrokeBounds(stroke);
      if (selectedBounds) context.strokeRect(selectedBounds.x - 5, selectedBounds.y - 5, selectedBounds.width + 10, selectedBounds.height + 10);
      context.restore();
    }
  }

  context.textBaseline = "top";
  for (const item of textObjects) {
    const bounds = visibleBounds || selectedIds.has(item.id) ? textObjectBounds(item) : null;
    if (visibleBounds && bounds && !overlapsBounds(bounds, visibleBounds)) continue;
    if ((item.kind === "text" && drawPlainText) || (item.kind === "latex" && drawLatexSource)) {
      context.fillStyle = inkColor(item.color, theme);
      const fontSize = item.fontSize ?? 20;
      context.font = `${fontSize}px system-ui, sans-serif`;
      const lines = item.value.split("\n");
      lines.forEach((line, index) => context.fillText(line, item.x, item.y + index * fontSize * 1.4));
    }
    if (selectedIds.has(item.id)) {
      context.save();
      context.strokeStyle = "#377d6a";
      context.lineWidth = 1;
      context.setLineDash([5, 4]);
      if (bounds) context.strokeRect(bounds.x - 5, bounds.y - 5, bounds.width + 10, bounds.height + 10);
      context.restore();
    }
  }
}

export function renderSelectionImage(strokes: Stroke[], theme: BoardTheme, cropBounds?: Bounds): { base64: string; bounds: Bounds } | null {
  const contentBounds = strokeBounds(strokes);
  if (!contentBounds) return null;
  const bounds = cropBounds ?? contentBounds;
  if (!bounds) return null;
  const padding = 28;
  const width = Math.ceil(bounds.width + padding * 2);
  const height = Math.ceil(bounds.height + padding * 2);
  const scale = Math.min(3, 1100 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }
  try {
    context.scale(scale, scale);
    context.fillStyle = theme === "white" ? "#fcfcfa" : "#121416";
    context.fillRect(0, 0, width, height);
    context.translate(-bounds.x + padding, -bounds.y + padding);
    drawBoard(context, strokes, [], [], theme);
    return { base64: canvas.toDataURL("image/png").split(",")[1], bounds };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
