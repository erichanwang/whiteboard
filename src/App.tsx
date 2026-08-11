import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowsOutSimple,
  Books,
  Broom,
  Chalkboard,
  Check,
  DownloadSimple,
  DeviceTablet,
  Eraser,
  FilePlus,
  FloppyDisk,
  GearSix,
  GridFour,
  Hand,
  ClipboardText,
  ImageSquare,
  MagicWand,
  Function as FunctionIcon,
  LockKey,
  Minus,
  PencilSimple,
  Plus,
  Selection,
  Student,
  TextT,
  Trash,
  X,
} from "@phosphor-icons/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  BOARD_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  addStroke,
  appendStrokePoint,
  canvasPixelRatio,
  createBoard,
  createLayerCache,
  defaultBoardTitle,
  drawBoard,
  drawGrid,
  eraseStrokesAt,
  inkColor,
  paintLayerCache,
  parseBoard,
  pruneImageCache,
  renderSelectionImage,
  serializeBoard,
  strokeBounds,
  strokesIntersectingBounds,
  textObjectBounds,
} from "./board";
import { listNvidiaModels, recognizeInk } from "./recognition";
import { PRACTICE_SETS, practiceCount, practiceLabel } from "./practice";
import type {
  BoardDocument,
  Bounds,
  Point,
  RecognitionMode,
  RecognitionSettings,
  Stroke,
  TextObject,
  Tool,
} from "./types";

const LatexMarkup = lazy(() => import("./LatexMarkup"));

const COLORS = ["auto", "#356f9f", "#b54d4d", "#377d6a", "#b47728"];
const INPUT_STORAGE_KEY = "whiteboard.input.v1";
const UI_STORAGE_KEY = "whiteboard.ui.v1";
const RECENT_BOARD_STORAGE_KEY = "whiteboard.recent-board.v1";
const DEFAULT_SETTINGS: RecognitionSettings = {
  provider: "nvidia",
  model: "mistralai/mistral-large-3-675b-instruct-2512",
  samples: [],
  corrections: [],
  handwritingFontEnabled: false,
};
const PROFILE_SAMPLE_LIMIT = 600;
const PROFILE_CORRECTION_LIMIT = 100;
const PROFILE_STORAGE_LIMIT = 8 * 1024 * 1024;
const PROFILE_IMAGE_LIMIT = 1024 * 1024;
const PROFILE_IMAGE_TOTAL_LIMIT = 4 * 1024 * 1024;
const PROFILE_TEXT_LIMIT = 8192;
const MAX_PNG_EXPORT_BYTES = 80 * 1024 * 1024;
const MINIMUM_STARTUP_MS = 220;
const EMPTY_SELECTION = new Set<string>();

type SaveState = "saved" | "saving" | "error";
type RecognitionState = "idle" | "loading" | "result" | "error";
type RecognitionScope = "visible" | "selection" | "board";
type InputBindings = { leftKeys: string[]; middleKeys: string[]; rightKeys: string[] };
type LegacyInputBindings = {
  leftKey: string;
  middleKey: string;
  rightKey: string;
  drawKey: string;
  panKey: string;
  selectKey: string;
};
type UiPreferences = {
  tool: Tool;
  color: string;
  width: number;
  theme: BoardDocument["theme"];
  grid: boolean;
};
type LibraryBoard = { id: string; title: string; updatedAt: string };
type LibraryBoardPage = { boards: LibraryBoard[]; hasMore: boolean };
type EncryptionRequest = { action: "save" | "open" };
type TextEditorRequest = {
  kind: "text" | "latex";
  value: string;
  boardX: number;
  boardY: number;
  anchorX: number;
  anchorY: number;
  targetId?: string;
};
type HandwritingGlyphCacheEntry = {
  sampleId: string;
  sampleImage: string;
  glyph: HandwritingGlyph | null;
};
type SelectionTransform = {
  mode: "move" | "resize";
  start: Point;
  bounds: Bounds;
  original: BoardDocument;
  ids: Set<string>;
  selectedStrokes: BoardDocument["strokes"];
  selectedTextObjects: BoardDocument["textObjects"];
  selectedImageObjects: BoardDocument["imageObjects"];
  unselectedStrokes: BoardDocument["strokes"];
  unselectedTextObjects: BoardDocument["textObjects"];
  unselectedImageObjects: BoardDocument["imageObjects"];
  changed: boolean;
};
type SelectionTransformPreview = {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
};
type RecognitionAttempt = { image: string; bounds: Bounds; mode: RecognitionMode };
type HandwritingGlyph = { dataUrl: string; aspect: number };

const DEFAULT_INPUT_BINDINGS: InputBindings = { leftKeys: ["z"], middleKeys: [" "], rightKeys: ["x"] };
const LIBRARY_PAGE_SIZE = 50;

function storedKeys(value: unknown, fallback: string[]) {
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && key.length > 0 && key.toLowerCase() !== "m") : fallback;
}

function loadInputBindings(): InputBindings {
  try {
    const parsed = JSON.parse(localStorage.getItem(INPUT_STORAGE_KEY) ?? "null") as (Partial<InputBindings> & Partial<LegacyInputBindings>) | null;
    return {
      leftKeys: storedKeys(parsed?.leftKeys, [parsed?.leftKey ?? parsed?.drawKey ?? DEFAULT_INPUT_BINDINGS.leftKeys[0]]),
      middleKeys: storedKeys(parsed?.middleKeys, [parsed?.middleKey ?? parsed?.panKey ?? DEFAULT_INPUT_BINDINGS.middleKeys[0]]),
      rightKeys: storedKeys(parsed?.rightKeys, [parsed?.rightKey ?? parsed?.selectKey ?? DEFAULT_INPUT_BINDINGS.rightKeys[0]]),
    };
  } catch {
    return DEFAULT_INPUT_BINDINGS;
  }
}

function keyLabel(key: string) {
  return key === " " ? "Space" : key;
}

function loadUiPreferences(): UiPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_STORAGE_KEY) ?? "null") as Partial<UiPreferences> | null;
    const tools: Tool[] = ["pen", "eraser", "select", "hand", "text"];
    return {
      tool: tools.includes(parsed?.tool as Tool) ? parsed?.tool as Tool : "pen",
      color: typeof parsed?.color === "string" ? parsed.color : "auto",
      width: typeof parsed?.width === "number" ? Math.min(18, Math.max(1, parsed.width)) : 4,
      theme: parsed?.theme === "black" ? "black" : "white",
      grid: parsed?.grid !== false,
    };
  } catch {
    return { tool: "pen", color: "auto", width: 4, theme: "white", grid: true };
  }
}

function loadBoard(): BoardDocument {
  try {
    const saved = localStorage.getItem(BOARD_STORAGE_KEY);
    if (saved) return parseBoard(saved);
    const preferences = loadUiPreferences();
    return { ...createBoard(), theme: preferences.theme, grid: preferences.grid };
  } catch {
    localStorage.removeItem(BOARD_STORAGE_KEY);
    return createBoard();
  }
}

function loadNativeRestoreBoardId() {
  if (!isTauri() || localStorage.getItem(BOARD_STORAGE_KEY)) return null;
  const boardId = localStorage.getItem(RECENT_BOARD_STORAGE_KEY);
  return boardId && /^[A-Za-z0-9-]{1,80}$/.test(boardId) ? boardId : null;
}

function markNativeBoardSaved(boardId: string) {
  try {
    if (localStorage.getItem(RECENT_BOARD_STORAGE_KEY) !== boardId) {
      localStorage.setItem(RECENT_BOARD_STORAGE_KEY, boardId);
    }
    if (localStorage.getItem(BOARD_STORAGE_KEY) !== null) {
      localStorage.removeItem(BOARD_STORAGE_KEY);
    }
  } catch {
    // Keep the full recovery copy if the recent-board marker cannot be stored.
  }
}

function loadSettings(): RecognitionSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!saved) return DEFAULT_SETTINGS;
    if (saved.length > PROFILE_STORAGE_LIMIT) return DEFAULT_SETTINGS;
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_SETTINGS;
    const parsed = value as Record<string, unknown>;
    const samples = normalizeProfileSamples(parsed.samples);
    const corrections = normalizeCorrections(parsed.corrections);
    const model = typeof parsed.model === "string"
      && parsed.model.length <= 256
      && parsed.model.includes("/")
      && /^[A-Za-z0-9._/-]+$/.test(parsed.model)
      ? parsed.model
      : DEFAULT_SETTINGS.model;
    return {
      provider: "nvidia",
      model,
      handwritingFontEnabled: parsed.handwritingFontEnabled === true,
      samples,
      corrections,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function boundedProfileString(value: unknown, limit: number) {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : null;
}

function normalizeProfileSamples(value: unknown): RecognitionSettings["samples"] {
  if (!Array.isArray(value)) return [];
  const samples: RecognitionSettings["samples"] = [];
  let imageCharacters = 0;
  for (let index = value.length - 1; index >= 0 && samples.length < PROFILE_SAMPLE_LIMIT; index -= 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const sample = item as Record<string, unknown>;
    const id = boundedProfileString(sample.id, 128);
    const label = boundedProfileString(sample.label, PROFILE_TEXT_LIMIT);
    const image = boundedProfileString(sample.image, PROFILE_IMAGE_LIMIT);
    const createdAt = boundedProfileString(sample.createdAt, 64);
    if (!id || !label || !image || !createdAt || image.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image)) continue;
    if (imageCharacters + image.length > PROFILE_IMAGE_TOTAL_LIMIT) continue;
    const exercise = sample.exercise === undefined ? undefined : boundedProfileString(sample.exercise, 64);
    const mode = sample.mode === "text" || sample.mode === "latex" ? sample.mode : undefined;
    imageCharacters += image.length;
    samples.push({ id, label, image, createdAt, ...(exercise ? { exercise } : {}), ...(mode ? { mode } : {}) });
  }
  return samples.reverse();
}

function normalizeCorrections(value: unknown): RecognitionSettings["corrections"] {
  if (!Array.isArray(value)) return [];
  const corrections: RecognitionSettings["corrections"] = [];
  for (let index = value.length - 1; index >= 0 && corrections.length < PROFILE_CORRECTION_LIMIT; index -= 1) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const correction = item as Record<string, unknown>;
    const id = boundedProfileString(correction.id, 128);
    const original = boundedProfileString(correction.original, PROFILE_TEXT_LIMIT);
    const corrected = boundedProfileString(correction.corrected, PROFILE_TEXT_LIMIT);
    const createdAt = boundedProfileString(correction.createdAt, 64);
    const mode = correction.mode === "text" || correction.mode === "latex" ? correction.mode : null;
    if (id && original && corrected && createdAt && mode) corrections.push({ id, original, corrected, createdAt, mode });
  }
  return corrections.reverse();
}

function canStoreProfileSample(sample: RecognitionSettings["samples"][number]) {
  return normalizeProfileSamples([sample]).length === 1;
}

function canStoreCorrection(correction: RecognitionSettings["corrections"][number]) {
  return normalizeCorrections([correction]).length === 1;
}

const HISTORY_ENTRY_LIMIT = 80;
const HISTORY_MEMORY_LIMIT = 16 * 1024 * 1024;
const boardSizeCache = new WeakMap<BoardDocument, number>();

export function estimatedBoardBytes(board: BoardDocument) {
  const cached = boardSizeCache.get(board);
  if (cached !== undefined) return cached;
  const textBytes = (board.title.length + board.textObjects.reduce((total, item) => (
    total + item.id.length + item.value.length + item.color.length + item.kind.length
  ), 0) + board.imageObjects.reduce((total, item) => total + item.id.length + item.dataUrl.length, 0)) * 2;
  const strokeBytes = board.strokes.reduce((total, stroke) => (
    total + (stroke.id.length + stroke.color.length + stroke.pointerType.length) * 2 + 32 + stroke.points.length * 32
  ), 0);
  const bytes = 256 + textBytes + strokeBytes + board.textObjects.length * 64 + board.imageObjects.length * 64;
  boardSizeCache.set(board, bytes);
  return bytes;
}

function pushHistory(stack: BoardDocument[], board: BoardDocument) {
  stack.push(board);
  let bytes = stack.reduce((total, entry) => total + estimatedBoardBytes(entry), 0);
  while (stack.length > 1 && (stack.length > HISTORY_ENTRY_LIMIT || bytes > HISTORY_MEMORY_LIMIT)) {
    bytes -= estimatedBoardBytes(stack.shift()!);
  }
}

function bytesToDataUrl(bytes: Uint8Array, mime: string) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

function encodeHeaderValue(value: string) {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}

function defaultExternalName(title: string, suffix: string) {
  const cleaned = title.replace(/[\u0000-\u001f\u007f/\\]/g, "-").trim().slice(0, 240);
  const base = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "Whiteboard";
  return `${base}${suffix}`;
}

async function optimizeEmbeddedImage(
  source: string,
  bytes: Uint8Array,
  mime: string,
  expectedDimensions: { width: number; height: number },
) {
  const maximumDimension = 2048;
  const image = new Image();
  let canvas: HTMLCanvasElement | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The selected file is not a supported image."));
      image.src = source;
    });
    const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
    if (dimensions.width !== expectedDimensions.width || dimensions.height !== expectedDimensions.height) {
      throw new Error("The image dimensions do not match its file header.");
    }
    if (bytes.byteLength <= 1.5 * 1024 * 1024 && dimensions.width <= maximumDimension && dimensions.height <= maximumDimension) {
      return { dataUrl: await bytesToDataUrl(bytes, mime), ...dimensions };
    }
    const ratio = Math.min(1, maximumDimension / dimensions.width, maximumDimension / dimensions.height);
    const width = Math.max(1, Math.round(dimensions.width * ratio));
    const height = Math.max(1, Math.round(dimensions.height * ratio));
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the image for this board.");
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      canvas!.toBlob((blob) => {
        if (!blob) return reject(new Error("Could not compress the image for this board."));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("Could not read the compressed image."));
        reader.readAsDataURL(blob);
      }, "image/webp", 0.86);
    });
    return { dataUrl, width, height };
  } finally {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export async function prepareEmbeddedImage(
  bytes: Uint8Array,
  mime: string,
  dimensions: { width: number; height: number },
) {
  const source = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    return await optimizeEmbeddedImage(source, bytes, mime, dimensions);
  } finally {
    URL.revokeObjectURL(source);
  }
}

