import type { BoardDocument, BoardTheme, Bounds, ImageObject, Stroke, TextObject } from "./types";

export const BOARD_STORAGE_KEY = "whiteboard.document.v1";
export const SETTINGS_STORAGE_KEY = "whiteboard.recognition.v1";

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
  const parsed = JSON.parse(value) as Partial<BoardDocument>;
  if (parsed.version !== 1 || !Array.isArray(parsed.strokes) || !Array.isArray(parsed.textObjects)) {
    throw new Error("This is not a supported Whiteboard file.");
  }
  return {
    ...createBoard(),
    ...parsed,
    id: typeof parsed.id === "string" && parsed.id ? parsed.id : crypto.randomUUID(),
    title: typeof parsed.title === "string" ? parsed.title : defaultBoardTitle(),
    theme: parsed.theme === "black" ? "black" : "white",
    grid: parsed.grid !== false,
    imageObjects: Array.isArray(parsed.imageObjects)
      ? parsed.imageObjects.filter((item): item is ImageObject => Boolean(
        item && typeof item.id === "string" && typeof item.x === "number" && typeof item.y === "number"
        && typeof item.width === "number" && typeof item.height === "number"
        && typeof item.dataUrl === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(item.dataUrl),
      ))
      : [],
  };
}

const imageCache = new Map<string, HTMLImageElement>();

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
  const points = strokes.flatMap((stroke) => stroke.points);
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

export function intersectsBounds(stroke: Stroke, bounds: Bounds): boolean {
  return stroke.points.some(
    (point) =>
      point.x >= bounds.x &&
      point.x <= bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height,
  );
}

export function pointHitsStroke(x: number, y: number, stroke: Stroke, radius: number): boolean {
  return stroke.points.some((point) => Math.hypot(point.x - x, point.y - y) <= radius + stroke.width / 2);
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
) {
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const item of imageObjects) {
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

  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    context.beginPath();
    context.strokeStyle = inkColor(stroke.color, theme);
    const first = stroke.points[0];
    context.moveTo(first.x, first.y);

    if (stroke.points.length === 1) {
      context.lineTo(first.x + 0.01, first.y + 0.01);
    } else {
      for (let index = 1; index < stroke.points.length; index += 1) {
        const previous = stroke.points[index - 1];
        const point = stroke.points[index];
        context.lineWidth = stroke.width * (0.55 + point.pressure * 0.65);
        context.quadraticCurveTo(previous.x, previous.y, (previous.x + point.x) / 2, (previous.y + point.y) / 2);
      }
    }
    context.stroke();

    if (selectedIds.has(stroke.id)) {
      context.save();
      context.strokeStyle = "#377d6a";
      context.lineWidth = 1;
      context.setLineDash([5, 4]);
      const bounds = strokeBounds([stroke]);
      if (bounds) context.strokeRect(bounds.x - 5, bounds.y - 5, bounds.width + 10, bounds.height + 10);
      context.restore();
    }
  }

  context.textBaseline = "top";
  context.font = "20px system-ui, sans-serif";
  for (const item of textObjects) {
    if (item.kind === "latex" && !drawLatexSource) continue;
    context.fillStyle = inkColor(item.color, theme);
    const lines = item.value.split("\n");
    lines.forEach((line, index) => context.fillText(line, item.x, item.y + index * 28));
  }
}

export function renderSelectionImage(strokes: Stroke[], theme: BoardTheme, cropBounds?: Bounds): { base64: string; bounds: Bounds } | null {
  if (!strokeBounds(strokes)) return null;
  const bounds = cropBounds ?? strokeBounds(strokes);
  if (!bounds) return null;
  const padding = 28;
  const width = Math.ceil(bounds.width + padding * 2);
  const height = Math.ceil(bounds.height + padding * 2);
  const scale = Math.min(3, Math.max(1, 1100 / Math.max(width, height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(scale, scale);
  context.fillStyle = theme === "white" ? "#fcfcfa" : "#121416";
  context.fillRect(0, 0, width, height);
  context.translate(-bounds.x + padding, -bounds.y + padding);
  drawBoard(context, strokes, [], [], theme);
  return { base64: canvas.toDataURL("image/png").split(",")[1], bounds };
}
