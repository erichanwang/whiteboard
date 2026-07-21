import {
  ArrowCounterClockwise,
  ArrowClockwise,
  ArrowsOutSimple,
  Books,
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
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke, isTauri } from "@tauri-apps/api/core";
import katex from "katex";
import "katex/dist/katex.min.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  BOARD_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  createBoard,
  defaultBoardTitle,
  drawBoard,
  drawGrid,
  inkColor,
  intersectsBounds,
  parseBoard,
  pointHitsStroke,
  renderSelectionImage,
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
  Tool,
} from "./types";

const COLORS = ["auto", "#356f9f", "#b54d4d", "#377d6a", "#b47728"];
const INPUT_STORAGE_KEY = "whiteboard.input.v1";
const UI_STORAGE_KEY = "whiteboard.ui.v1";
const DEFAULT_SETTINGS: RecognitionSettings = {
  provider: "nvidia",
  model: "mistralai/mistral-large-3-675b-instruct-2512",
  samples: [],
  corrections: [],
};

type SaveState = "saved" | "saving" | "error";
type RecognitionState = "idle" | "loading" | "result" | "error";
type RecognitionScope = "visible" | "selection" | "board";
type InputBindings = { drawKey: string; panKey: string; selectKey: string };
type UiPreferences = { tool: Tool; color: string; width: number; trackpadHoverDraw: boolean };
type LibraryBoard = { id: string; title: string; updatedAt: string };
type EncryptionRequest = { action: "save" | "open"; path: string; encrypted?: Uint8Array };

const DEFAULT_INPUT_BINDINGS: InputBindings = { drawKey: "z", panKey: " ", selectKey: "x" };

function loadInputBindings(): InputBindings {
  try {
    const parsed = JSON.parse(localStorage.getItem(INPUT_STORAGE_KEY) ?? "null") as Partial<InputBindings> | null;
    return {
      drawKey: typeof parsed?.drawKey === "string" && parsed.drawKey ? parsed.drawKey : DEFAULT_INPUT_BINDINGS.drawKey,
      panKey: typeof parsed?.panKey === "string" && parsed.panKey ? parsed.panKey : DEFAULT_INPUT_BINDINGS.panKey,
      selectKey: typeof parsed?.selectKey === "string" && parsed.selectKey ? parsed.selectKey : DEFAULT_INPUT_BINDINGS.selectKey,
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
      trackpadHoverDraw: parsed?.trackpadHoverDraw === true,
    };
  } catch {
    return { tool: "pen", color: "auto", width: 4, trackpadHoverDraw: false };
  }
}

function loadBoard(): BoardDocument {
  try {
    const saved = localStorage.getItem(BOARD_STORAGE_KEY);
    return saved ? parseBoard(saved) : createBoard();
  } catch {
    return createBoard();
  }
}

function loadSettings(): RecognitionSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<RecognitionSettings> & { endpoint?: string };
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      provider: "nvidia",
      model: parsed.model?.includes("/") ? parsed.model : DEFAULT_SETTINGS.model,
      samples: Array.isArray(parsed.samples) ? parsed.samples.filter((sample) => sample && typeof sample.image === "string" && typeof sample.label === "string") : [],
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections.filter((correction) => correction && typeof correction.original === "string" && typeof correction.corrected === "string") : [],
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function cloneBoard(board: BoardDocument): BoardDocument {
  return structuredClone(board);
}

function bytesToDataUrl(bytes: Uint8Array, mime: string) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(new Blob([bytes], { type: mime }));
  });
}

function imageDimensions(source: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("The selected file is not a supported image."));
    image.src = source;
  });
}

function selectedBoardIds(board: BoardDocument, bounds: Bounds) {
  return new Set([
    ...board.strokes.filter((stroke) => intersectsBounds(stroke, bounds)).map((stroke) => stroke.id),
    ...board.imageObjects.filter((item) => (
      item.x <= bounds.x + bounds.width && item.x + item.width >= bounds.x
      && item.y <= bounds.y + bounds.height && item.y + item.height >= bounds.y
    )).map((item) => item.id),
  ]);
}

function boardPoint(event: React.PointerEvent<HTMLCanvasElement>, view: { x: number; y: number; scale: number }) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - view.x) / view.scale,
    y: (event.clientY - rect.top - view.y) / view.scale,
    pressure: event.pressure > 0 ? event.pressure : 0.5,
    time: Date.now(),
  } satisfies Point;
}

