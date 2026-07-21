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
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load a handwriting sample."));
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
  const loaded = await Promise.allSettled(selected.map(async (sample) => ({ sample, image: await imageFromBase64(sample.image) })));
  const valid = loaded.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!valid.length) return null;
  const columns = 8;
  const cellWidth = 140;
  const cellHeight = 100;
  const rows = Math.ceil(valid.length / columns);
  const canvas = document.createElement("canvas");
  canvas.width = columns * cellWidth;
  canvas.height = rows * cellHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#fcfcfa";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "600 14px system-ui, sans-serif";
  context.textBaseline = "top";

  valid.forEach(({ sample, image }, index) => {
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
  });

  return canvas.toDataURL("image/png").split(",")[1];
}