function selectedBoardIds(board: BoardDocument, bounds: Bounds) {
  return new Set([
    ...strokesIntersectingBounds(board.strokes, bounds).map((stroke) => stroke.id),
    ...board.imageObjects.filter((item) => (
      item.x <= bounds.x + bounds.width && item.x + item.width >= bounds.x
      && item.y <= bounds.y + bounds.height && item.y + item.height >= bounds.y
    )).map((item) => item.id),
    ...board.textObjects.filter((item) => {
      const itemBounds = textObjectBounds(item);
      return itemBounds.x <= bounds.x + bounds.width && itemBounds.x + itemBounds.width >= bounds.x
        && itemBounds.y <= bounds.y + bounds.height && itemBounds.y + itemBounds.height >= bounds.y;
    }).map((item) => item.id),
  ]);
}

function selectedContentBounds(board: BoardDocument, ids: Set<string>): Bounds | null {
  const bounds = [
    strokeBounds(board.strokes.filter((item) => ids.has(item.id))),
    ...board.textObjects.filter((item) => ids.has(item.id)).map(textObjectBounds),
    ...board.imageObjects.filter((item) => ids.has(item.id)).map((item) => ({ x: item.x, y: item.y, width: item.width, height: item.height })),
  ].filter((item): item is Bounds => Boolean(item));
  if (!bounds.length) return null;
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function transformSelection(board: BoardDocument, ids: Set<string>, bounds: Bounds, offsetX: number, offsetY: number, scaleX = 1, scaleY = 1): BoardDocument {
  const averageScale = (scaleX + scaleY) / 2;
  const transformPoint = (point: Point): Point => ({
    ...point,
    x: bounds.x + (point.x - bounds.x) * scaleX + offsetX,
    y: bounds.y + (point.y - bounds.y) * scaleY + offsetY,
  });
  return {
    ...board,
    strokes: board.strokes.map((item) => ids.has(item.id) ? {
      ...item,
      width: Math.max(1, item.width * averageScale),
      points: item.points.map(transformPoint),
    } : item),
    textObjects: board.textObjects.map((item) => ids.has(item.id) ? {
      ...item,
      x: bounds.x + (item.x - bounds.x) * scaleX + offsetX,
      y: bounds.y + (item.y - bounds.y) * scaleY + offsetY,
      fontSize: Math.max(8, (item.fontSize ?? 20) * averageScale),
    } : item),
    imageObjects: board.imageObjects.map((item) => ids.has(item.id) ? {
      ...item,
      x: bounds.x + (item.x - bounds.x) * scaleX + offsetX,
      y: bounds.y + (item.y - bounds.y) * scaleY + offsetY,
      width: Math.max(8, item.width * scaleX),
      height: Math.max(8, item.height * scaleY),
    } : item),
  };
}

function transformTextObject(item: TextObject, bounds: Bounds, preview: SelectionTransformPreview): TextObject {
  const averageScale = (preview.scaleX + preview.scaleY) / 2;
  return {
    ...item,
    x: bounds.x + (item.x - bounds.x) * preview.scaleX + preview.offsetX,
    y: bounds.y + (item.y - bounds.y) * preview.scaleY + preview.offsetY,
    fontSize: Math.max(8, (item.fontSize ?? 20) * averageScale),
  };
}

function transformedSelectionBounds(transform: SelectionTransform, preview: SelectionTransformPreview): Bounds {
  const result = {
    x: transform.bounds.x + preview.offsetX,
    y: transform.bounds.y + preview.offsetY,
    width: transform.bounds.width * preview.scaleX,
    height: transform.bounds.height * preview.scaleY,
  };
  let right = result.x + result.width;
  let bottom = result.y + result.height;
  for (const item of transform.selectedTextObjects) {
    const itemBounds = textObjectBounds(transformTextObject(item, transform.bounds, preview));
    result.x = Math.min(result.x, itemBounds.x);
    result.y = Math.min(result.y, itemBounds.y);
    right = Math.max(right, itemBounds.x + itemBounds.width);
    bottom = Math.max(bottom, itemBounds.y + itemBounds.height);
  }
  for (const item of transform.selectedImageObjects) {
    const x = transform.bounds.x + (item.x - transform.bounds.x) * preview.scaleX + preview.offsetX;
    const y = transform.bounds.y + (item.y - transform.bounds.y) * preview.scaleY + preview.offsetY;
    result.x = Math.min(result.x, x);
    result.y = Math.min(result.y, y);
    right = Math.max(right, x + Math.max(8, item.width * preview.scaleX));
    bottom = Math.max(bottom, y + Math.max(8, item.height * preview.scaleY));
  }
  result.width = Math.max(1, right - result.x);
  result.height = Math.max(1, bottom - result.y);
  return result;
}

function prepareHandwritingGlyph(base64: string): Promise<HandwritingGlyph | null> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (glyph: HandwritingGlyph | null) => {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      resolve(glyph);
    };
    image.onload = () => {
      const source = document.createElement("canvas");
      source.width = image.naturalWidth;
      source.height = image.naturalHeight;
      const context = source.getContext("2d", { willReadFrequently: true });
      if (!context) return finish(null);
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, source.width, source.height);
      let left = source.width;
      let top = source.height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < source.height; y += 1) {
        for (let x = 0; x < source.width; x += 1) {
          const index = (y * source.width + x) * 4;
          const luminance = (pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2]) / 3;
          if (pixels.data[index + 3] > 20 && luminance < 225) {
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
          }
        }
      }
      if (right < left || bottom < top) return finish(null);
      const width = right - left + 1;
      const height = bottom - top + 1;
      const output = document.createElement("canvas");
      output.width = width;
      output.height = height;
      const outputContext = output.getContext("2d", { willReadFrequently: true });
      if (!outputContext) return finish(null);
      outputContext.drawImage(source, left, top, width, height, 0, 0, width, height);
      const mask = outputContext.getImageData(0, 0, width, height);
      for (let index = 0; index < mask.data.length; index += 4) {
        const luminance = (mask.data[index] + mask.data[index + 1] + mask.data[index + 2]) / 3;
        mask.data[index] = 0;
        mask.data[index + 1] = 0;
        mask.data[index + 2] = 0;
        mask.data[index + 3] = Math.max(0, 255 - luminance);
      }
      outputContext.putImageData(mask, 0, 0);
      finish({ dataUrl: output.toDataURL("image/png"), aspect: width / Math.max(height, 1) });
    };
    image.onerror = () => finish(null);
    image.src = `data:image/png;base64,${base64}`;
  });
}

const HANDWRITING_LETTERS = "abcdefghijklmnopqrstuvwxyz";

function sameHandwritingGlyphs(
  current: Record<string, HandwritingGlyph>,
  next: Record<string, HandwritingGlyph>,
) {
  const currentLetters = Object.keys(current);
  const nextLetters = Object.keys(next);
  return currentLetters.length === nextLetters.length
    && nextLetters.every((letter) => current[letter] === next[letter]);
}

export async function buildHandwritingGlyphs(
  samples: RecognitionSettings["samples"],
  cache: Map<string, HandwritingGlyphCacheEntry>,
  current: Record<string, HandwritingGlyph> = {},
  decode: (base64: string) => Promise<HandwritingGlyph | null> = prepareHandwritingGlyph,
  cancelled: () => boolean = () => false,
): Promise<Record<string, HandwritingGlyph> | null> {
  const latest = new Map<string, RecognitionSettings["samples"][number]>();
  for (let index = samples.length - 1; index >= 0 && latest.size < HANDWRITING_LETTERS.length; index -= 1) {
    const sample = samples[index];
    if (sample.exercise === "lowercase"
      && sample.mode === "text"
      && sample.label.length === 1
      && HANDWRITING_LETTERS.includes(sample.label)
      && !latest.has(sample.label)) {
      latest.set(sample.label, sample);
    }
  }

  const next: Record<string, HandwritingGlyph> = {};
  for (const letter of HANDWRITING_LETTERS) {
    if (cancelled()) return null;
    const sample = latest.get(letter);
    if (!sample) {
      cache.delete(letter);
      continue;
    }
    let entry = cache.get(letter);
    if (!entry || entry.sampleId !== sample.id || entry.sampleImage !== sample.image) {
      const glyph = await decode(sample.image);
      entry = { sampleId: sample.id, sampleImage: sample.image, glyph };
      cache.set(letter, entry);
    }
    if (cancelled()) return null;
    if (entry.glyph) next[letter] = entry.glyph;
  }
  return sameHandwritingGlyphs(current, next) ? current : next;
}

function boardPoint(event: React.PointerEvent<HTMLCanvasElement>, view: { x: number; y: number; scale: number }) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - view.x) / view.scale,
    y: (event.clientY - rect.top - view.y) / view.scale,
    pressure: event.pressure > 0 ? event.pressure : 0.5,
  } satisfies Point;
}