function App() {
  const [board, setBoard] = useState(loadBoard);
  const [tool, setTool] = useState<Tool>(() => loadUiPreferences().tool);
  const [color, setColor] = useState(() => loadUiPreferences().color);
  const [width, setWidth] = useState(() => loadUiPreferences().width);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<Bounds | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [filePath, setFilePath] = useState<string | null>(null);
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
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [practiceSetId, setPracticeSetId] = useState(PRACTICE_SETS[0].id);
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [practiceMessage, setPracticeMessage] = useState("");
  const [practiceStrokes, setPracticeStrokes] = useState<Stroke[]>([]);
  const [trackpadOpen, setTrackpadOpen] = useState(false);
  const [trackpadHoverDraw, setTrackpadHoverDraw] = useState(() => loadUiPreferences().trackpadHoverDraw);
  const [inputBindings, setInputBindings] = useState(loadInputBindings);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryBoards, setLibraryBoards] = useState<LibraryBoard[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [startupVisible, setStartupVisible] = useState(true);
  const [encryptionRequest, setEncryptionRequest] = useState<EncryptionRequest | null>(null);
  const [encryptionPassword, setEncryptionPassword] = useState("");
  const [encryptionConfirmation, setEncryptionConfirmation] = useState("");
  const [encryptionError, setEncryptionError] = useState("");

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
  const fileWriteChain = useRef<Promise<void>>(Promise.resolve());
  const mappedPointerId = useRef<number | null>(null);
  const practicePointerId = useRef<number | null>(null);
  const currentPracticeStroke = useRef<Stroke | null>(null);
  const practiceStrokesRef = useRef(practiceStrokes);
  const pressedKeys = useRef(new Set<string>());
  const canvasHover = useRef<{ clientX: number; clientY: number; point: Point } | null>(null);
  const keyboardPointerAction = useRef<"draw" | "pan" | "select" | null>(null);

  boardRef.current = board;
  viewRef.current = view;
  selectionRef.current = selection;
  practiceStrokesRef.current = practiceStrokes;

  useEffect(() => {
    const timeout = window.setTimeout(() => setStartupVisible(false), 550);
    return () => window.clearTimeout(timeout);
  }, []);

  const selectedStrokes = useMemo(
    () => board.strokes.filter((stroke) => selection.has(stroke.id)),
    [board.strokes, selection],
  );
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

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(
      dpr * viewRef.current.scale,
      0,
      0,
      dpr * viewRef.current.scale,
      dpr * viewRef.current.x,
      dpr * viewRef.current.y,
    );
    if (boardRef.current.grid) {
      drawGrid(
        context,
        {
          x: -viewRef.current.x / viewRef.current.scale,
          y: -viewRef.current.y / viewRef.current.scale,
          width: rect.width / viewRef.current.scale,
          height: rect.height / viewRef.current.scale,
        },
        boardRef.current.theme,
        viewRef.current.scale,
      );
    }
    drawBoard(context, boardRef.current.strokes, boardRef.current.textObjects, boardRef.current.imageObjects, boardRef.current.theme, selectionRef.current);
    if (currentStroke.current) drawBoard(context, [currentStroke.current], [], [], boardRef.current.theme);
  }, []);

  useEffect(() => redraw(), [board, view, selection, redraw]);

  useEffect(() => {
    window.addEventListener("whiteboard-image-loaded", redraw);
    return () => window.removeEventListener("whiteboard-image-loaded", redraw);
  }, [redraw]);

  const redrawPractice = useCallback(() => {
    const canvas = practiceCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = "#fcfcfa";
    context.fillRect(0, 0, rect.width, rect.height);
    drawGrid(context, { x: 0, y: 0, width: rect.width, height: rect.height }, "white", 1);
    drawBoard(context, practiceStrokesRef.current, [], [], "white");
    if (currentPracticeStroke.current) drawBoard(context, [currentPracticeStroke.current], [], [], "white");
  }, []);

  useEffect(() => redrawPractice(), [practiceOpen, practiceStrokes, redrawPractice]);

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
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [redraw]);

  useEffect(() => {
    const serialized = JSON.stringify(board);
    let browserSaved = true;
    try {
      localStorage.setItem(BOARD_STORAGE_KEY, serialized);
    } catch {
      browserSaved = false;
      setSaveState("error");
    }
    setSaveState("saving");
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const formatted = JSON.stringify(board, null, 2);
        if (filePath) {
          fileWriteChain.current = fileWriteChain.current
            .catch(() => undefined)
            .then(() => writeTextFile(filePath, formatted));
          await fileWriteChain.current;
        }
        if (isTauri()) await invoke("save_library_board", { boardJson: formatted, boardId: board.id });
        if (cancelled) return;
        setSaveState(browserSaved || isTauri() ? "saved" : "error");
      } catch {
        if (cancelled) return;
        setSaveState("error");
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [board, filePath]);

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
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ tool, color, width, trackpadHoverDraw } satisfies UiPreferences));
  }, [tool, color, width, trackpadHoverDraw]);

  const commitBoard = useCallback((next: BoardDocument) => {
    undoStack.current.push(cloneBoard(boardRef.current));
    if (undoStack.current.length > 80) undoStack.current.shift();
    redoStack.current = [];
    setBoard({ ...next, updatedAt: new Date().toISOString() });
  }, []);

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    redoStack.current.push(cloneBoard(boardRef.current));
    setBoard(previous);
    setSelection(new Set());
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(cloneBoard(boardRef.current));
    setBoard(next);
    setSelection(new Set());
  }, []);

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
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (!event.repeat && canvasHover.current && !keyboardPointerAction.current && !currentStroke.current && !dragOrigin.current && !selectionOrigin.current
        && [inputBindings.drawKey, inputBindings.panKey, inputBindings.selectKey].includes(event.key)) {
        event.preventDefault();
        const hover = canvasHover.current;
        if (event.key === inputBindings.drawKey) {
          keyboardPointerAction.current = "draw";
          currentStroke.current = {
            id: crypto.randomUUID(),
            color,
            width,
            pointerType: "keyboard",
            points: [hover.point],
          };
          setSelection(new Set());
        } else if (event.key === inputBindings.panKey) {
          keyboardPointerAction.current = "pan";
          dragOrigin.current = {
            point: { x: hover.clientX, y: hover.clientY, pressure: 0.5, time: Date.now() },
            view: viewRef.current,
          };
        } else {
          keyboardPointerAction.current = "select";
          selectionOrigin.current = hover.point;
          setSelection(new Set());
          setSelectionBox({ x: hover.point.x, y: hover.point.y, width: 0, height: 0 });
        }
        redraw();
      } else if (event.key.toLowerCase() === "p") setTool("pen");
      else if (event.key.toLowerCase() === "e") setTool("eraser");
      else if (event.key.toLowerCase() === "v") setTool("select");
      else if (event.key.toLowerCase() === "h") setTool("hand");
      else if (event.key.toLowerCase() === "t") setTool("text");
      else if (event.key === "[") setWidth((value) => Math.max(1, value - 1));
      else if (event.key === "]") setWidth((value) => Math.min(18, value + 1));
      else if (event.key === "0") fitBoard();
      else if (event.key === "+" || event.key === "=") zoomBy(1.15);
      else if (event.key === "-") zoomBy(1 / 1.15);
      else if (event.key === "Escape") {
        setSelection(new Set());
        setRecognitionOpen(false);
        setPracticeOpen(false);
        setTrackpadOpen(false);
      } else if (event.key === "Delete" && selectionRef.current.size) {
        commitBoard({
          ...boardRef.current,
          strokes: boardRef.current.strokes.filter((stroke) => !selectionRef.current.has(stroke.id)),
          imageObjects: boardRef.current.imageObjects.filter((item) => !selectionRef.current.has(item.id)),
        });
        setSelection(new Set());
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      pressedKeys.current.delete(event.key);
      const action = keyboardPointerAction.current;
      const expectedKey = action === "draw" ? inputBindings.drawKey : action === "pan" ? inputBindings.panKey : action === "select" ? inputBindings.selectKey : null;
      if (!action || event.key !== expectedKey) return;
      if (action === "draw" && currentStroke.current) {
        const stroke = currentStroke.current;
        currentStroke.current = null;
        if (stroke.points.length > 1) commitBoard({ ...boardRef.current, strokes: [...boardRef.current.strokes, stroke] });
      } else if (action === "select" && selectionOrigin.current && canvasHover.current) {
        const start = selectionOrigin.current;
        const end = canvasHover.current.point;
        const bounds = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
        setSelection(selectedBoardIds(boardRef.current, bounds));
        setSelectionBox(null);
        selectionOrigin.current = null;
      }
      dragOrigin.current = null;
      keyboardPointerAction.current = null;
      redraw();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [color, commitBoard, fitBoard, inputBindings, redo, redraw, undo, width, zoomBy]);

  function handleWheel(event: React.WheelEvent<HTMLCanvasElement>) {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, viewRef.current.scale * Math.exp(-event.deltaY * 0.004));
  }

  function startPointer(event: React.PointerEvent<HTMLCanvasElement>) {
    if (keyboardPointerAction.current) return;
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    const button = event.button;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerPositions.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (button === 1) {
      dragOrigin.current = {
        point: { x: event.clientX, y: event.clientY, pressure: 0.5, time: Date.now() },
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
    if (tool === "pen") {
      currentStroke.current = {
        id: crypto.randomUUID(),
        color,
        width,
        pointerType: event.pointerType,
        points: [point],
      };
      setSelection(new Set());
      redraw();
    } else if (tool === "eraser") {
      eraseOrigin.current = cloneBoard(boardRef.current);
      eraseAt(point.x, point.y);
    } else if (tool === "select") {
      selectionOrigin.current = point;
      setSelectionBox({ x: point.x, y: point.y, width: 0, height: 0 });
    } else if (tool === "hand") {
      dragOrigin.current = { point: { ...point, x: event.clientX, y: event.clientY }, view: viewRef.current };
    } else {
      const existing = [...boardRef.current.textObjects].reverse().find((item) =>
        point.x >= item.x - 8 && point.x <= item.x + 280
        && point.y >= item.y - 8 && point.y <= item.y + Math.max(28, item.value.split("\n").length * 28),
      );
      const value = window.prompt(existing ? "Edit text" : "Text to add", existing?.value ?? "");
      if (value?.trim()) {
        commitBoard({
          ...boardRef.current,
          textObjects: existing
            ? boardRef.current.textObjects.map((item) => item.id === existing.id ? { ...item, value: value.trim() } : item)
            : [...boardRef.current.textObjects, {
              id: crypto.randomUUID(),
              x: point.x,
              y: point.y,
              value: value.trim(),
              color,
              kind: "text",
            }],
        });
      }
    }
  }

  function movePointer(event: React.PointerEvent<HTMLCanvasElement>) {
    const hoverPoint = boardPoint(event, viewRef.current);
    canvasHover.current = { clientX: event.clientX, clientY: event.clientY, point: hoverPoint };
    if (keyboardPointerAction.current) {
      if (keyboardPointerAction.current === "draw" && currentStroke.current) {
        currentStroke.current.points.push(hoverPoint);
        redraw();
      } else if (keyboardPointerAction.current === "select" && selectionOrigin.current) {
        const start = selectionOrigin.current;
        setSelectionBox({ x: Math.min(start.x, hoverPoint.x), y: Math.min(start.y, hoverPoint.y), width: Math.abs(hoverPoint.x - start.x), height: Math.abs(hoverPoint.y - start.y) });
      } else if (keyboardPointerAction.current === "pan" && dragOrigin.current) {
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
    if (currentStroke.current) {
      currentStroke.current.points.push(point);
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
    const remaining = boardRef.current.strokes.filter((stroke) => !pointHitsStroke(x, y, stroke, 10 / viewRef.current.scale));
    if (remaining.length !== boardRef.current.strokes.length) setBoard({ ...boardRef.current, strokes: remaining });
  }

  function endPointer(event: React.PointerEvent<HTMLCanvasElement>) {
    pointerPositions.current.delete(event.pointerId);
    if (pointerPositions.current.size < 2) pinchOrigin.current = null;

    if (currentStroke.current) {
      const stroke = currentStroke.current;
      currentStroke.current = null;
      commitBoard({ ...boardRef.current, strokes: [...boardRef.current.strokes, stroke] });
    } else if (eraseOrigin.current) {
      const original = eraseOrigin.current;
      eraseOrigin.current = null;
      if (original.strokes.length !== boardRef.current.strokes.length) {
        undoStack.current.push(original);
        redoStack.current = [];
        setBoard({ ...boardRef.current, updatedAt: new Date().toISOString() });
      }
    } else if (selectionOrigin.current) {
      const end = boardPoint(event, viewRef.current);
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

  function cancelPointer(event: React.PointerEvent<HTMLCanvasElement>) {
    pointerPositions.current.delete(event.pointerId);
    currentStroke.current = null;
    eraseOrigin.current = null;
    selectionOrigin.current = null;
    dragOrigin.current = null;
    setSelectionBox(null);
    redraw();
  }

  async function saveBoard(saveAs = false) {
    try {
      let path = filePath;
      if (saveAs || !path) {
        path = await save({ defaultPath: `${board.title || defaultBoardTitle()}.whiteboard.json`, filters: [{ name: "Whiteboard", extensions: ["json"] }] });
      }
      if (!path) return;
      const formatted = JSON.stringify(board, null, 2);
      fileWriteChain.current = fileWriteChain.current
        .catch(() => undefined)
        .then(() => writeTextFile(path, formatted));
      await fileWriteChain.current;
      setFilePath(path);
      setSaveState("saved");
    } catch (error) {
      setSaveState("error");
      window.alert(`Could not save the board: ${String(error)}`);
    }
  }

  async function openBoard() {
    if ((board.strokes.length || board.textObjects.length || board.imageObjects.length) && !window.confirm("Open another board? Save the current board first if you want to keep it.")) return;
    try {
      const path = await open({ multiple: false, filters: [{ name: "Whiteboard", extensions: ["json", "enc"] }] });
      if (!path) return;
      if (path.endsWith(".whiteboard.enc")) {
        setEncryptionRequest({ action: "open", path, encrypted: await readFile(path) });
        setEncryptionPassword("");
        setEncryptionConfirmation("");
        setEncryptionError("");
        return;
      }
      const next = parseBoard(await readTextFile(path));
      setBoard(next);
      setFilePath(path);
      setSelection(new Set());
      undoStack.current = [];
      redoStack.current = [];
      fitBoard();
    } catch (error) {
      window.alert(`Could not open the board: ${String(error)}`);
    }
  }

  async function saveEncryptedBoard() {
    try {
      const path = await save({ defaultPath: `${board.title || defaultBoardTitle()}.whiteboard.enc`, filters: [{ name: "Encrypted Whiteboard", extensions: ["enc"] }] });
      if (!path) return;
      setEncryptionRequest({ action: "save", path });
      setEncryptionPassword("");
      setEncryptionConfirmation("");
      setEncryptionError("");
    } catch (error) {
      window.alert(`Could not prepare the encrypted save: ${String(error)}`);
    }
  }

  async function insertImage() {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (!path || Array.isArray(path)) return;
      const bytes = await readFile(path);
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Choose an image smaller than 8 MB.");
      const extension = path.split(".").pop()?.toLowerCase();
      const mime = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
      const dataUrl = await bytesToDataUrl(bytes, mime);
      const dimensions = await imageDimensions(dataUrl);
      const ratio = Math.min(1, 640 / dimensions.width, 480 / dimensions.height);
      const imageWidth = Math.max(1, dimensions.width * ratio);
      const imageHeight = Math.max(1, dimensions.height * ratio);
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const centerX = ((rect?.width ?? 640) / 2 - viewRef.current.x) / viewRef.current.scale;
      const centerY = ((rect?.height ?? 480) / 2 - viewRef.current.y) / viewRef.current.scale;
      commitBoard({
        ...boardRef.current,
        imageObjects: [...boardRef.current.imageObjects, {
          id: crypto.randomUUID(),
          x: centerX - imageWidth / 2,
          y: centerY - imageHeight / 2,
          width: imageWidth,
          height: imageHeight,
          dataUrl,
        }],
      });
    } catch (error) {
      window.alert(`Could not insert the image: ${String(error)}`);
    }
  }

  function insertLatex() {
    const value = window.prompt("LaTeX to add", String.raw`\frac{a}{b}`)?.trim();
    if (!value) return;
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    commitBoard({
      ...boardRef.current,
      textObjects: [...boardRef.current.textObjects, {
        id: crypto.randomUUID(),
        x: ((rect?.width ?? 640) / 2 - viewRef.current.x) / viewRef.current.scale,
        y: ((rect?.height ?? 480) / 2 - viewRef.current.y) / viewRef.current.scale,
        value,
        color,
        kind: "latex",
      }],
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
        const encrypted = await invoke<number[]>("encrypt_board", { boardJson: JSON.stringify(board), password: encryptionPassword });
        await writeFile(encryptionRequest.path, new Uint8Array(encrypted));
      } else {
        const boardJson = await invoke<string>("decrypt_board", {
          encrypted: Array.from(encryptionRequest.encrypted ?? []),
          password: encryptionPassword,
        });
        setBoard(parseBoard(boardJson));
        setFilePath(null);
        setSelection(new Set());
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
    const dpr = window.devicePixelRatio || 1;
    context.fillStyle = board.theme === "white" ? "#fcfcfa" : "#121416";
    context.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    context.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    if (board.grid) {
      const rect = canvas.getBoundingClientRect();
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
    const bytes = new Uint8Array(await (await fetch(exportCanvas.toDataURL("image/png"))).arrayBuffer());
    try {
      const path = await save({ defaultPath: `${board.title || defaultBoardTitle()}.png`, filters: [{ name: "PNG image", extensions: ["png"] }] });
      if (path) await writeFile(path, bytes);
    } catch (error) {
      window.alert(`Could not export the image: ${String(error)}`);
    }
  }

  function newBoard() {
    if ((board.strokes.length || board.textObjects.length || board.imageObjects.length) && !window.confirm("Create a new board? Save the current board first if you want to keep it.")) return;
    setBoard(createBoard());
    setFilePath(null);
    setSelection(new Set());
    undoStack.current = [];
    redoStack.current = [];
    fitBoard();
  }

  async function openLibrary() {
    setLibraryOpen(true);
    setLibraryError("");
    setLibraryLoading(true);
    if (!isTauri()) {
      setLibraryError("The native Board Library is available in the installed Tauri app.");
      setLibraryLoading(false);
      return;
    }
    try {
      setLibraryBoards(await invoke<LibraryBoard[]>("list_library_boards"));
    } catch (error) {
      setLibraryError(String(error));
    } finally {
      setLibraryLoading(false);
    }
  }

  async function loadLibraryBoard(boardId: string) {
    try {
      const next = parseBoard(await invoke<string>("open_library_board", { boardId }));
      setBoard(next);
      setFilePath(null);
      setSelection(new Set());
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
    return renderSelectionImage(board.strokes.filter((stroke) => intersectsBounds(stroke, bounds)), board.theme, bounds);
  }

  async function runRecognition(mode: RecognitionMode, scope: RecognitionScope = recognitionScope) {
    const rendered = recognitionImage(scope);
    setRecognitionOpen(true);
    setRecognitionMode(mode);
    setRecognitionScope(scope);
    if (!rendered) {
      setRecognitionState("error");
      setRecognitionError(scope === "selection" ? "Select some ink first." : "There is no ink in this recognition area.");
      return;
    }
    setRecognitionState("loading");
    setRecognitionError("");
    try {
      const result = await recognizeInk(rendered.base64, mode, settings);
      setRecognitionResult(result);
      setRecognitionOriginal(result);
      setRecognitionState("result");
    } catch (error) {
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
    if (!recognitionResult.trim() || recognitionResult.trim() === recognitionOriginal.trim()) return;
    setSettings((current) => ({
      ...current,
      corrections: [
        ...current.corrections,
        {
          id: crypto.randomUUID(),
          mode: recognitionMode,
          original: recognitionOriginal.trim(),
          corrected: recognitionResult.trim(),
          createdAt: new Date().toISOString(),
        },
      ].slice(-100),
    }));
  }

  function addCalibrationSample() {
    const source = selectedStrokes.length ? selectedStrokes : [];
    const rendered = renderSelectionImage(source, board.theme);
    if (!rendered || !calibrationLabel.trim()) return;
    setSettings((current) => ({
      ...current,
      samples: [
        ...current.samples,
        {
          id: crypto.randomUUID(),
          label: calibrationLabel.trim(),
          image: rendered.base64,
          mode: calibrationMode,
          createdAt: new Date().toISOString(),
        },
      ].slice(-240),
    }));
    setCalibrationLabel("");
  }

  function practicePoint(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      time: Date.now(),
    };
  }

  function startPracticeStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || practicePointerId.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    practicePointerId.current = event.pointerId;
    currentPracticeStroke.current = {
      id: crypto.randomUUID(),
      color: "auto",
      width: 5,
      pointerType: event.pointerType,
      points: [practicePoint(event)],
    };
    redrawPractice();
  }

  function movePracticeStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (practicePointerId.current !== event.pointerId || !currentPracticeStroke.current) return;
    event.preventDefault();
    currentPracticeStroke.current.points.push(practicePoint(event));
    redrawPractice();
  }

  function endPracticeStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    if (practicePointerId.current !== event.pointerId || !currentPracticeStroke.current) return;
    const stroke = currentPracticeStroke.current;
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
    setSettings((current) => ({
      ...current,
      samples: [
        ...current.samples,
        {
          id: crypto.randomUUID(),
          label: practiceTargetLabel,
          image: rendered.base64,
          exercise: practiceSet.id,
          mode: (practiceSet.id === "math" ? "latex" : "text") as RecognitionMode,
          createdAt: new Date().toISOString(),
        },
      ].slice(-240),
    }));
    setPracticeStrokes([]);
    setPracticeIndex((current) => (current + 1) % practiceSet.targets.length);
    setPracticeMessage(`Saved ${practiceTarget}. Sample ${practiceCount(settings.samples, practiceSet.id, practiceTargetLabel) + 1} is now in your handwriting profile.`);
  }

  function canDiscardPracticeDraft() {
    return !practiceStrokes.length || window.confirm("Discard the handwriting currently in the practice pad?");
  }

  function setInputBinding(binding: keyof InputBindings, key: string) {
    if (!key) return;
    setInputBindings((current) => {
      const conflict = (Object.keys(current) as (keyof InputBindings)[]).find((candidate) => candidate !== binding && current[candidate] === key);
      return conflict
        ? { ...current, [binding]: key, [conflict]: current[binding] }
        : { ...current, [binding]: key };
    });
  }

  function mappedPadPoint(event: React.PointerEvent<HTMLDivElement>): Point | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const pad = event.currentTarget.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const normalizedX = Math.min(1, Math.max(0, (event.clientX - pad.left) / pad.width));
    const normalizedY = Math.min(1, Math.max(0, (event.clientY - pad.top) / pad.height));
    const screenX = normalizedX * canvasRect.width;
    const screenY = normalizedY * canvasRect.height;
    return {
      x: (screenX - viewRef.current.x) / viewRef.current.scale,
      y: (screenY - viewRef.current.y) / viewRef.current.scale,
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      time: Date.now(),
    };
  }

  function startMappedPad(event: React.PointerEvent<HTMLDivElement>) {
    if (trackpadHoverDraw && event.pointerType === "mouse") return;
    if (event.button !== 0 || mappedPointerId.current !== null || currentStroke.current) return;
    const point = mappedPadPoint(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    mappedPointerId.current = event.pointerId;
    currentStroke.current = {
      id: crypto.randomUUID(),
      color,
      width,
      pointerType: "trackpad-pad",
      points: [point],
    };
    redraw();
  }

  function moveMappedPad(event: React.PointerEvent<HTMLDivElement>) {
    if (trackpadHoverDraw && event.pointerType === "mouse" && event.buttons === 0) {
      const point = mappedPadPoint(event);
      if (!point) return;
      if (!currentStroke.current) {
        mappedPointerId.current = event.pointerId;
        currentStroke.current = {
          id: crypto.randomUUID(),
          color,
          width,
          pointerType: "trackpad-pad-hover",
          points: [point],
        };
      } else if (mappedPointerId.current === event.pointerId) {
        currentStroke.current.points.push(point);
      }
      redraw();
      return;
    }
    if (mappedPointerId.current !== event.pointerId || !currentStroke.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    const point = mappedPadPoint(event);
    if (!point) return;
    currentStroke.current.points.push(point);
    redraw();
  }

  function endMappedPad(event: React.PointerEvent<HTMLDivElement>) {
    if (mappedPointerId.current !== event.pointerId || !currentStroke.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const stroke = currentStroke.current;
    currentStroke.current = null;
    mappedPointerId.current = null;
    commitBoard({ ...boardRef.current, strokes: [...boardRef.current.strokes, stroke] });
  }

  function cancelMappedPad(event: React.PointerEvent<HTMLDivElement>) {
    if (mappedPointerId.current !== event.pointerId) return;
    currentStroke.current = null;
    mappedPointerId.current = null;
    redraw();
  }

  function endHoverMappedPad(event: React.PointerEvent<HTMLDivElement>) {
    if (!trackpadHoverDraw || mappedPointerId.current !== event.pointerId || !currentStroke.current) return;
    const stroke = currentStroke.current;
    currentStroke.current = null;
    mappedPointerId.current = null;
    if (stroke.points.length > 1) commitBoard({ ...boardRef.current, strokes: [...boardRef.current.strokes, stroke] });
    else redraw();
  }

  const latexPreview = useMemo(() => {
    if (recognitionMode !== "latex" || !recognitionResult.trim()) return "";
    return katex.renderToString(recognitionResult, { throwOnError: false, displayMode: true, trust: false });
  }, [recognitionMode, recognitionResult]);

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
          <IconButton label="Save board" onClick={() => saveBoard()}><FloppyDisk /></IconButton>
          <IconButton label="Save encrypted board" onClick={saveEncryptedBoard}><LockKey /></IconButton>
          <input
            className="board-title"
            aria-label="Board title"
            value={board.title}
            onChange={(event) => setBoard((current) => ({ ...current, title: event.target.value }))}
          />
        </div>

        <div className={`save-state save-${saveState}`} aria-live="polite">
          {saveState === "saved" ? "Saved locally" : saveState === "saving" ? "Saving..." : "Save failed"}
        </div>

        <div className="topbar-group">
          <IconButton
            label={board.grid ? "Hide grid" : "Show grid"}
            onClick={() => setBoard((current) => ({ ...current, grid: !current.grid }))}
            pressed={board.grid}
          ><GridFour /></IconButton>
          <IconButton
            label="Handwriting practice"
            onClick={() => {
              setPracticeOpen(true);
              setRecognitionOpen(false);
              setSettingsOpen(false);
              setTool("pen");
            }}
            pressed={practiceOpen}
          ><Student /></IconButton>
          <IconButton
            label="Trackpad Pad"
            onClick={() => setTrackpadOpen((current) => !current)}
            pressed={trackpadOpen}
          ><DeviceTablet /></IconButton>
          <button
            className="text-button"
            onClick={() => setBoard((current) => ({ ...current, theme: current.theme === "white" ? "black" : "white" }))}
          >
            <Chalkboard /> {board.theme === "white" ? "Blackboard" : "Whiteboard"}
          </button>
          <button className="primary-button" onClick={() => runRecognition("text")}>
            <MagicWand /> Recognize
          </button>
          <IconButton label="Insert image" onClick={insertImage}><ImageSquare /></IconButton>
          <IconButton label="Insert LaTeX" onClick={insertLatex}><FunctionIcon /></IconButton>
          <IconButton label="Export PNG" onClick={exportPng}><DownloadSimple /></IconButton>
          <IconButton label="Recognition settings" onClick={() => setSettingsOpen(true)}><GearSix /></IconButton>
        </div>
      </header>

      <section className="canvas-shell" aria-label="Drawing canvas">
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
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
          data-scale={view.scale}
          data-view-x={view.x}
          data-view-y={view.y}
          data-selected-count={selection.size}
          data-image-count={board.imageObjects.length}
          aria-label="Whiteboard. Left drag uses the current tool, middle drag pans, right drag selects, and the wheel zooms."
        />
        {board.textObjects.filter((item) => item.kind === "latex").map((item) => (
          <div
            key={item.id}
            className="latex-board-object"
            style={{
              left: item.x * view.scale + view.x,
              top: item.y * view.scale + view.y,
              color: inkColor(item.color, board.theme),
              transform: `scale(${view.scale})`,
            }}
            dangerouslySetInnerHTML={{ __html: katex.renderToString(item.value, { throwOnError: false, trust: false }) }}
          />
        ))}
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
        <div className="tool-group">
          <ToolButton tool="select" active={tool === "select"} label="Select (V)" onClick={setTool}><Selection /></ToolButton>
          <ToolButton tool="pen" active={tool === "pen"} label="Pen (P)" onClick={setTool}><PencilSimple /></ToolButton>
          <ToolButton tool="eraser" active={tool === "eraser"} label="Eraser (E)" onClick={setTool}><Eraser /></ToolButton>
          <ToolButton tool="hand" active={tool === "hand"} label="Pan (H)" onClick={setTool}><Hand /></ToolButton>
          <ToolButton tool="text" active={tool === "text"} label="Text (T)" onClick={setTool}><TextT /></ToolButton>
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
          <input type="range" min="1" max="18" value={width} onChange={(event) => setWidth(Number(event.target.value))} />
          <output>{width}</output>
        </label>
        <div className="dock-separator" />
        <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!undoStack.current.length}><ArrowCounterClockwise /></IconButton>
        <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!redoStack.current.length}><ArrowClockwise /></IconButton>
        <IconButton
          label="Clear board"
          onClick={() => {
            if (window.confirm("Clear every stroke, text object, and image?")) {
              commitBoard({ ...board, strokes: [], textObjects: [], imageObjects: [] });
              setSelection(new Set());
            }
          }}
          disabled={!board.strokes.length && !board.textObjects.length && !board.imageObjects.length}
        ><Trash /></IconButton>
      </nav>

      {recognitionOpen && (
        <aside className="side-panel recognition-panel" aria-label="Recognition results">
          <div className="panel-header">
            <div>
              <h2>Recognition</h2>
              <p>{recognitionScope === "visible" ? "Visible grid-aligned area" : recognitionScope === "selection" ? `${selectedStrokes.length} selected strokes` : "Entire board"}</p>
            </div>
            <IconButton label="Close recognition" onClick={() => setRecognitionOpen(false)}><X /></IconButton>
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
              {latexPreview && <div className="latex-preview" dangerouslySetInnerHTML={{ __html: latexPreview }} />}
              <label htmlFor="recognition-result">Editable result</label>
              <textarea id="recognition-result" value={recognitionResult} onChange={(event) => setRecognitionResult(event.target.value)} rows={8} />
              <div className="panel-actions">
                <button className="primary-button" onClick={insertRecognition}>Insert below ink</button>
                <button className="text-button" onClick={() => navigator.clipboard.writeText(recognitionResult)}>Copy</button>
                <button className="text-button" onClick={rememberCorrection} disabled={recognitionResult.trim() === recognitionOriginal.trim()}>Remember edit</button>
              </div>
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
          <p className="practice-hint">Use as many strokes as needed, then save. Repeat targets to provide more examples.</p>
          <div className="practice-actions">
            <button
              className="text-button"
              onClick={() => {
                if (!canDiscardPracticeDraft()) return;
                setPracticeIndex((current) => (current - 1 + practiceSet.targets.length) % practiceSet.targets.length);
                setPracticeStrokes([]);
                setPracticeMessage("");
              }}
            >Previous</button>
            <button className="primary-button" onClick={savePracticeSample} disabled={!practiceReady}>Save sample and next</button>
            <button
              className="text-button"
              onClick={() => {
                if (!canDiscardPracticeDraft()) return;
                setPracticeIndex((current) => (current + 1) % practiceSet.targets.length);
                setPracticeStrokes([]);
                setPracticeMessage("");
              }}
            >Skip</button>
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

      {trackpadOpen && (
        <section className="trackpad-shell" aria-label="Trackpad Pad">
          <div className="trackpad-header">
            <div>
              <strong>Trackpad Pad</strong>
              <span>{trackpadHoverDraw ? "Move inside the pad to write; leave the pad to finish the stroke." : "Press and drag. Position maps edge-to-edge onto the visible board."}</span>
            </div>
            <IconButton label="Close Trackpad Pad" onClick={() => setTrackpadOpen(false)}><X /></IconButton>
          </div>
          <button
            className={`trackpad-mode-toggle ${trackpadHoverDraw ? "active" : ""}`}
            aria-pressed={trackpadHoverDraw}
            onClick={() => setTrackpadHoverDraw((current) => !current)}
          >Click-free writing</button>
          <div
            className="trackpad-pad"
            role="application"
            aria-label="Mapped writing pad"
            onPointerDown={startMappedPad}
            onPointerMove={moveMappedPad}
            onPointerUp={endMappedPad}
            onPointerCancel={cancelMappedPad}
            onPointerLeave={endHoverMappedPad}
            onContextMenu={(event) => event.preventDefault()}
          >
            <span>Mapped writing area</span>
          </div>
        </section>
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
            {libraryLoading && (
              <div className="library-skeleton" aria-label="Loading boards">
                {[0, 1, 2].map((item) => <div key={item}><span /><span /></div>)}
              </div>
            )}
            {!libraryLoading && !libraryError && !libraryBoards.length && <div className="library-empty">No saved boards yet.</div>}
            <div className="library-list">
              {libraryBoards.map((item) => (
                <button key={item.id} onClick={() => loadLibraryBoard(item.id)}>
                  <strong>{item.title}</strong>
                  <span>{new Date(item.updatedAt).toLocaleString()}</span>
                </button>
              ))}
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
              <p>Osu-style controls: hold a bound key while moving the cursor over the canvas. The key itself acts as the mouse button.</p>
              <div className="binding-grid">
                <label className="field">
                  <span>Draw key</span>
                  <input
                    readOnly
                    value={keyLabel(inputBindings.drawKey)}
                    onKeyDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setInputBinding("drawKey", event.key);
                    }}
                    aria-label="Draw action key"
                  />
                </label>
                <label className="field">
                  <span>Pan key</span>
                  <input
                    readOnly
                    value={keyLabel(inputBindings.panKey)}
                    onKeyDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setInputBinding("panKey", event.key);
                    }}
                    aria-label="Pan action key"
                  />
                </label>
                <label className="field">
                  <span>Select key</span>
                  <input
                    readOnly
                    value={keyLabel(inputBindings.selectKey)}
                    onKeyDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setInputBinding("selectKey", event.key);
                    }}
                    aria-label="Select action key"
                  />
                </label>
              </div>
              <p className="fine-print">Focus a field and press the key you want. Duplicate bindings are swapped automatically.</p>
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
