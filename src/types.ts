export type BoardTheme = "white" | "black";
export type Tool = "pen" | "eraser" | "select" | "hand" | "text";
export type RecognitionMode = "text" | "latex";

export interface Point {
  x: number;
  y: number;
  pressure: number;
}

export interface Stroke {
  id: string;
  color: string;
  width: number;
  pointerType: string;
  points: Point[];
}

export interface TextObject {
  id: string;
  x: number;
  y: number;
  value: string;
  color: string;
  kind: RecognitionMode;
  fontSize?: number;
}

export interface ImageObject {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  dataUrl: string;
}

export interface BoardDocument {
  version: 1;
  id: string;
  title: string;
  theme: BoardTheme;
  grid: boolean;
  strokes: Stroke[];
  textObjects: TextObject[];
  imageObjects: ImageObject[];
  updatedAt: string;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CalibrationSample {
  id: string;
  label: string;
  image: string;
  exercise?: string;
  mode?: RecognitionMode;
  createdAt: string;
}

export interface Correction {
  id: string;
  mode: RecognitionMode;
  original: string;
  corrected: string;
  createdAt: string;
}

export interface RecognitionSettings {
  provider: "nvidia";
  model: string;
  samples: CalibrationSample[];
  corrections: Correction[];
  handwritingFontEnabled: boolean;
}