function App() {
  const [board, setBoard] = useState(loadBoard);
  const [tool, setTool] = useState<Tool>(() => loadUiPreferences().tool);
  const [color, setColor] = useState(() => loadUiPreferences().color);
  const [width, setWidth] = useState(() => loadUiPreferences().width);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<Bounds | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(loadSettings);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState("Not checked");
  const [calibrationLabel, setCalibrationLabel] = useState("");
  const [calibrationMode, setCalibrationMode] = useState<RecognitionMode>("text");
  const [profileSaveError, setProfileSaveError] = useState("");
  const [recognitionOpen, setRecognitionOpen] = useState(false);
  const [recognitionMode, setRecognitionMode] = useState<RecognitionMode>("text");
  const [recognitionScope, setRecognitionScope] = useState<RecognitionScope>("visible");
  const [recognitionState, setRecognitionState] = useState<RecognitionState>("idle");
  const [recognitionResult, setRecognitionResult] = useState("");
  const [recognitionOriginal, setRecognitionOriginal] = useState("");
  const [recognitionError, setRecognitionError] = useState("");
  const [recognitionHighlight, setRecognitionHighlight] = useState<Bounds | null>(null);
  const [recognitionAttempt, setRecognitionAttempt] = useState<RecognitionAttempt | null>(null);
  const [recognitionFeedbackSaved, setRecognitionFeedbackSaved] = useState(false);
  const [correctionMessage, setCorrectionMessage] = useState("");
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [practiceSetId, setPracticeSetId] = useState(PRACTICE_SETS[0].id);
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [practiceMessage, setPracticeMessage] = useState("");
  const [practiceStrokes, setPracticeStrokes] = useState<Stroke[]>([]);
  const [trackpadOpen, setTrackpadOpen] = useState(false);
  const [mousepadCursor, setMousepadCursor] = useState<{ x: number; y: number } | null>(null);
  const [inputBindings, setInputBindings] = useState(loadInputBindings);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryBoards, setLibraryBoards] = useState<LibraryBoard[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryOffset, setLibraryOffset] = useState(0);
  const [libraryHasMore, setLibraryHasMore] = useState(false);
  const [startupVisible, setStartupVisible] = useState(true);
  const [nativeRestoreBoardId] = useState(loadNativeRestoreBoardId);
  const [nativeRestorePending, setNativeRestorePending] = useState(() => nativeRestoreBoardId !== null);
  const [encryptionMenuOpen, setEncryptionMenuOpen] = useState(false);
  const [encryptionRequest, setEncryptionRequest] = useState<EncryptionRequest | null>(null);
  const [encryptionPassword, setEncryptionPassword] = useState("");
  const [encryptionConfirmation, setEncryptionConfirmation] = useState("");
  const [encryptionError, setEncryptionError] = useState("");
  const [textEditor, setTextEditor] = useState<TextEditorRequest | null>(null);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const [clearScope, setClearScope] = useState<"visible" | "board">("visible");
  const [transformPreview, setTransformPreview] = useState<SelectionTransformPreview | null>(null);
  const [handwritingGlyphs, setHandwritingGlyphs] = useState<Record<string, HandwritingGlyph>>({});

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const practiceCanvasRef = useRef<HTMLCanvasElement>(null);
  const boardRef = useRef(board);
  const viewRef = useRef(view);
  const selectionRef = useRef(selection);
  const currentStroke = useRef<Stroke | null>(null);
  const undoStack = useRef<BoardDocument[]>([]);
  const redoStack = useRef<BoardDocument[]>([]);
  const pointerPositions = useRef(new Map<number, { x: number; y: number }>());
  const dragOrigin = useRef<{ point: Point; view: { x: number; y: number; scale: number } } | null>(null);
  const selectionOrigin = useRef<Point | null>(null);
  const eraseOrigin = useRef<BoardDocument | null>(null);
  const pinchOrigin = useRef<{
    distance: number;
    scale: number;
    center: { x: number; y: number };
    view: { x: number; y: number; scale: number };
  } | null>(null);
  const nativeWriteChain = useRef<Promise<void>>(Promise.resolve());
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryCacheRef = useRef<{ board: BoardDocument; serialized: string; browserSaved: boolean } | null>(null);
  const lastNativeSavedBoardRef = useRef<BoardDocument | null>(null);
  const mousepadCursorRef = useRef<{ x: number; y: number } | null>(null);
  const pasteSinkRef = useRef<HTMLTextAreaElement>(null);
  const widthInputRef = useRef<HTMLInputElement>(null);
  const pasteFromClipboardRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const toolRef = useRef(tool);
  const widthRef = useRef(width);
  const practiceKeysRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const practicePointerId = useRef<number | null>(null);
  const currentPracticeStroke = useRef<Stroke | null>(null);
  const practiceStrokesRef = useRef(practiceStrokes);
  const pressedKeys = useRef(new Set<string>());

  useEffect(() => { toolRef.current = tool; }, [tool]);

  function selectTool(next: Tool) {
    toolRef.current = next;
    setTool(next);
  }
  const canvasHover = useRef<{ clientX: number; clientY: number; point: Point } | null>(null);
  const keyboardPointerAction = useRef<"left" | "middle" | "right" | null>(null);
  const selectionTransformRef = useRef<SelectionTransform | null>(null);
  const transformPreviewRef = useRef<SelectionTransformPreview | null>(null);
  const redrawFrameRef = useRef<number | null>(null);
  const layerCacheRef = useRef(createLayerCache());
  const imageLoadVersionRef = useRef(0);
  const handwritingGlyphCacheRef = useRef(new Map<string, HandwritingGlyphCacheEntry>());
  const handwritingGlyphsRef = useRef<Record<string, HandwritingGlyph>>({});
  const startupStartedAtRef = useRef(performance.now());

  boardRef.current = board;
  viewRef.current = view;
  selectionRef.current = selection;
  practiceStrokesRef.current = practiceStrokes;
  transformPreviewRef.current = transformPreview;

  useEffect(() => {
    if (nativeRestorePending) return;
    const remaining = Math.max(0, MINIMUM_STARTUP_MS - (performance.now() - startupStartedAtRef.current));
    const timeout = window.setTimeout(() => setStartupVisible(false), remaining);
    return () => window.clearTimeout(timeout);
  }, [nativeRestorePending]);

  useEffect(() => {
    if (!nativeRestoreBoardId) return;
    let cancelled = false;
    void invoke<string>("open_library_board", { boardId: nativeRestoreBoardId })
      .then((serialized) => parseBoard(serialized))
      .then((next) => {
        if (cancelled) return;
        setBoard(next);
        setSelection(new Set());
        undoStack.current = [];
        redoStack.current = [];
      })
      .catch(() => {
        if (!cancelled) localStorage.removeItem(RECENT_BOARD_STORAGE_KEY);
      })
      .finally(() => {
        if (!cancelled) setNativeRestorePending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nativeRestoreBoardId]);

  const selectedStrokes = useMemo(
    () => board.strokes.filter((stroke) => selection.has(stroke.id)),
    [board.strokes, selection],
  );
  const handwritingCoverage = useMemo(() => [..."abcdefghijklmnopqrstuvwxyz"].filter((letter) =>
    settings.samples.filter((sample) => sample.exercise === "lowercase" && sample.mode === "text" && sample.label === letter).length >= 5,
  ).length, [settings.samples]);
  const handwritingFontReady = handwritingCoverage === 26;
  const displayTextObjects = useMemo(() => {
    const transform = selectionTransformRef.current;
    if (!transformPreview || !transform) return board.textObjects;
    return board.textObjects.map((item) => transform.ids.has(item.id)
      ? transformTextObject(item, transform.bounds, transformPreview)
      : item);
  }, [board.textObjects, transformPreview]);
  const visibleTextObjects = useMemo(() => {
    const overscan = 256 / view.scale;
    const visible = {
      x: -view.x / view.scale - overscan,
      y: -view.y / view.scale - overscan,
      width: canvasSize.width / view.scale + overscan * 2,
      height: canvasSize.height / view.scale + overscan * 2,
    };
    return displayTextObjects.filter((item) => {
      const bounds = textObjectBounds(item);
      return bounds.x <= visible.x + visible.width
        && bounds.x + bounds.width >= visible.x
        && bounds.y <= visible.y + visible.height
        && bounds.y + bounds.height >= visible.y;
    });
  }, [canvasSize, displayTextObjects, view]);
  const selectionBounds = useMemo(() => {
    const transform = selectionTransformRef.current;
    return transformPreview && transform
      ? transformedSelectionBounds(transform, transformPreview)
      : selectedContentBounds(board, selection);
  }, [board, selection, transformPreview]);
  const practiceSet = PRACTICE_SETS.find((item) => item.id === practiceSetId) ?? PRACTICE_SETS[0];
  const practiceTarget = practiceSet.targets[practiceIndex % practiceSet.targets.length];
  const practiceTargetLabel = practiceLabel(practiceSet, practiceTarget);
  const practiceInkLength = useMemo(
    () => practiceStrokes.reduce((total, stroke) => total + stroke.points.slice(1).reduce((length, point, index) => {
      const previous = stroke.points[index];
      return length + Math.hypot(point.x - previous.x, point.y - previous.y);
    }, 0), 0),
    [practiceStrokes],
  );
  const practiceReady = practiceInkLength >= 8;

  useEffect(() => {
    if (!settings.handwritingFontEnabled || !handwritingFontReady) {
      if (!handwritingFontReady) handwritingGlyphCacheRef.current.clear();
      if (Object.keys(handwritingGlyphsRef.current).length) {
        handwritingGlyphsRef.current = {};
        setHandwritingGlyphs({});
      }
      if (settings.handwritingFontEnabled && !handwritingFontReady) {
        setSettings((current) => ({ ...current, handwritingFontEnabled: false }));
      }
      return;
    }
    let cancelled = false;
    void (async () => {
      const glyphs = await buildHandwritingGlyphs(
        settings.samples,
        handwritingGlyphCacheRef.current,
        handwritingGlyphsRef.current,
        prepareHandwritingGlyph,
        () => cancelled,
      );
      if (!glyphs || cancelled || glyphs === handwritingGlyphsRef.current) return;
      handwritingGlyphsRef.current = glyphs;
      setHandwritingGlyphs(glyphs);
    })();
    return () => { cancelled = true; };
  }, [handwritingFontReady, settings.handwritingFontEnabled, settings.samples]);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvasPixelRatio(rect.width, rect.height, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    const visibleBounds = {
      x: -viewRef.current.x / viewRef.current.scale,
      y: -viewRef.current.y / viewRef.current.scale,
      width: rect.width / viewRef.current.scale,
      height: rect.height / viewRef.current.scale,
    };

    // Offscreen layer cache: the committed board (everything except the
    // in-progress stroke, or the un-transformed rest of the board while
    // dragging a selection) is repainted only when its own inputs change,
    // then blitted here every frame. The hot path - adding points to the
    // stroke being drawn, or nudging a selection preview - touches neither
    // the strokes array nor the view, so most frames just blit and skip
    // re-walking every visible stroke.
    const transform = selectionTransformRef.current;
    const preview = transformPreviewRef.current;
    const activeTransform = !!(transform && preview);
    const staticStrokes = activeTransform ? transform!.unselectedStrokes : boardRef.current.strokes;
    const staticTextObjects = activeTransform ? transform!.unselectedTextObjects : boardRef.current.textObjects;
    const staticImageObjects = activeTransform ? transform!.unselectedImageObjects : boardRef.current.imageObjects;
    const staticSelection = activeTransform ? EMPTY_SELECTION : selectionRef.current;
    const staticTheme = activeTransform ? transform!.original.theme : boardRef.current.theme;
    const staticGrid = boardRef.current.grid;
    const signature = [
      staticStrokes, staticTextObjects, staticImageObjects, staticSelection,
      staticTheme, staticGrid,
      viewRef.current.x, viewRef.current.y, viewRef.current.scale,
      settings.handwritingFontEnabled, imageLoadVersionRef.current,
    ];

    paintLayerCache(
      layerCacheRef.current,
      context,
      pixelWidth,
      pixelHeight,
      dpr,
      viewRef.current,
      signature,
      (offscreenContext) => {
        if (staticGrid) drawGrid(offscreenContext, visibleBounds, boardRef.current.theme, viewRef.current.scale);
        drawBoard(
          offscreenContext,
          staticStrokes,
          staticTextObjects,
          staticImageObjects,
          staticTheme,
          staticSelection,
          false,
          !settings.handwritingFontEnabled,
          visibleBounds,
        );
      },
    );

    if (transform && preview) {
      const board = transform.original;
      const averageScale = (preview.scaleX + preview.scaleY) / 2;
      const selectedStrokes = transform.selectedStrokes.some((item) => item.width * averageScale < 1)
        ? transform.selectedStrokes.map((item) => item.width * averageScale >= 1 ? item : { ...item, width: 1 / averageScale })
        : transform.selectedStrokes;
      const selectedTextObjects = transform.selectedTextObjects.some((item) => (item.fontSize ?? 20) * averageScale < 8)
        ? transform.selectedTextObjects.map((item) => (item.fontSize ?? 20) * averageScale >= 8 ? item : { ...item, fontSize: 8 / averageScale })
        : transform.selectedTextObjects;
      const selectedImageObjects = transform.selectedImageObjects.some((item) => item.width * preview.scaleX < 8 || item.height * preview.scaleY < 8)
        ? transform.selectedImageObjects.map((item) => item.width * preview.scaleX >= 8 && item.height * preview.scaleY >= 8 ? item : {
          ...item,
          width: Math.max(8, item.width * preview.scaleX) / preview.scaleX,
          height: Math.max(8, item.height * preview.scaleY) / preview.scaleY,
        })
        : transform.selectedImageObjects;
      const selectedVisibleBounds = {
        x: transform.bounds.x + (visibleBounds.x - transform.bounds.x - preview.offsetX) / preview.scaleX,
        y: transform.bounds.y + (visibleBounds.y - transform.bounds.y - preview.offsetY) / preview.scaleY,
        width: visibleBounds.width / preview.scaleX,
        height: visibleBounds.height / preview.scaleY,
      };
      context.save();
      context.translate(transform.bounds.x + preview.offsetX, transform.bounds.y + preview.offsetY);
      context.scale(preview.scaleX, preview.scaleY);
      context.translate(-transform.bounds.x, -transform.bounds.y);
      drawBoard(
        context,
        selectedStrokes,
        selectedTextObjects,
        selectedImageObjects,
        board.theme,
        EMPTY_SELECTION,
        false,
        !settings.handwritingFontEnabled,
        selectedVisibleBounds,
      );
      context.restore();
    }
    if (currentStroke.current) drawBoard(context, [currentStroke.current], [], [], boardRef.current.theme);
  }, [settings.handwritingFontEnabled]);

  const redraw = useCallback(() => {
    if (redrawFrameRef.current !== null) return;
    redrawFrameRef.current = window.requestAnimationFrame(() => {
      redrawFrameRef.current = null;
      drawFrame();
    });
  }, [drawFrame]);

  useEffect(() => () => {
    if (redrawFrameRef.current !== null) {
      window.cancelAnimationFrame(redrawFrameRef.current);
      redrawFrameRef.current = null;
    }
  }, []);

  useEffect(() => redraw(), [board, transformPreview, view, selection, redraw]);

  useEffect(() => {
    pruneImageCache(board.imageObjects);
  }, [board.imageObjects]);

  useEffect(() => () => pruneImageCache([]), []);

  useEffect(() => {
    // An image finishing its async load doesn't change any board reference,
    // so it wouldn't otherwise change the layer-cache signature below - the
    // cached layer would keep blitting the pre-load (blank) frame forever.
    // Bumping this counter forces one repaint once the image is actually
    // ready to draw.
    const onImageLoaded = () => {
      imageLoadVersionRef.current += 1;
      redraw();
    };
    window.addEventListener("whiteboard-image-loaded", onImageLoaded);
    return () => window.removeEventListener("whiteboard-image-loaded", onImageLoaded);
  }, [redraw]);

  const redrawPractice = useCallback(() => {
    const canvas = practiceCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvasPixelRatio(rect.width, rect.height, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const theme = boardRef.current.theme;
    context.fillStyle = theme === "white" ? "#fcfcfa" : "#121416";
    context.fillRect(0, 0, rect.width, rect.height);
    if (boardRef.current.grid) drawGrid(context, { x: 0, y: 0, width: rect.width, height: rect.height }, theme, 1);
    drawBoard(context, practiceStrokesRef.current, [], [], theme);
    if (currentPracticeStroke.current) drawBoard(context, [currentPracticeStroke.current], [], [], theme);
  }, []);

  useEffect(() => redrawPractice(), [practiceOpen, practiceStrokes, board.theme, board.grid, redrawPractice]);

  useEffect(() => {
    const canvas = practiceCanvasRef.current;
    if (!practiceOpen || !canvas) return;
    const observer = new ResizeObserver(redrawPractice);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [practiceOpen, redrawPractice]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateSize = () => {
      const rect = canvas.getBoundingClientRect();
      setCanvasSize((current) => current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height });
      redraw();
    };
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    updateSize();
    return () => observer.disconnect();
  }, [redraw]);

  useEffect(() => {
    if (nativeRestorePending) return;
    setSaveState("saving");
    let cancelled = false;
    const cacheRecovery = (target: BoardDocument) => {
      const serialized = serializeBoard(target);
      const recovery = { board: target, serialized, browserSaved: false };
      recoveryCacheRef.current = recovery;
      return recovery;
    };
    const persistBrowserRecovery = (target: BoardDocument) => {
      const recovery = recoveryCacheRef.current?.board === target
        ? recoveryCacheRef.current
        : cacheRecovery(target);
      try {
        localStorage.setItem(BOARD_STORAGE_KEY, recovery.serialized);
        recovery.browserSaved = true;
      } catch {
        recovery.browserSaved = false;
      }
      return recovery;
    };
    if (!isTauri() && recoveryTimerRef.current === null) {
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        if (!persistBrowserRecovery(boardRef.current).browserSaved) setSaveState("error");
      }, 100);
    }
    const timeout = window.setTimeout(async () => {
      const recovery = recoveryCacheRef.current?.board === board
        ? recoveryCacheRef.current
        : isTauri() ? cacheRecovery(board) : persistBrowserRecovery(board);
      try {
        if (isTauri()) {
          nativeWriteChain.current = nativeWriteChain.current
            .catch(() => undefined)
            .then(() => invoke<void>("save_library_board", { boardJson: recovery.serialized, boardId: board.id }));
          await nativeWriteChain.current;
          if (boardRef.current === board) {
            markNativeBoardSaved(board.id);
            lastNativeSavedBoardRef.current = board;
          }
        }
        if (cancelled) return;
        setSaveState(recovery.browserSaved || isTauri() ? "saved" : "error");
      } catch {
        if (isTauri()) persistBrowserRecovery(boardRef.current);
        if (cancelled) return;
        setSaveState("error");
      } finally {
        if (recoveryCacheRef.current?.board === board) recoveryCacheRef.current = null;
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [board, nativeRestorePending]);

  useEffect(() => {
    const flushRecovery = () => {
      if (!isTauri()) return;
      const current = boardRef.current;
      if (lastNativeSavedBoardRef.current === current) return;
      try {
        localStorage.setItem(BOARD_STORAGE_KEY, serializeBoard(current));
      } catch {
        // The normal save state already reports storage failures while the app is open.
      }
    };
    window.addEventListener("beforeunload", flushRecovery);
    return () => {
      window.removeEventListener("beforeunload", flushRecovery);
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      recoveryCacheRef.current = null;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      setProfileSaveError("");
    } catch {
      setProfileSaveError("The handwriting profile could not be saved because local storage is full. Delete older profile data and try again.");
    }
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(INPUT_STORAGE_KEY, JSON.stringify(inputBindings));
  }, [inputBindings]);

  useEffect(() => {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({
      tool,
      color,
      width,
      theme: board.theme,
      grid: board.grid,
    } satisfies UiPreferences));
  }, [tool, color, width, board.theme, board.grid]);

  const commitBoard = useCallback((next: BoardDocument) => {
    pushHistory(undoStack.current, boardRef.current);
    redoStack.current = [];
    setBoard({ ...next, updatedAt: new Date().toISOString() });
  }, []);

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    pushHistory(redoStack.current, boardRef.current);
    setBoard({ ...previous, updatedAt: new Date().toISOString() });
    setSelection(new Set());
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    pushHistory(undoStack.current, boardRef.current);
    setBoard({ ...next, updatedAt: new Date().toISOString() });
    setSelection(new Set());
  }, []);

  function updateBoardMetadata(update: (current: BoardDocument) => BoardDocument) {
    redoStack.current = [];
    setBoard((current) => ({ ...update(current), updatedAt: new Date().toISOString() }));
  }

  const deleteSelection = useCallback(() => {
    if (!selectionRef.current.size) return;
    commitBoard({
      ...boardRef.current,
      strokes: boardRef.current.strokes.filter((stroke) => !selectionRef.current.has(stroke.id)),
      textObjects: boardRef.current.textObjects.filter((item) => !selectionRef.current.has(item.id)),
      imageObjects: boardRef.current.imageObjects.filter((item) => !selectionRef.current.has(item.id)),
    });
    setSelection(new Set());
  }, [commitBoard]);

  function beginSelectionTransform(mode: "move" | "resize", point: Point) {
    const original = boardRef.current;
    const ids = new Set(selectionRef.current);
    const bounds = selectedContentBounds(original, ids);
    if (!bounds) return false;
    selectionTransformRef.current = {
      mode,
      start: point,
      bounds,
      original,
      ids,
      selectedStrokes: original.strokes.filter((item) => ids.has(item.id)),
      selectedTextObjects: original.textObjects.filter((item) => ids.has(item.id)),
      selectedImageObjects: original.imageObjects.filter((item) => ids.has(item.id)),
      unselectedStrokes: original.strokes.filter((item) => !ids.has(item.id)),
      unselectedTextObjects: original.textObjects.filter((item) => !ids.has(item.id)),
      unselectedImageObjects: original.imageObjects.filter((item) => !ids.has(item.id)),
      changed: false,
    };
    return true;
  }

  function updateSelectionTransform(point: Point) {
    const transform = selectionTransformRef.current;
    if (!transform) return;
    let preview: SelectionTransformPreview;
    if (transform.mode === "move") {
      preview = {
        offsetX: point.x - transform.start.x,
        offsetY: point.y - transform.start.y,
        scaleX: 1,
        scaleY: 1,
      };
    } else {
      const diagonalX = transform.bounds.width;
      const diagonalY = transform.bounds.height;
      const pointerX = point.x - transform.bounds.x;
      const pointerY = point.y - transform.bounds.y;
      const denominator = diagonalX * diagonalX + diagonalY * diagonalY;
      const scale = Math.min(20, Math.max(0.1, denominator > 0 ? (pointerX * diagonalX + pointerY * diagonalY) / denominator : 1));
      preview = { offsetX: 0, offsetY: 0, scaleX: scale, scaleY: scale };
    }
    transform.changed = true;
    transformPreviewRef.current = preview;
    setTransformPreview(preview);
  }

  function finishSelectionTransform() {
    const transform = selectionTransformRef.current;
    const preview = transformPreviewRef.current;
    selectionTransformRef.current = null;
    transformPreviewRef.current = null;
    setTransformPreview(null);
    if (transform?.changed && preview) {
      commitBoard(transformSelection(
        transform.original,
        transform.ids,
        transform.bounds,
        preview.offsetX,
        preview.offsetY,
        preview.scaleX,
        preview.scaleY,
      ));
    }
  }

  function cancelSelectionTransform() {
    selectionTransformRef.current = null;
    transformPreviewRef.current = null;
    setTransformPreview(null);
  }

  function clearBoardScope() {
    if (clearScope === "board") {
      commitBoard({ ...boardRef.current, strokes: [], textObjects: [], imageObjects: [] });
    } else {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const bounds = {
        x: -viewRef.current.x / viewRef.current.scale,
        y: -viewRef.current.y / viewRef.current.scale,
        width: rect.width / viewRef.current.scale,
        height: rect.height / viewRef.current.scale,
      };
      const visibleIds = selectedBoardIds(boardRef.current, bounds);
      if (!visibleIds.size) {
        setClearMenuOpen(false);
        return;
      }
      commitBoard({
        ...boardRef.current,
        strokes: boardRef.current.strokes.filter((item) => !visibleIds.has(item.id)),
        textObjects: boardRef.current.textObjects.filter((item) => !visibleIds.has(item.id)),
        imageObjects: boardRef.current.imageObjects.filter((item) => !visibleIds.has(item.id)),
      });
    }
    setSelection(new Set());
    setClearMenuOpen(false);
  }

  const finishMousepadStroke = useCallback(() => {
    const stroke = currentStroke.current;
    if (!stroke || stroke.pointerType !== "mousepad-capture") return;
    currentStroke.current = null;
    if (stroke.points.length > 1) commitBoard({ ...boardRef.current, strokes: addStroke(boardRef.current.strokes, stroke) });
    else redraw();
  }, [commitBoard, redraw]);

  function stopMousepadCapture() {
    finishMousepadStroke();
    if (document.pointerLockElement) document.exitPointerLock();
    setTrackpadOpen(false);
    setMousepadCursor(null);
    mousepadCursorRef.current = null;
  }

  function toggleMousepadCapture() {
    if (trackpadOpen || document.pointerLockElement === canvasRef.current) {
      stopMousepadCapture();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hover = canvasHover.current;
    const cursor = hover
      ? { x: Math.min(rect.width, Math.max(0, hover.clientX - rect.left)), y: Math.min(rect.height, Math.max(0, hover.clientY - rect.top)) }
      : { x: rect.width / 2, y: rect.height / 2 };
    mousepadCursorRef.current = cursor;
    setMousepadCursor(cursor);
    canvas.requestPointerLock().catch(() => {
      setTrackpadOpen(false);
      setMousepadCursor(null);
      mousepadCursorRef.current = null;
    });
  }

  useEffect(() => {
    const onPointerLockChange = () => {
      const active = document.pointerLockElement === canvasRef.current;
      setTrackpadOpen(active);
      if (!active) {
        finishMousepadStroke();
        setMousepadCursor(null);
        mousepadCursorRef.current = null;
      }
    };
    document.addEventListener("pointerlockchange", onPointerLockChange);
    return () => document.removeEventListener("pointerlockchange", onPointerLockChange);
  }, [finishMousepadStroke]);

  const fitBoard = useCallback(() => setView({ x: 0, y: 0, scale: 1 }), []);

  const zoomAt = useCallback((clientX: number, clientY: number, nextScale: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    setView((current) => {
      const scale = Math.min(5, Math.max(0.25, nextScale));
      const boardX = (localX - current.x) / current.scale;
      const boardY = (localY - current.y) / current.scale;
      return { scale, x: localX - boardX * scale, y: localY - boardY * scale };
    });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, viewRef.current.scale * factor);
  }, [zoomAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      pressedKeys.current.add(event.key);
      const target = event.target as HTMLElement;
      if (target !== pasteSinkRef.current && target !== widthInputRef.current && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (target === widthInputRef.current && Number.isFinite(widthInputRef.current.valueAsNumber)) {
        widthRef.current = Math.min(18, Math.max(1, widthInputRef.current.valueAsNumber));
        setWidth(widthRef.current);
      }
      // Ctrl/Cmd combinations such as Ctrl+V must not trigger the single-letter tool shortcuts.
      const toolShortcut = !event.ctrlKey && !event.metaKey;
      if (practiceKeysRef.current(event)) {
        event.preventDefault();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (!event.repeat && event.key.toLowerCase() === "m") {
        event.preventDefault();
        toggleMousepadCapture();
      } else if (!event.repeat && canvasHover.current && !keyboardPointerAction.current && !currentStroke.current && !dragOrigin.current && !selectionOrigin.current
        && [...inputBindings.leftKeys, ...inputBindings.middleKeys, ...inputBindings.rightKeys].includes(event.key)) {
        event.preventDefault();
        const hover = canvasHover.current;
        if (inputBindings.leftKeys.includes(event.key)) {
          keyboardPointerAction.current = "left";
          toolRef.current = "pen";
          beginPrimaryAction(hover.point, hover.clientX, hover.clientY, "keyboard");
          setTool("pen");
        } else if (inputBindings.middleKeys.includes(event.key)) {
          keyboardPointerAction.current = "middle";
          dragOrigin.current = {
            point: { x: hover.clientX, y: hover.clientY, pressure: 0.5 },
            view: viewRef.current,
          };
        } else {
          keyboardPointerAction.current = "right";
          selectionOrigin.current = hover.point;
          setSelection(new Set());
          setSelectionBox({ x: hover.point.x, y: hover.point.y, width: 0, height: 0 });
        }
        redraw();
      } else if (toolShortcut && event.key === "Shift") selectTool("eraser");
      else if (toolShortcut && event.key.toLowerCase() === "a") selectTool("select");
      else if (toolShortcut && event.key.toLowerCase() === "s") selectTool("hand");
      else if (toolShortcut && event.key.toLowerCase() === "d") selectTool("text");
      else if (toolShortcut && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteFromClipboardRef.current().catch((error) => window.alert(`Could not paste: ${String(error)}`));
      } else if (toolShortcut && event.key.toLowerCase() === "p") selectTool("pen");
      else if (toolShortcut && event.key.toLowerCase() === "e") selectTool("eraser");
      else if (toolShortcut && event.key.toLowerCase() === "h") selectTool("hand");
      else if (toolShortcut && event.key.toLowerCase() === "t") selectTool("text");
      else if (event.key === "[") setWidth((value) => (widthRef.current = Math.max(1, value - 1)));
      else if (event.key === "]") setWidth((value) => (widthRef.current = Math.min(18, value + 1)));
      else if (event.key === "0") fitBoard();
      else if (event.key === "+" || event.key === "=") zoomBy(1.15);
      else if (event.key === "-") zoomBy(1 / 1.15);
      else if (event.key === "Escape") {
        setSelection(new Set());
        setRecognitionOpen(false);
        setRecognitionHighlight(null);
        setPracticeOpen(false);
        setTextEditor(null);
        setClearMenuOpen(false);
        cancelSelectionTransform();
        stopMousepadCapture();
      } else if (event.key === "Delete" && selectionRef.current.size) {
        deleteSelection();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      pressedKeys.current.delete(event.key);
      const action = keyboardPointerAction.current;
      const expectedKeys = action === "left" ? inputBindings.leftKeys : action === "middle" ? inputBindings.middleKeys : action === "right" ? inputBindings.rightKeys : [];
      if (!action || !expectedKeys.includes(event.key)) return;
      if (expectedKeys.some((key) => pressedKeys.current.has(key))) return;
      if (action !== "middle" && canvasHover.current) finishActiveAction(canvasHover.current.point);
      else dragOrigin.current = null;
      keyboardPointerAction.current = null;
      redraw();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [color, commitBoard, deleteSelection, fitBoard, inputBindings, redo, redraw, tool, trackpadOpen, undo, width, zoomBy]);

  function handleWheel(event: React.WheelEvent<HTMLCanvasElement>) {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, viewRef.current.scale * Math.exp(-event.deltaY * 0.004));
  }

  function beginPrimaryAction(point: Point, clientX: number, clientY: number, pointerType: string) {
    if (toolRef.current === "pen") {
      currentStroke.current = {
        id: crypto.randomUUID(),
        color,
        width: widthRef.current,
        pointerType,
        points: [point],
      };
      setSelection(new Set());
    } else if (toolRef.current === "eraser") {
      eraseOrigin.current = boardRef.current;
      eraseAt(point.x, point.y);
    } else if (toolRef.current === "select") {
      const bounds = selectedContentBounds(boardRef.current, selectionRef.current);
      if (bounds && point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height) {
        beginSelectionTransform("move", point);
      } else {
        setSelection(new Set());
        selectionOrigin.current = point;
        setSelectionBox({ x: point.x, y: point.y, width: 0, height: 0 });
      }
    } else if (toolRef.current === "hand") {
      dragOrigin.current = {
        point: { ...point, x: clientX, y: clientY },
        view: viewRef.current,
      };
    } else {
      editTextAt(point, clientX, clientY);
    }
  }

  function finishActiveAction(end: Point) {
    if (currentStroke.current) {
      const stroke = currentStroke.current;
      appendStrokePoint(stroke, end);
      currentStroke.current = null;
      commitBoard({ ...boardRef.current, strokes: addStroke(boardRef.current.strokes, stroke) });
    } else if (eraseOrigin.current) {
      const original = eraseOrigin.current;
      eraseOrigin.current = null;
      if (original.strokes.length !== boardRef.current.strokes.length) {
        pushHistory(undoStack.current, original);
        redoStack.current = [];
        setBoard({ ...boardRef.current, updatedAt: new Date().toISOString() });
      }
    } else if (selectionTransformRef.current) {
      finishSelectionTransform();
    } else if (selectionOrigin.current) {
      const start = selectionOrigin.current;
      const bounds = {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      };
      setSelection(selectedBoardIds(boardRef.current, bounds));
      selectionOrigin.current = null;
      setSelectionBox(null);
    }
    dragOrigin.current = null;
  }

  function editTextAt(point: Point, clientX: number, clientY: number) {
    const existing = [...boardRef.current.textObjects].reverse().find((item) =>
      point.x >= item.x - 8 && point.x <= item.x + 280
      && point.y >= item.y - 8 && point.y <= item.y + Math.max(28, item.value.split("\n").length * 28),
    );
    const rect = canvasRef.current?.getBoundingClientRect();
    setTextEditor({
      kind: existing?.kind ?? "text",
      value: existing?.value ?? "",
      boardX: existing?.x ?? point.x,
      boardY: existing?.y ?? point.y,
      anchorX: clientX - (rect?.left ?? 0),
      anchorY: clientY - (rect?.top ?? 0),
      targetId: existing?.id,
    });
  }

  function saveTextEditor() {
    if (!textEditor?.value.trim()) return;
    const value = textEditor.value.trim();
    commitBoard({
      ...boardRef.current,
      textObjects: textEditor.targetId
        ? boardRef.current.textObjects.map((item) => item.id === textEditor.targetId ? { ...item, value } : item)
        : [...boardRef.current.textObjects, {
          id: crypto.randomUUID(),
          x: textEditor.boardX,
          y: textEditor.boardY,
          value,
          color,
          kind: textEditor.kind,
        }],
    });
    setTextEditor(null);
  }

  function startPointer(event: React.PointerEvent<HTMLCanvasElement>) {
    if (keyboardPointerAction.current) return;
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    if (trackpadOpen && document.pointerLockElement === event.currentTarget) {
      event.preventDefault();
      return;
    }
    const button = event.button;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerPositions.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (button === 1) {
      dragOrigin.current = {
        point: { x: event.clientX, y: event.clientY, pressure: 0.5 },
        view: viewRef.current,
      };
      return;
    }

    if (button === 2) {
      const point = boardPoint(event, viewRef.current);
      setSelection(new Set());
      selectionOrigin.current = point;
      setSelectionBox({ x: point.x, y: point.y, width: 0, height: 0 });
      return;
    }

    if (pointerPositions.current.size === 2) {
      currentStroke.current = null;
      cancelSelectionTransform();
      const [a, b] = [...pointerPositions.current.values()];
      pinchOrigin.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        scale: viewRef.current.scale,
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: viewRef.current,
      };
      redraw();
      return;
    }

    const point = boardPoint(event, viewRef.current);
    beginPrimaryAction(point, event.clientX, event.clientY, event.pointerType);
    redraw();
  }

  function movePointer(event: React.PointerEvent<HTMLCanvasElement>) {
    const hoverPoint = boardPoint(event, viewRef.current);
    canvasHover.current = { clientX: event.clientX, clientY: event.clientY, point: hoverPoint };
    if (trackpadOpen && document.pointerLockElement === event.currentTarget) {
      const rect = event.currentTarget.getBoundingClientRect();
      const previous = mousepadCursorRef.current ?? { x: rect.width / 2, y: rect.height / 2 };
      const cursor = {
        x: Math.min(rect.width, Math.max(0, previous.x + event.movementX * 1.35)),
        y: Math.min(rect.height, Math.max(0, previous.y + event.movementY * 1.35)),
      };
      mousepadCursorRef.current = cursor;
      setMousepadCursor(cursor);
      const point: Point = {
        x: (cursor.x - viewRef.current.x) / viewRef.current.scale,
        y: (cursor.y - viewRef.current.y) / viewRef.current.scale,
        pressure: 0.5,
      };
      if ((event.buttons & 1) === 0) {
        finishMousepadStroke();
      } else if (!currentStroke.current) {
        currentStroke.current = {
          id: crypto.randomUUID(),
          color,
          width,
          pointerType: "mousepad-capture",
          points: [point],
        };
        setSelection(new Set());
      } else if (currentStroke.current.pointerType === "mousepad-capture") {
        appendStrokePoint(currentStroke.current, point);
      }
      redraw();
      return;
    }
    if (keyboardPointerAction.current) {
      if (keyboardPointerAction.current === "left" && selectionTransformRef.current) {
        updateSelectionTransform(hoverPoint);
      } else if (keyboardPointerAction.current === "left" && currentStroke.current) {
        appendStrokePoint(currentStroke.current, hoverPoint);
        redraw();
      } else if (keyboardPointerAction.current === "left" && eraseOrigin.current) {
        eraseAt(hoverPoint.x, hoverPoint.y);
      } else if ((keyboardPointerAction.current === "left" || keyboardPointerAction.current === "right") && selectionOrigin.current) {
        const start = selectionOrigin.current;
        setSelectionBox({ x: Math.min(start.x, hoverPoint.x), y: Math.min(start.y, hoverPoint.y), width: Math.abs(hoverPoint.x - start.x), height: Math.abs(hoverPoint.y - start.y) });
      } else if ((keyboardPointerAction.current === "left" || keyboardPointerAction.current === "middle") && dragOrigin.current) {
        setView({
          ...dragOrigin.current.view,
          x: dragOrigin.current.view.x + event.clientX - dragOrigin.current.point.x,
          y: dragOrigin.current.view.y + event.clientY - dragOrigin.current.point.y,
        });
      }
      return;
    }
    if (!pointerPositions.current.has(event.pointerId)) return;
    pointerPositions.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointerPositions.current.size >= 2 && pinchOrigin.current) {
      const [a, b] = [...pointerPositions.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const nextScale = Math.min(5, Math.max(0.25, pinchOrigin.current.scale * (distance / pinchOrigin.current.distance)));
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const origin = pinchOrigin.current;
      setView({
        scale: nextScale,
        x: center.x - ((origin.center.x - origin.view.x) / origin.view.scale) * nextScale,
        y: center.y - ((origin.center.y - origin.view.y) / origin.view.scale) * nextScale,
      });
      return;
    }

    const point = hoverPoint;
    if (selectionTransformRef.current) {
      updateSelectionTransform(point);
    } else if (currentStroke.current) {
      appendStrokePoint(currentStroke.current, point);
      redraw();
    } else if (eraseOrigin.current) {
      eraseAt(point.x, point.y);
    } else if (selectionOrigin.current) {
      const start = selectionOrigin.current;
      setSelectionBox({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      });
    } else if (dragOrigin.current) {
      setView({
        ...dragOrigin.current.view,
        x: dragOrigin.current.view.x + event.clientX - dragOrigin.current.point.x,
        y: dragOrigin.current.view.y + event.clientY - dragOrigin.current.point.y,
      });
    }
  }

  function eraseAt(x: number, y: number) {
    const strokes = boardRef.current.strokes;
    const remaining = eraseStrokesAt(strokes, x, y, 10 / viewRef.current.scale);
    if (remaining !== strokes) setBoard({ ...boardRef.current, strokes: remaining });
  }

  function endPointer(event: React.PointerEvent<HTMLCanvasElement>) {
    pointerPositions.current.delete(event.pointerId);
    if (pointerPositions.current.size < 2) pinchOrigin.current = null;
    finishActiveAction(boardPoint(event, viewRef.current));
  }

  function cancelPointer(event: React.PointerEvent<HTMLCanvasElement>) {
    pointerPositions.current.delete(event.pointerId);
    currentStroke.current = null;
    eraseOrigin.current = null;
    selectionOrigin.current = null;
    dragOrigin.current = null;
    cancelSelectionTransform();
    setSelectionBox(null);
    redraw();
  }

  async function saveBoard() {
    try {
      const serialized = serializeBoard(board);
      if (isTauri()) {
        nativeWriteChain.current = nativeWriteChain.current
          .catch(() => undefined)
          .then(() => invoke<void>("save_library_board", { boardJson: serialized, boardId: board.id }));
        await nativeWriteChain.current;
        if (boardRef.current === board) {
          markNativeBoardSaved(board.id);
          lastNativeSavedBoardRef.current = board;
        }
      } else localStorage.setItem(BOARD_STORAGE_KEY, serialized);
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      window.alert(`Could not save the board: ${String(error)}`);
    }
  }

  async function openBoard() {
    if ((board.strokes.length || board.textObjects.length || board.imageObjects.length) && !window.confirm("Open another board? Save the current board first if you want to keep it.")) return;
    try {
      const serialized = await invoke<string | null>("open_external_board_dialog");
      if (serialized === null) return;
      const next = parseBoard(serialized);
      setBoard(next);
      setSelection(new Set());
      setTextEditor(null);
      undoStack.current = [];
      redoStack.current = [];
      fitBoard();
    } catch (error) {
      window.alert(`Could not open the board: ${String(error)}`);
    }
  }

  function prepareEncryption(action: EncryptionRequest["action"]) {
    if (action === "open" && (board.strokes.length || board.textObjects.length || board.imageObjects.length)
      && !window.confirm("Open another board? Save the current board first if you want to keep it.")) return;
    setEncryptionMenuOpen(false);
    setEncryptionRequest({ action });
    setEncryptionPassword("");
    setEncryptionConfirmation("");
    setEncryptionError("");
  }

  const boardCenter = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return {
      x: ((rect?.width ?? 640) / 2 - viewRef.current.x) / viewRef.current.scale,
      y: ((rect?.height ?? 480) / 2 - viewRef.current.y) / viewRef.current.scale,
    };
  }, []);

  const insertImageBytes = useCallback(async (bytes: Uint8Array) => {
    const { inspectImageFile } = await import("./image");
    const inspected = inspectImageFile(bytes);
    const optimized = await prepareEmbeddedImage(bytes, inspected.mime, inspected);
    const ratio = Math.min(1, 640 / optimized.width, 480 / optimized.height);
    const imageWidth = Math.max(1, optimized.width * ratio);
    const imageHeight = Math.max(1, optimized.height * ratio);
    const center = boardCenter();
    commitBoard({
      ...boardRef.current,
      imageObjects: [...boardRef.current.imageObjects, {
        id: crypto.randomUUID(),
        x: center.x - imageWidth / 2,
        y: center.y - imageHeight / 2,
        width: imageWidth,
        height: imageHeight,
        dataUrl: optimized.dataUrl,
      }],
    });
  }, [boardCenter, commitBoard]);

  const pasteText = useCallback((text: string) => {
    const value = text.trim();
    if (!value) return;
    const center = boardCenter();
    commitBoard({
      ...boardRef.current,
      textObjects: [...boardRef.current.textObjects, {
        id: crypto.randomUUID(),
        x: center.x,
        y: center.y,
        value,
        color,
        kind: "text",
      }],
    });
  }, [boardCenter, color, commitBoard]);

  const insertRgbaImage = useCallback(async (rgba: Uint8Array, width: number, height: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not decode the pasted image.");
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error("Could not decode the pasted image.");
    await insertImageBytes(new Uint8Array(await blob.arrayBuffer()));
  }, [insertImageBytes]);

  // In the desktop app WebKit does not reliably deliver DOM paste events to the canvas,
  // so read the clipboard through Tauri directly when Ctrl/Cmd+V is pressed.
  const pasteFromTauri = useCallback(async () => {
    const { readImage, readText } = await import("@tauri-apps/plugin-clipboard-manager");
    try {
      const image = await readImage();
      const size = await image.size();
      const rgba = await image.rgba();
      if (size.width > 0 && size.height > 0 && rgba.length >= size.width * size.height * 4) {
        await insertRgbaImage(rgba, size.width, size.height);
        return;
      }
    } catch {
      // No image on the clipboard; fall through to text.
    }
    try {
      pasteText(await readText());
    } catch {
      // No text on the clipboard either.
    }
  }, [insertRgbaImage, pasteText]);

  // Unified paste used by both Ctrl/Cmd+V and the toolbar Paste button. In the desktop app
  // it reads the clipboard through Tauri; in a browser it uses the async clipboard API
  // (which needs the user gesture the button provides).
  const pasteFromClipboard = useCallback(async () => {
    if (isTauri()) {
      await pasteFromTauri();
      return;
    }
    try {
      for (const item of await navigator.clipboard.read()) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          await insertImageBytes(new Uint8Array(await blob.arrayBuffer()));
          return;
        }
      }
    } catch {
      // Async clipboard image read is unavailable; fall through to text.
    }
    pasteText(await navigator.clipboard.readText().catch(() => ""));
  }, [pasteFromTauri, insertImageBytes, pasteText]);

  pasteFromClipboardRef.current = pasteFromClipboard;

  useEffect(() => {
    if (isTauri()) {
      const onKeyDown = (event: KeyboardEvent) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "v") return;
        const target = event.target as HTMLElement | null;
        if (target?.closest?.("input, textarea:not(.paste-sink), select, [contenteditable=true]")) return;
        event.preventDefault();
        pasteFromClipboard().catch((error) => window.alert(`Could not paste: ${String(error)}`));
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }

    // Browser fallback (dev server, tests): rely on the DOM paste event, which needs an
    // editable element focused, so keep an offscreen textarea focused as the paste target.
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target !== pasteSinkRef.current && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const image = [...(event.clipboardData?.items ?? [])]
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile();
      if (image) {
        event.preventDefault();
        image.arrayBuffer()
          .then((buffer) => insertImageBytes(new Uint8Array(buffer)))
          .catch((error) => window.alert(`Could not paste the image: ${String(error)}`));
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text.trim()) return;
      event.preventDefault();
      pasteText(text);
    };
    const focusSink = () => pasteSinkRef.current?.focus({ preventScroll: true });
    focusSink();
    window.addEventListener("paste", onPaste);
    window.addEventListener("focus", focusSink);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("focus", focusSink);
    };
  }, [insertImageBytes, pasteFromClipboard, pasteText]);

  const focusPasteSink = useCallback(() => {
    if (isTauri()) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== pasteSinkRef.current && active.closest?.("input, textarea, select, [contenteditable=true]")) return;
    pasteSinkRef.current?.focus({ preventScroll: true });
  }, []);

  async function insertImage() {
    try {
      const bytes = new Uint8Array(await invoke<ArrayBuffer>("open_external_image_dialog"));
      if (!bytes.byteLength) return;
      await insertImageBytes(bytes);
    } catch (error) {
      window.alert(`Could not insert the image: ${String(error)}`);
    }
  }

  function insertLatex() {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const anchorX = (rect?.width ?? 640) / 2;
    const anchorY = Math.min((rect?.height ?? 480) / 2, 220);
    setTextEditor({
      kind: "latex",
      value: "",
      boardX: (anchorX - viewRef.current.x) / viewRef.current.scale,
      boardY: ((rect?.height ?? 480) / 2 - viewRef.current.y) / viewRef.current.scale,
      anchorX,
      anchorY,
    });
  }

  async function submitEncryption() {
    if (!encryptionRequest) return;
    if (encryptionPassword.length < 8) {
      setEncryptionError("Use a passphrase of at least 8 characters.");
      return;
    }
    if (encryptionRequest.action === "save" && encryptionPassword !== encryptionConfirmation) {
      setEncryptionError("The passphrases do not match.");
      return;
    }
    try {
      if (encryptionRequest.action === "save") {
        const saved = await invoke<boolean>("save_encrypted_board_dialog", {
          boardJson: serializeBoard(board),
          password: encryptionPassword,
          defaultName: defaultExternalName(board.title || defaultBoardTitle(), ".whiteboard.enc"),
        });
        if (!saved) {
          setEncryptionPassword("");
          setEncryptionConfirmation("");
          setEncryptionRequest(null);
          return;
        }
      } else {
        const boardJson = await invoke<string | null>("open_encrypted_board_dialog", {
          password: encryptionPassword,
        });
        if (boardJson === null) {
          setEncryptionPassword("");
          setEncryptionRequest(null);
          return;
        }
        setBoard(parseBoard(boardJson));
        setSelection(new Set());
        setTextEditor(null);
        undoStack.current = [];
        redoStack.current = [];
        fitBoard();
      }
      setEncryptionPassword("");
      setEncryptionConfirmation("");
      setEncryptionRequest(null);
      setEncryptionError("");
    } catch (error) {
      setEncryptionPassword("");
      setEncryptionConfirmation("");
      setEncryptionError(String(error));
    }
  }

  async function exportPng() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const context = exportCanvas.getContext("2d");
    if (!context) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvasPixelRatio(rect.width, rect.height, window.devicePixelRatio || 1);
    context.fillStyle = board.theme === "white" ? "#fcfcfa" : "#121416";
    context.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    context.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    if (board.grid) {
      drawGrid(
        context,
        {
          x: -view.x / view.scale,
          y: -view.y / view.scale,
          width: rect.width / view.scale,
          height: rect.height / view.scale,
        },
        board.theme,
        view.scale,
      );
    }
    drawBoard(context, board.strokes, board.textObjects, board.imageObjects, board.theme, new Set(), true);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        exportCanvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode the PNG image.")), "image/png");
      });
      if (blob.size > MAX_PNG_EXPORT_BYTES) throw new Error("The PNG export is too large.");
      await invoke<boolean>("save_external_png_dialog", new Uint8Array(await blob.arrayBuffer()), {
        headers: { "default-name-hex": encodeHeaderValue(defaultExternalName(board.title || defaultBoardTitle(), ".png")) },
      });
    } catch (error) {
      window.alert(`Could not export the image: ${String(error)}`);
    } finally {
      exportCanvas.width = 0;
      exportCanvas.height = 0;
    }
  }

  function newBoard() {
    if ((board.strokes.length || board.textObjects.length || board.imageObjects.length) && !window.confirm("Create a new board? Save the current board first if you want to keep it.")) return;
    setBoard({ ...createBoard(), theme: board.theme, grid: board.grid });
    setSelection(new Set());
    setTextEditor(null);
    undoStack.current = [];
    redoStack.current = [];
    fitBoard();
  }

  async function loadLibraryPage(offset: number) {
    setLibraryError("");
    setLibraryLoading(true);
    try {
      const page = await invoke<LibraryBoardPage>("list_library_boards", { offset });
      setLibraryBoards(page.boards);
      setLibraryOffset(offset);
      setLibraryHasMore(page.hasMore);
    } catch (error) {
      setLibraryError(String(error));
    } finally {
      setLibraryLoading(false);
    }
  }

  async function openLibrary() {
    setLibraryOpen(true);
    setLibraryBoards([]);
    setLibraryOffset(0);
    setLibraryHasMore(false);
    if (!isTauri()) {
      setLibraryError("The native Board Library is available in the installed Tauri app.");
      return;
    }
    await loadLibraryPage(0);
  }

  async function loadLibraryBoard(boardId: string) {
    try {
      const next = parseBoard(await invoke<string>("open_library_board", { boardId }));
      setBoard(next);
      setSelection(new Set());
      setTextEditor(null);
      undoStack.current = [];
      redoStack.current = [];
      setLibraryOpen(false);
      fitBoard();
    } catch (error) {
      setLibraryError(String(error));
    }
  }

  async function checkModel() {
    setModelStatus("Checking...");
    try {
      const models = await listNvidiaModels();
      setAvailableModels(models);
      setModelStatus(models.includes(settings.model) ? "NVIDIA API ready" : "Choose an available vision model");
    } catch (error) {
      setAvailableModels([]);
      setModelStatus(`Unavailable: ${String(error)}`);
    }
  }

  function recognitionImage(scope: RecognitionScope) {
    if (scope === "selection") return renderSelectionImage(selectedStrokes, board.theme);
    if (scope === "board") return renderSelectionImage(board.strokes, board.theme);
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const grid = 32;
    const left = -view.x / view.scale;
    const top = -view.y / view.scale;
    const bounds = {
      x: Math.floor(left / grid) * grid,
      y: Math.floor(top / grid) * grid,
      width: Math.ceil((left + rect.width / view.scale) / grid) * grid - Math.floor(left / grid) * grid,
      height: Math.ceil((top + rect.height / view.scale) / grid) * grid - Math.floor(top / grid) * grid,
    };
    return renderSelectionImage(strokesIntersectingBounds(board.strokes, bounds), board.theme, bounds);
  }

  async function runRecognition(mode: RecognitionMode, scope: RecognitionScope = recognitionScope) {
    const rendered = recognitionImage(scope);
    setRecognitionOpen(true);
    setRecognitionMode(mode);
    setRecognitionScope(scope);
    setCorrectionMessage("");
    setRecognitionHighlight(null);
    setRecognitionFeedbackSaved(false);
    if (!rendered) {
      setRecognitionAttempt(null);
      setRecognitionState("error");
      setRecognitionError(scope === "selection" ? "Select some ink first." : "There is no ink in this recognition area.");
      return;
    }
    setRecognitionState("loading");
    setRecognitionError("");
    setRecognitionAttempt({ image: rendered.base64, bounds: rendered.bounds, mode });
    try {
      const result = await recognizeInk(rendered.base64, mode, settings);
      setRecognitionResult(result);
      setRecognitionOriginal(result);
      setRecognitionState("result");
      setRecognitionHighlight(rendered.bounds);
    } catch (error) {
      setRecognitionAttempt(null);
      setRecognitionState("error");
      setRecognitionError(`${String(error)} Check the NVIDIA credential and confirm the selected model supports image input.`);
    }
  }

  function insertRecognition() {
    const rendered = recognitionImage(recognitionScope);
    if (!rendered || !recognitionResult.trim()) return;
    commitBoard({
      ...board,
      textObjects: [
        ...board.textObjects,
        {
          id: crypto.randomUUID(),
          x: rendered.bounds.x,
          y: rendered.bounds.y + rendered.bounds.height + 24,
          value: recognitionResult.trim(),
          color: "auto",
          kind: recognitionMode,
        },
      ],
    });
  }

  function rememberCorrection() {
    if (!recognitionAttempt || recognitionFeedbackSaved || !recognitionResult.trim() || recognitionResult.trim() === recognitionOriginal.trim()) return;
    const corrected = recognitionResult.trim();
    const sample: RecognitionSettings["samples"][number] = {
      id: crypto.randomUUID(),
      label: corrected,
      image: recognitionAttempt.image,
      exercise: "feedback",
      mode: recognitionAttempt.mode,
      createdAt: new Date().toISOString(),
    };
    const correction: RecognitionSettings["corrections"][number] = {
      id: crypto.randomUUID(),
      mode: recognitionMode,
      original: recognitionOriginal.trim(),
      corrected,
      createdAt: new Date().toISOString(),
    };
    if (!canStoreProfileSample(sample) || !canStoreCorrection(correction)) {
      const message = "This recognition example is too large to save. Recognize a smaller area and try again.";
      setProfileSaveError(message);
      setCorrectionMessage(message);
      return;
    }
    setSettings((current) => ({
      ...current,
      samples: normalizeProfileSamples([...current.samples, sample]),
      corrections: normalizeCorrections([...current.corrections, correction]),
    }));
    setRecognitionOriginal(corrected);
    setRecognitionFeedbackSaved(true);
    setCorrectionMessage("Correction and visual reference saved for future requests. This does not train the model.");
  }

  function confirmRecognition() {
    if (!recognitionAttempt || recognitionFeedbackSaved || !recognitionResult.trim()) return;
    const sample: RecognitionSettings["samples"][number] = {
      id: crypto.randomUUID(),
      label: recognitionResult.trim(),
      image: recognitionAttempt.image,
      exercise: "feedback",
      mode: recognitionAttempt.mode,
      createdAt: new Date().toISOString(),
    };
    if (!canStoreProfileSample(sample)) {
      const message = "This recognition example is too large to save. Recognize a smaller area and try again.";
      setProfileSaveError(message);
      setCorrectionMessage(message);
      return;
    }
    setSettings((current) => ({
      ...current,
      samples: normalizeProfileSamples([...current.samples, sample]),
    }));
    setRecognitionFeedbackSaved(true);
    setCorrectionMessage("Verified visual reference saved for future requests. This does not train the model.");
  }

  function addCalibrationSample() {
    const source = selectedStrokes.length ? selectedStrokes : [];
    const rendered = renderSelectionImage(source, board.theme);
    if (!rendered || !calibrationLabel.trim()) return;
    const sample: RecognitionSettings["samples"][number] = {
      id: crypto.randomUUID(),
      label: calibrationLabel.trim(),
      image: rendered.base64,
      mode: calibrationMode,
      createdAt: new Date().toISOString(),
    };
    if (!canStoreProfileSample(sample)) {
      setProfileSaveError("This handwriting sample is too large to save. Select a smaller area and try again.");
      return;
    }
    setSettings((current) => ({
      ...current,
      samples: normalizeProfileSamples([...current.samples, sample]),
    }));
    setCalibrationLabel("");
  }

  function practicePoint(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      pressure: event.pressure > 0 ? event.pressure : 0.5,
    };
  }

  function startPracticeStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || practicePointerId.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    practicePointerId.current = event.pointerId;
    currentPracticeStroke.current = {
      id: crypto.randomUUID(),
      color,
      width,
      pointerType: event.pointerType,
      points: [practicePoint(event)],
    };
    redrawPractice();
  }

  function movePracticeStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (practicePointerId.current !== event.pointerId || !currentPracticeStroke.current) return;
    event.preventDefault();
    appendStrokePoint(currentPracticeStroke.current, practicePoint(event));
    redrawPractice();
  }

  function endPracticeStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (practicePointerId.current !== event.pointerId || !currentPracticeStroke.current) return;
    const stroke = currentPracticeStroke.current;
    appendStrokePoint(stroke, practicePoint(event));
    currentPracticeStroke.current = null;
    practicePointerId.current = null;
    setPracticeStrokes((current) => [...current, stroke]);
  }

  function cancelPracticeStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (practicePointerId.current !== event.pointerId) return;
    currentPracticeStroke.current = null;
    practicePointerId.current = null;
    redrawPractice();
  }

  function savePracticeSample() {
    const rendered = renderSelectionImage(practiceStrokes, "white");
    if (!rendered) return;
    const sample: RecognitionSettings["samples"][number] = {
      id: crypto.randomUUID(),
      label: practiceTargetLabel,
      image: rendered.base64,
      exercise: practiceSet.id,
      mode: (practiceSet.id === "math" ? "latex" : "text") as RecognitionMode,
      createdAt: new Date().toISOString(),
    };
    if (!canStoreProfileSample(sample)) {
      setProfileSaveError("This handwriting sample is too large to save. Clear the pad and write a smaller example.");
      return;
    }
    setSettings((current) => ({
      ...current,
      samples: normalizeProfileSamples([...current.samples, sample]),
    }));
    setPracticeStrokes([]);
    setPracticeIndex((current) => (current + 1) % practiceSet.targets.length);
    setPracticeMessage(`Saved ${practiceTarget}. Sample ${practiceCount(settings.samples, practiceSet.id, practiceTargetLabel) + 1} is now in your handwriting profile.`);
  }

  function moveToPracticeTarget(index: number) {
    if (!canDiscardPracticeDraft()) return;
    setPracticeIndex(((index % practiceSet.targets.length) + practiceSet.targets.length) % practiceSet.targets.length);
    setPracticeStrokes([]);
    setPracticeMessage("");
  }

  practiceKeysRef.current = (event: KeyboardEvent) => {
    if (!practiceOpen) return false;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      setPracticeStrokes((current) => current.slice(0, -1));
      return true;
    }
    if (event.key === "Enter") {
      if (practiceReady) savePracticeSample();
      return true;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (canDiscardPracticeDraft()) setPracticeStrokes([]);
      return true;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      moveToPracticeTarget(practiceIndex + (event.key === "ArrowLeft" ? -1 : 1));
      return true;
    }
    return false;
  };

  function canDiscardPracticeDraft() {
    return !practiceStrokes.length || window.confirm("Discard the handwriting currently in the practice pad?");
  }

  function updateInputBinding(binding: keyof InputBindings, key: string) {
    setInputBindings((current) => {
      if (key === "Backspace") return { ...current, [binding]: current[binding].slice(0, -1) };
      if (key === "Delete") return { ...current, [binding]: [] };
      if (!key || key.toLowerCase() === "m" || current[binding].includes(key)) return current;
      const next = Object.fromEntries(
        (Object.keys(current) as (keyof InputBindings)[]).map((candidate) => [
          candidate,
          candidate === binding ? [...current[candidate], key] : current[candidate].filter((item) => item !== key),
        ]),
      ) as InputBindings;
      return next;
    });
  }

  return (
    <main className={`app theme-${board.theme}`}>
      {startupVisible && (
        <div className="startup-screen" aria-label="Starting Whiteboard">
          <div className="startup-mark"><PencilSimple weight="bold" /></div>
          <strong>Whiteboard</strong>
          <span>Opening your canvas...</span>
        </div>
      )}
      <header className="topbar">
        <div className="topbar-group">
          <IconButton label="New board" onClick={newBoard}><FilePlus /></IconButton>
          <IconButton label="Board Library" onClick={openLibrary}><Books /></IconButton>
          <IconButton label="Open board" onClick={openBoard}><ArrowsOutSimple /></IconButton>
          <IconButton label="Save to Board Library" onClick={saveBoard}><FloppyDisk /></IconButton>
          <IconButton label="Encrypted snapshots" onClick={() => setEncryptionMenuOpen(true)}><LockKey /></IconButton>
          <input
            className="board-title"
            aria-label="Board title"
            value={board.title}
            onChange={(event) => updateBoardMetadata((current) => ({ ...current, title: event.target.value }))}
          />
        </div>

        <div className={`save-state save-${saveState}`} aria-live="polite">
          {saveState === "saved" ? "Saved locally" : saveState === "saving" ? "Saving..." : "Save failed"}
        </div>

        <div className="topbar-group">
          <IconButton
            label={board.grid ? "Hide grid" : "Show grid"}
            onClick={() => updateBoardMetadata((current) => ({ ...current, grid: !current.grid }))}
            pressed={board.grid}
          ><GridFour /></IconButton>
          <IconButton
            label="Handwriting practice"
            onClick={() => {
              setPracticeOpen(true);
              setRecognitionOpen(false);
              setSettingsOpen(false);
            selectTool("pen");
            }}
            pressed={practiceOpen}
          ><Student /></IconButton>
          <IconButton
            label="Lock cursor (M)"
            onClick={toggleMousepadCapture}
            pressed={trackpadOpen}
          ><DeviceTablet /></IconButton>
          <button
            className="text-button"
            onClick={() => updateBoardMetadata((current) => ({ ...current, theme: current.theme === "white" ? "black" : "white" }))}
          >
            <Chalkboard /> {board.theme === "white" ? "Blackboard" : "Whiteboard"}
          </button>
          <button className="primary-button" onClick={() => runRecognition("text")}>
            <MagicWand /> Recognize
          </button>
          <IconButton label="Paste (Ctrl+V)" onClick={() => pasteFromClipboard().catch((error) => window.alert(`Could not paste: ${String(error)}`))}><ClipboardText /></IconButton>
          <IconButton label="Insert image" onClick={insertImage}><ImageSquare /></IconButton>
          <IconButton label="Insert LaTeX" onClick={insertLatex}><FunctionIcon /></IconButton>
          <IconButton label="Export PNG" onClick={exportPng}><DownloadSimple /></IconButton>
          <IconButton label="Recognition settings" onClick={() => setSettingsOpen(true)}><GearSix /></IconButton>
        </div>
      </header>

      <section className="canvas-shell" aria-label="Drawing canvas" onPointerDown={focusPasteSink}>
        <textarea
          ref={pasteSinkRef}
          className="paste-sink"
          aria-hidden="true"
          tabIndex={-1}
          onInput={(event) => { event.currentTarget.value = ""; }}
        />
        <canvas
          ref={canvasRef}
          className={`board-canvas cursor-${tool}`}
          onPointerDown={startPointer}
          onPointerEnter={(event) => {
            canvasHover.current = { clientX: event.clientX, clientY: event.clientY, point: boardPoint(event, viewRef.current) };
          }}
          onPointerMove={movePointer}
          onPointerUp={endPointer}
          onPointerCancel={cancelPointer}
          onLostPointerCapture={cancelPointer}
          onAuxClick={(event) => event.preventDefault()}
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
          data-scale={view.scale}
          data-view-x={view.x}
          data-view-y={view.y}
          data-stroke-count={board.strokes.length}
          data-text-count={board.textObjects.length}
          data-selected-count={selection.size}
          data-image-count={board.imageObjects.length}
          data-visible-text-count={visibleTextObjects.length}
          data-canvas-width={canvasSize.width}
          data-canvas-height={canvasSize.height}
          aria-label="Whiteboard. Left drag uses the current tool, middle drag pans, right drag selects, and the wheel zooms."
        />
        {settings.handwritingFontEnabled && visibleTextObjects.filter((item) => item.kind === "text").map((item) => {
          const fontSize = item.fontSize ?? 20;
          return (
            <div
              key={item.id}
              className="handwriting-text-object"
              style={{
                left: item.x * view.scale + view.x,
                top: item.y * view.scale + view.y,
                color: inkColor(item.color, board.theme),
                fontSize,
                transform: `scale(${view.scale})`,
              }}
            >
              {item.value.split("\n").map((line, lineIndex) => (
                <div key={lineIndex} className="handwriting-line">
                  {[...line].map((character, characterIndex) => {
                    const glyph = handwritingGlyphs[character];
                    return glyph ? (
                      <span
                        key={characterIndex}
                        className="handwriting-glyph"
                        style={{
                          width: Math.max(fontSize * 0.35, fontSize * glyph.aspect),
                          height: fontSize,
                          backgroundColor: inkColor(item.color, board.theme),
                          WebkitMaskImage: `url(${glyph.dataUrl})`,
                          maskImage: `url(${glyph.dataUrl})`,
                        }}
                      />
                    ) : <span key={characterIndex} className="handwriting-fallback">{character}</span>;
                  })}
                </div>
              ))}
            </div>
          );
        })}
        <Suspense fallback={null}>
          {visibleTextObjects.filter((item) => item.kind === "latex").map((item) => (
            <LatexMarkup
              key={item.id}
              className="latex-board-object"
              value={item.value}
              style={{
                left: item.x * view.scale + view.x,
                top: item.y * view.scale + view.y,
                color: inkColor(item.color, board.theme),
                fontSize: item.fontSize ?? 20,
                transform: `scale(${view.scale})`,
              }}
            />
          ))}
        </Suspense>
        {trackpadOpen && mousepadCursor && (
          <>
            <div className="mousepad-capture-status">Cursor locked - hold left click to draw, press M or Esc to release</div>
            <div className="mousepad-cursor" style={{ left: mousepadCursor.x, top: mousepadCursor.y }} />
          </>
        )}
        {selectionBox && (
          <div
            className="selection-box"
            style={{
              left: selectionBox.x * view.scale + view.x,
              top: selectionBox.y * view.scale + view.y,
              width: selectionBox.width * view.scale,
              height: selectionBox.height * view.scale,
            }}
          />
        )}
        {recognitionHighlight && recognitionOpen && (
          <div
            className="recognition-highlight"
            aria-hidden="true"
            style={{
              left: recognitionHighlight.x * view.scale + view.x,
              top: recognitionHighlight.y * view.scale + view.y,
              width: recognitionHighlight.width * view.scale,
              height: recognitionHighlight.height * view.scale,
            }}
          />
        )}
        {selectionBounds && (
          <div
            className="selection-transform-box"
            style={{
              left: selectionBounds.x * view.scale + view.x,
              top: selectionBounds.y * view.scale + view.y,
              width: selectionBounds.width * view.scale,
              height: selectionBounds.height * view.scale,
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || event.target !== event.currentTarget) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              const rect = canvasRef.current?.getBoundingClientRect();
              if (!rect) return;
              beginSelectionTransform("move", {
                x: (event.clientX - rect.left - viewRef.current.x) / viewRef.current.scale,
                y: (event.clientY - rect.top - viewRef.current.y) / viewRef.current.scale,
                pressure: 0.5,
              });
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId) || selectionTransformRef.current?.mode !== "move") return;
              const rect = canvasRef.current?.getBoundingClientRect();
              if (!rect) return;
              updateSelectionTransform({
                x: (event.clientX - rect.left - viewRef.current.x) / viewRef.current.scale,
                y: (event.clientY - rect.top - viewRef.current.y) / viewRef.current.scale,
                pressure: 0.5,
              });
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              event.currentTarget.releasePointerCapture(event.pointerId);
              finishSelectionTransform();
            }}
            onPointerCancel={cancelSelectionTransform}
          >
            <button
              className="selection-resize-handle"
              aria-label="Resize selection"
              title="Drag to resize selection"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                const rect = canvasRef.current?.getBoundingClientRect();
                if (!rect) return;
                beginSelectionTransform("resize", {
                  x: (event.clientX - rect.left - viewRef.current.x) / viewRef.current.scale,
                  y: (event.clientY - rect.top - viewRef.current.y) / viewRef.current.scale,
                  pressure: 0.5,
                });
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const rect = canvasRef.current?.getBoundingClientRect();
                if (!rect) return;
                updateSelectionTransform({
                  x: (event.clientX - rect.left - viewRef.current.x) / viewRef.current.scale,
                  y: (event.clientY - rect.top - viewRef.current.y) / viewRef.current.scale,
                  pressure: 0.5,
                });
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                finishSelectionTransform();
              }}
              onPointerCancel={cancelSelectionTransform}
            />
          </div>
        )}
        {textEditor && (
          <form
            className="text-editor-popover"
            role="dialog"
            aria-labelledby="text-editor-title"
            style={{
              left: `clamp(12px, ${textEditor.anchorX + 12}px, calc(100% - 344px))`,
              top: `clamp(12px, ${textEditor.anchorY + 12}px, calc(100% - 300px))`,
            }}
            onSubmit={(event) => {
              event.preventDefault();
              saveTextEditor();
            }}
          >
            <div className="text-editor-header">
              <div>
                <strong id="text-editor-title">{textEditor.targetId ? "Edit" : "Add"} {textEditor.kind === "latex" ? "LaTeX" : "text"}</strong>
                <span>{textEditor.kind === "latex" ? "Write an equation using LaTeX." : "Add a note directly to the board."}</span>
              </div>
              <button type="button" className="icon-button" aria-label="Cancel text editing" title="Cancel text editing" onClick={() => setTextEditor(null)}><X /></button>
            </div>
            <textarea
              autoFocus
              aria-label={textEditor.kind === "latex" ? "LaTeX source" : "Text content"}
              rows={textEditor.kind === "latex" ? 3 : 4}
              placeholder={textEditor.kind === "latex" ? String.raw`\frac{a}{b}` : "Type here"}
              value={textEditor.value}
              onChange={(event) => setTextEditor((current) => current ? { ...current, value: event.target.value } : current)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setTextEditor(null);
                else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) event.currentTarget.form?.requestSubmit();
              }}
            />
            {textEditor.kind === "latex" && textEditor.value.trim() && (
              <Suspense fallback={null}>
                <LatexMarkup className="text-editor-preview" label="LaTeX preview" value={textEditor.value} />
              </Suspense>
            )}
            <div className="text-editor-actions">
              <span>Ctrl+Enter to save</span>
              <button type="button" className="text-button" onClick={() => setTextEditor(null)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!textEditor.value.trim()}>
                {textEditor.targetId ? "Save changes" : textEditor.kind === "latex" ? "Insert LaTeX" : "Insert text"}
              </button>
            </div>
          </form>
        )}
        {!board.strokes.length && !board.textObjects.length && !board.imageObjects.length && (
          <div className="empty-state">
            <PencilSimple />
            <strong>Start drawing</strong>
            <span>Use a mouse, finger, or stylus. Your board saves automatically.</span>
          </div>
        )}
        <div className="zoom-control" aria-label="Zoom controls">
          <IconButton label="Zoom out" onClick={() => zoomBy(1 / 1.15)}><Minus /></IconButton>
          <button className="zoom-value" aria-label="Reset zoom to 100%" title="Reset zoom to 100%" onClick={fitBoard}>{Math.round(view.scale * 100)}%</button>
          <IconButton label="Zoom in" onClick={() => zoomBy(1.15)}><Plus /></IconButton>
        </div>
      </section>

      <nav className="tool-dock" aria-label="Drawing tools">
        <div
          className="tool-group"
          onWheel={(event) => {
            event.preventDefault();
            const tools: Tool[] = ["select", "pen", "eraser", "hand", "text"];
            const index = tools.indexOf(tool);
            selectTool(tools[(index + (event.deltaY > 0 ? 1 : -1) + tools.length) % tools.length]);
          }}
        >
          <ToolButton tool="select" active={tool === "select"} label="Select (A)" onClick={selectTool}><Selection /></ToolButton>
          <ToolButton tool="pen" active={tool === "pen"} label="Pen (P)" onClick={selectTool}><PencilSimple /></ToolButton>
          <ToolButton tool="eraser" active={tool === "eraser"} label="Eraser (Shift)" onClick={selectTool}><Eraser /></ToolButton>
          <ToolButton tool="hand" active={tool === "hand"} label="Pan (S)" onClick={selectTool}><Hand /></ToolButton>
          <ToolButton tool="text" active={tool === "text"} label="Text (D)" onClick={selectTool}><TextT /></ToolButton>
        </div>
        <div className="dock-separator" />
        <div className="color-list" aria-label="Ink color">
          {COLORS.map((item) => (
            <button
              key={item}
              className={`color-swatch ${color === item ? "selected" : ""}`}
              style={{ background: inkColor(item, board.theme) }}
              onClick={() => setColor(item)}
              aria-label={item === "auto" ? "Automatic ink color" : `Ink color ${item}`}
              aria-pressed={color === item}
            >
              {color === item && <Check weight="bold" />}
            </button>
          ))}
        </div>
        <label className="width-control">
          <span>Size</span>
          <input ref={widthInputRef} aria-label="Brush size" type="number" min="1" max="18" value={width} onInput={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isFinite(value)) {
              widthRef.current = Math.min(18, Math.max(1, value));
              setWidth(widthRef.current);
              localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ ...loadUiPreferences(), width: widthRef.current }));
            }
          }} onBlur={() => pasteSinkRef.current?.focus({ preventScroll: true })} />
        </label>
        <div className="dock-separator" />
        <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!undoStack.current.length}><ArrowCounterClockwise /></IconButton>
        <IconButton label="Redo (Ctrl+Y)" onClick={redo} disabled={!redoStack.current.length}><ArrowClockwise /></IconButton>
        <IconButton label="Delete selection (Delete)" onClick={deleteSelection} disabled={!selection.size}><Trash /></IconButton>
        <IconButton
          label="Clear screen"
          onClick={() => setClearMenuOpen((current) => !current)}
          pressed={clearMenuOpen}
          disabled={!board.strokes.length && !board.textObjects.length && !board.imageObjects.length}
        ><Broom /></IconButton>
      </nav>

      {clearMenuOpen && (
        <section className="clear-menu" role="dialog" aria-labelledby="clear-menu-title">
          <div className="panel-header">
            <div>
              <h2 id="clear-menu-title">Clear content</h2>
              <p>Choose how much of this whiteboard to remove.</p>
            </div>
            <IconButton label="Close clear menu" onClick={() => setClearMenuOpen(false)}><X /></IconButton>
          </div>
          <div className="segmented-control clear-scope">
            <button className={clearScope === "visible" ? "active" : ""} onClick={() => setClearScope("visible")}>Visible screen</button>
            <button className={clearScope === "board" ? "active" : ""} onClick={() => setClearScope("board")}>Entire board</button>
          </div>
          <button className="danger-button clear-confirm" onClick={clearBoardScope}>
            {clearScope === "visible" ? "Clear visible screen" : "Clear entire board"}
          </button>
        </section>
      )}

      {recognitionOpen && (
        <aside className="side-panel recognition-panel" aria-label="Recognition results">
          <div className="panel-header">
            <div>
              <h2>Recognition</h2>
              <p>{recognitionScope === "visible" ? "Visible grid-aligned area" : recognitionScope === "selection" ? `${selectedStrokes.length} selected strokes` : "Entire board"}</p>
            </div>
            <IconButton label="Close recognition" onClick={() => {
              setRecognitionOpen(false);
              setRecognitionHighlight(null);
            }}><X /></IconButton>
          </div>
          <div className="segmented-control">
            <button className={recognitionMode === "text" ? "active" : ""} onClick={() => runRecognition("text")}>Text</button>
            <button className={recognitionMode === "latex" ? "active" : ""} onClick={() => runRecognition("latex")}>LaTeX</button>
          </div>
          <div className="segmented-control recognition-scope">
            <button className={recognitionScope === "visible" ? "active" : ""} onClick={() => runRecognition(recognitionMode, "visible")}>Visible area</button>
            <button className={recognitionScope === "selection" ? "active" : ""} disabled={!selectedStrokes.length} onClick={() => runRecognition(recognitionMode, "selection")}>Selection</button>
            <button className={recognitionScope === "board" ? "active" : ""} onClick={() => runRecognition(recognitionMode, "board")}>Entire board</button>
          </div>
          {recognitionState === "loading" && (
            <div className="recognition-message" aria-live="polite">
              <div className="loading-line" />
              <div className="loading-line short" />
              <p>Reading ink with {settings.model}...</p>
            </div>
          )}
          {recognitionState === "error" && (
            <div className="error-message" role="alert">
              <strong>Recognition unavailable</strong>
              <p>{recognitionError}</p>
              <button className="text-button" onClick={() => setSettingsOpen(true)}>Open settings</button>
            </div>
          )}
          {recognitionState === "result" && (
            <div className="result-editor">
              {recognitionMode === "latex" && recognitionResult.trim() && (
                <Suspense fallback={null}>
                  <LatexMarkup className="latex-preview" value={recognitionResult} displayMode />
                </Suspense>
              )}
              <label htmlFor="recognition-result">Correct the recognized text</label>
              <textarea id="recognition-result" value={recognitionResult} onChange={(event) => setRecognitionResult(event.target.value)} rows={8} />
              <div className="panel-actions">
                <button className="primary-button" onClick={insertRecognition}>Insert below ink</button>
                <button className="text-button" onClick={() => navigator.clipboard.writeText(recognitionResult)}>Copy</button>
                <button className="text-button" onClick={confirmRecognition} disabled={recognitionFeedbackSaved || recognitionResult.trim() !== recognitionOriginal.trim()}>Looks correct</button>
                <button className="text-button" onClick={rememberCorrection} disabled={recognitionFeedbackSaved || recognitionResult.trim() === recognitionOriginal.trim()}>Save correction</button>
              </div>
              {correctionMessage && <p className="practice-message" aria-live="polite">{correctionMessage}</p>}
              <p className="fine-print">Review recognition before using it. Original ink is never removed automatically.</p>
            </div>
          )}
        </aside>
      )}

      {practiceOpen && (
        <aside className="side-panel practice-panel" aria-label="Handwriting practice">
          <div className="panel-header">
            <div>
              <h2>Handwriting practice</h2>
              <p>Repeated labeled samples expand the reference sheet used during recognition.</p>
            </div>
            <IconButton label="Close practice" onClick={() => setPracticeOpen(false)}><X /></IconButton>
          </div>
          <label className="field practice-set-field">
            <span>Exercise</span>
            <select
              value={practiceSet.id}
              onChange={(event) => {
                if (!canDiscardPracticeDraft()) return;
                setPracticeSetId(event.target.value);
                setPracticeIndex(0);
                setPracticeStrokes([]);
                setPracticeMessage("");
              }}
            >
              {PRACTICE_SETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <p className="practice-description">{practiceSet.description}</p>
          <div className="practice-target" aria-live="polite">
            <span>Write</span>
            <strong>{practiceTarget}</strong>
            <small>{practiceCount(settings.samples, practiceSet.id, practiceTargetLabel)} saved samples</small>
          </div>
          <div className="practice-progress" aria-label={`Item ${practiceIndex + 1} of ${practiceSet.targets.length}`}>
            {practiceSet.targets.map((target, index) => (
              <button
                key={`${target}-${index}`}
                className={index === practiceIndex ? "active" : ""}
                onClick={() => {
                  if (!canDiscardPracticeDraft()) return;
                  setPracticeIndex(index);
                  setPracticeStrokes([]);
                  setPracticeMessage("");
                }}
                aria-label={`${target}: ${practiceCount(settings.samples, practiceSet.id, practiceLabel(practiceSet, target))} samples`}
                aria-pressed={index === practiceIndex}
              >
                {target}
              </button>
            ))}
          </div>
          <div className="practice-pad-wrap">
            <canvas
              ref={practiceCanvasRef}
              className="practice-pad"
              aria-label={`Write ${practiceTarget} here`}
              onPointerDown={startPracticeStroke}
              onPointerMove={movePracticeStroke}
              onPointerUp={endPracticeStroke}
              onPointerCancel={cancelPracticeStroke}
              onContextMenu={(event) => event.preventDefault()}
              data-stroke-count={practiceStrokes.length}
            />
            {!practiceStrokes.length && <span>Write {practiceTarget} here</span>}
          </div>
          <p className="practice-hint">Use as many strokes as needed, then save. Repeat targets to provide more examples. Enter saves, arrows change target, Ctrl+Z undoes a stroke, Delete clears, and [ or ] changes pen width.</p>
          <div className="practice-actions">
            <button className="text-button" onClick={() => moveToPracticeTarget(practiceIndex - 1)}>Previous</button>
            <button className="primary-button" onClick={savePracticeSample} disabled={!practiceReady}>Save sample and next</button>
            <button className="text-button" onClick={() => moveToPracticeTarget(practiceIndex + 1)}>Skip</button>
          </div>
          <div className="practice-edit-actions">
            <button className="text-button" onClick={() => setPracticeStrokes((current) => current.slice(0, -1))} disabled={!practiceStrokes.length}>Undo stroke</button>
            <button className="text-button" onClick={() => setPracticeStrokes([])} disabled={!practiceStrokes.length}>Clear writing</button>
          </div>
          {practiceMessage && <p className="practice-message" aria-live="polite">{practiceMessage}</p>}
          {profileSaveError && <p className="error-message" role="alert">{profileSaveError}</p>}
          <p className="fine-print">This is reference-based personalization, not local model fine-tuning. More varied, correctly labeled samples can help but do not guarantee accuracy.</p>
        </aside>
      )}

      {libraryOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setLibraryOpen(false)}>
          <section className="library-modal" role="dialog" aria-modal="true" aria-labelledby="library-title">
            <div className="panel-header">
              <div>
                <h2 id="library-title">Board Library</h2>
                <p>Boards autosaved by the native app. Use Open for files elsewhere on your system.</p>
              </div>
              <IconButton label="Close Board Library" onClick={() => setLibraryOpen(false)}><X /></IconButton>
            </div>
            {libraryError && <div className="error-message" role="alert"><p>{libraryError}</p></div>}
            {libraryLoading && !libraryBoards.length && (
              <div className="library-skeleton" aria-label="Loading boards">
                {[0, 1, 2].map((item) => <div key={item}><span /><span /></div>)}
              </div>
            )}
            {!libraryLoading && !libraryError && !libraryBoards.length && (
              <div className="library-empty">{libraryOffset ? "No readable boards on this page." : "No saved boards yet."}</div>
            )}
            <div className="library-list" aria-busy={libraryLoading}>
              {libraryBoards.map((item) => (
                <button key={item.id} onClick={() => loadLibraryBoard(item.id)}>
                  <strong>{item.title}</strong>
                  <span>{new Date(item.updatedAt).toLocaleString()}</span>
                </button>
              ))}
            </div>
            {(libraryBoards.length > 0 || libraryOffset > 0) && (
              <nav className="library-pagination" aria-label="Board library pages">
                <span aria-live="polite">Page {Math.floor(libraryOffset / LIBRARY_PAGE_SIZE) + 1}</span>
                <button
                  type="button"
                  className="text-button"
                  aria-label="Newer boards"
                  disabled={libraryLoading || libraryOffset === 0}
                  onClick={() => loadLibraryPage(Math.max(0, libraryOffset - LIBRARY_PAGE_SIZE))}
                >Newer</button>
                <button
                  type="button"
                  className="text-button"
                  aria-label="Older boards"
                  disabled={libraryLoading || !libraryHasMore}
                  onClick={() => loadLibraryPage(libraryOffset + LIBRARY_PAGE_SIZE)}
                >Older</button>
              </nav>
            )}
          </section>
        </div>
      )}

      {encryptionMenuOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setEncryptionMenuOpen(false)}>
          <section className="encryption-modal" role="dialog" aria-modal="true" aria-labelledby="encryption-menu-title">
            <div className="panel-header">
              <div>
                <h2 id="encryption-menu-title">Encrypted snapshots</h2>
                <p>Open or create a password-protected copy outside the automatic Board Library.</p>
              </div>
              <IconButton label="Close encrypted snapshots" onClick={() => setEncryptionMenuOpen(false)}><X /></IconButton>
            </div>
            <div className="panel-actions">
              <button className="text-button" onClick={() => prepareEncryption("open")}>Open encrypted snapshot</button>
              <button className="primary-button" onClick={() => prepareEncryption("save")}>Save encrypted snapshot</button>
            </div>
          </section>
        </div>
      )}

      {encryptionRequest && (
        <div className="modal-backdrop">
          <section className="encryption-modal" role="dialog" aria-modal="true" aria-labelledby="encryption-title">
            <div className="panel-header">
              <div>
                <h2 id="encryption-title">{encryptionRequest.action === "save" ? "Encrypt board" : "Unlock board"}</h2>
                <p>{encryptionRequest.action === "save" ? "The passphrase is required every time this snapshot is opened and is never stored." : "Enter the passphrase used when this board was encrypted."}</p>
              </div>
              <IconButton label="Cancel encryption" onClick={() => {
                setEncryptionPassword("");
                setEncryptionConfirmation("");
                setEncryptionRequest(null);
                setEncryptionError("");
              }}><X /></IconButton>
            </div>
            <label className="field">
              <span>Passphrase</span>
              <input type="password" autoFocus value={encryptionPassword} onChange={(event) => setEncryptionPassword(event.target.value)} />
            </label>
            {encryptionRequest.action === "save" && (
              <label className="field">
                <span>Confirm passphrase</span>
                <input type="password" value={encryptionConfirmation} onChange={(event) => setEncryptionConfirmation(event.target.value)} />
              </label>
            )}
            {encryptionError && <div className="error-message" role="alert"><p>{encryptionError}</p></div>}
            <div className="panel-actions">
              <button className="primary-button" onClick={submitEncryption}>{encryptionRequest.action === "save" ? "Encrypt and save" : "Unlock"}</button>
            </div>
            <p className="fine-print">Encryption uses Argon2id and AES-256-GCM. Losing the passphrase makes the file unrecoverable. Native library recovery remains a separate private plaintext copy.</p>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSettingsOpen(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="panel-header">
              <div>
                <h2 id="settings-title">Model recognition</h2>
                <p>The native app reads your NVIDIA key privately from ~/.fcc/.env. The key is never exposed to the interface.</p>
              </div>
              <IconButton label="Close settings" onClick={() => setSettingsOpen(false)}><X /></IconButton>
            </div>
            <label className="field">
              <span>NVIDIA vision model</span>
              <input list="ollama-models" value={settings.model} onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))} />
              <datalist id="ollama-models">{availableModels.map((model) => <option key={model} value={model} />)}</datalist>
            </label>
            <div className="model-check">
              <button className="text-button" onClick={checkModel}>Check connection</button>
              <span aria-live="polite">{modelStatus}</span>
            </div>
            <div className="settings-section">
              <h3>Input bindings</h3>
              <p>Osu-style controls: hold a bound key while moving the cursor over the canvas. Each key behaves like its matching mouse button.</p>
              <div className="binding-grid">
                <label className="field">
                  <span>Left mouse key</span>
                  <input
                    readOnly
                    value={inputBindings.leftKeys.map(keyLabel).join(", ")}
                    onKeyDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      updateInputBinding("leftKeys", event.key);
                    }}
                    aria-label="Left mouse key"
                  />
                </label>
                <label className="field">
                  <span>Middle mouse key</span>
                  <input
                    readOnly
                    value={inputBindings.middleKeys.map(keyLabel).join(", ")}
                    onKeyDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      updateInputBinding("middleKeys", event.key);
                    }}
                    aria-label="Middle mouse key"
                  />
                </label>
                <label className="field">
                  <span>Right mouse key</span>
                  <input
                    readOnly
                    value={inputBindings.rightKeys.map(keyLabel).join(", ")}
                    onKeyDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      updateInputBinding("rightKeys", event.key);
                    }}
                    aria-label="Right mouse key"
                  />
                </label>
              </div>
              <p className="fine-print">Focus a field and press one or more keys to add them. Backspace removes the last key, Delete clears the field, and M is reserved for cursor lock.</p>
            </div>
            <div className="settings-section">
              <h3>Handwriting profile</h3>
              <p>Save selected ink with its correct text. These examples guide recognition; they do not fine-tune the model.</p>
              <label className="field">
                <span>Correct text for selected ink</span>
                <input value={calibrationLabel} onChange={(event) => setCalibrationLabel(event.target.value)} />
              </label>
              <label className="field">
                <span>Sample type</span>
                <select value={calibrationMode} onChange={(event) => setCalibrationMode(event.target.value as RecognitionMode)}>
                  <option value="text">Text</option>
                  <option value="latex">LaTeX</option>
                </select>
              </label>
              <button className="text-button" onClick={addCalibrationSample} disabled={!selectedStrokes.length || !calibrationLabel.trim()}>
                Add selected sample
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setSettingsOpen(false);
                  setRecognitionOpen(false);
                  setPracticeOpen(true);
                  setTool("pen");
                }}
              >Start guided practice</button>
              <div className="font-progress">
                <div>
                  <strong>Experimental handwriting text</strong>
                  <span>{handwritingCoverage}/26 lowercase letters have 5 samples</span>
                </div>
                <button
                  className="text-button"
                  disabled={!handwritingFontReady}
                  aria-pressed={settings.handwritingFontEnabled}
                  onClick={() => setSettings((current) => ({ ...current, handwritingFontEnabled: !current.handwritingFontEnabled }))}
                >{settings.handwritingFontEnabled ? "Use system font" : "Use my handwriting"}</button>
              </div>
              <p className="fine-print">When unlocked, lowercase letters use your latest guided samples on the board. Other characters and PNG export use the system-font fallback.</p>
              <div className="sample-summary">
                <span>{settings.samples.length} samples</span>
                <span>{settings.corrections.length} corrections</span>
                {(settings.samples.length > 0 || settings.corrections.length > 0) && (
                  <button className="danger-button" onClick={() => setSettings((current) => ({ ...current, samples: [], corrections: [] }))}>Delete profile</button>
                )}
              </div>
              {profileSaveError && <p className="error-message" role="alert">{profileSaveError}</p>}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function IconButton({ label, onClick, disabled, pressed, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: React.ReactNode }) {
  return <button className={`icon-button ${pressed ? "active" : ""}`} aria-label={label} title={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}>{children}</button>;
}

function ToolButton({ tool, active, label, onClick, children }: { tool: Tool; active: boolean; label: string; onClick: (tool: Tool) => void; children: React.ReactNode }) {
  return (
    <button className={`tool-button ${active ? "active" : ""}`} aria-label={label} title={label} aria-pressed={active} onClick={() => onClick(tool)}>
      {children}<span>{label.split(" ")[0]}</span>
    </button>
  );
}

export default App;
