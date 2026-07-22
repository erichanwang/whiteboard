import { invoke } from "@tauri-apps/api/core";
import { buildProfileSheet } from "./practice";
import type { RecognitionMode, RecognitionSettings } from "./types";

const profileSheetCache = new WeakMap<
  RecognitionSettings["samples"],
  Map<RecognitionMode, Promise<string | null>>
>();

export function profileSheetForRecognition(
  samples: RecognitionSettings["samples"],
  mode: RecognitionMode,
): Promise<string | null> {
  let byMode = profileSheetCache.get(samples);
  const cached = byMode?.get(mode);
  if (cached) return cached;

  const profileSamples = samples.filter((sample) => {
    if (mode === "text") return sample.mode !== "latex";
    return sample.mode === "latex" || ["digits", "punctuation", "lowercase", "uppercase"].includes(sample.exercise ?? "");
  });
  const pending = buildProfileSheet(profileSamples);
  if (!byMode) {
    byMode = new Map();
    profileSheetCache.set(samples, byMode);
  }
  byMode.set(mode, pending);
  pending.catch(() => {
    if (byMode?.get(mode) !== pending) return;
    byMode.delete(mode);
    if (!byMode.size) profileSheetCache.delete(samples);
  });
  return pending;
}

export async function listNvidiaModels(): Promise<string[]> {
  return invoke<string[]>("list_nvidia_models");
}

export async function recognizeInk(
  image: string,
  mode: RecognitionMode,
  settings: RecognitionSettings,
): Promise<string> {
  const corrections = settings.corrections
    .filter((correction) => correction.mode === mode)
    .slice(-12)
    .map((correction) => `${correction.original} -> ${correction.corrected}`);
  const profileImage = await profileSheetForRecognition(settings.samples, mode);

  const result = await invoke<string>("recognize_with_nvidia", {
    image,
    mode,
    model: settings.model,
    corrections,
    profileImage,
  });

  return result.replace(/^```(?:latex)?\s*/i, "").replace(/\s*```$/, "").trim();
}
