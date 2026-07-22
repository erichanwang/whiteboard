import type { CalibrationSample } from "./types";

export interface PracticeSet {
  id: string;
  name: string;
  description: string;
  targets: string[];
  labels?: Record<string, string>;
}

export const PRACTICE_SETS: PracticeSet[] = [
  {
    id: "lowercase",
    name: "Lowercase alphabet",
    description: "Write each lowercase letter on its own.",
    targets: [..."abcdefghijklmnopqrstuvwxyz"],
  },
  {
    id: "uppercase",
    name: "Uppercase alphabet",
    description: "Write each capital letter on its own.",
    targets: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
  },
  {
    id: "digits",
    name: "Numbers 0-9",
    description: "Write each digit on its own.",
    targets: [..."0123456789"],
  },
  {
    id: "words",
    name: "Common words",
    description: "Practice connected letters and common joins.",
    targets: ["the", "and", "with", "from", "this", "ing", "tion", "Eric"],
  },
  {
    id: "punctuation",
    name: "Punctuation",
    description: "Practice marks that recognition often confuses.",
    targets: [".", ",", "?", "!", ":", ";", "'", "\"", "(", ")"],
  },
  {
    id: "math",
    name: "Math symbols",
    description: "Practice operators and common handwritten notation.",
    targets: ["+", "-", "=", "x", "/", "<", ">", "π", "θ", "√", "Σ"],
    labels: {
      "π": "\\pi",
      "θ": "\\theta",
      "√": "\\sqrt{}",
      "Σ": "\\sum",
    },
  },
];

export function practiceLabel(set: PracticeSet, target: string) {
  return set.labels?.[target] ?? target;
}

export function practiceCount(samples: CalibrationSample[], exercise: string, label: string) {
  return samples.filter((sample) => sample.exercise === exercise && sample.label === label).length;
}

function imageFromBase64(base64: string) {
  try {
    const header = atob(base64.slice(0, 32));
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (header.length < 24 || !signature.every((value, index) => header.charCodeAt(index) === value)
      || header.slice(12, 16) !== "IHDR") throw new Error("Invalid PNG header");
    const dimension = (offset: number) => header.charCodeAt(offset) * 0x1000000
      + header.charCodeAt(offset + 1) * 0x10000
      + header.charCodeAt(offset + 2) * 0x100
      + header.charCodeAt(offset + 3);
    const width = dimension(16);
    const height = dimension(20);
    if (width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > 4_194_304) {
      throw new Error("Handwriting sample dimensions are too large");
    }
  } catch {
    return Promise.reject(new Error("Could not load a handwriting sample."));
  }
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      resolve(image);
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      reject(new Error("Could not load a handwriting sample."));
    };
    image.src = `data:image/png;base64,${base64}`;
  });
}

export async function buildProfileSheet(samples: CalibrationSample[]): Promise<string | null> {
  if (!samples.length) return null;
  const latestByLabel = new Map<string, CalibrationSample>();
  for (const sample of samples) latestByLabel.set(`${sample.exercise ?? "manual"}:${sample.label}`, sample);
  const balanced = [...latestByLabel.values()];
  const guided = balanced.filter((sample) => sample.exercise !== "feedback").slice(-90);
  const feedback = balanced.filter((sample) => sample.exercise === "feedback").slice(-30);
  const prioritized = [...guided, ...feedback];
  const selectedIds = new Set(prioritized.map((sample) => sample.id));
  const remaining = Math.max(0, 120 - prioritized.length);
  const repeats = remaining ? samples.filter((sample) => !selectedIds.has(sample.id)).slice(-remaining) : [];
  const selected = [...prioritized, ...repeats].slice(-120);
  const columns = 8;
  const cellWidth = 140;
  const cellHeight = 100;
  const canvas = document.createElement("canvas");
  canvas.width = columns * cellWidth;
  canvas.height = Math.ceil(selected.length / columns) * cellHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#fcfcfa";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "600 14px system-ui, sans-serif";
  context.textBaseline = "top";

  let output: HTMLCanvasElement | null = null;
  try {
    let validCount = 0;
    for (const sample of selected) {
      let image: HTMLImageElement;
      try {
        image = await imageFromBase64(sample.image);
      } catch {
        continue;
      }
      const index = validCount;
      validCount += 1;
      try {
      const x = (index % columns) * cellWidth;
      const y = Math.floor(index / columns) * cellHeight;
      context.strokeStyle = "#d7dad5";
      context.strokeRect(x + 4, y + 4, cellWidth - 8, cellHeight - 8);
      context.fillStyle = "#202328";
      context.fillText(sample.label, x + 10, y + 9, cellWidth - 20);
      const availableWidth = cellWidth - 20;
      const availableHeight = cellHeight - 38;
      const scale = Math.min(availableWidth / image.width, availableHeight / image.height);
      const drawWidth = image.width * scale;
      const drawHeight = image.height * scale;
      context.drawImage(image, x + (cellWidth - drawWidth) / 2, y + 30 + (availableHeight - drawHeight) / 2, drawWidth, drawHeight);
      } finally {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
      }
    }

    if (!validCount) return null;
    const outputHeight = Math.ceil(validCount / columns) * cellHeight;
    if (outputHeight === canvas.height) return canvas.toDataURL("image/png").split(",")[1];
    output = document.createElement("canvas");
    output.width = canvas.width;
    output.height = outputHeight;
    const outputContext = output.getContext("2d");
    if (!outputContext) return null;
    outputContext.fillStyle = "#fcfcfa";
    outputContext.fillRect(0, 0, output.width, output.height);
    outputContext.drawImage(canvas, 0, 0);

    return output.toDataURL("image/png").split(",")[1];
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    if (output) {
      output.width = 0;
      output.height = 0;
    }
  }
}
