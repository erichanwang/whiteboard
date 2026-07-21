import { invoke } from "@tauri-apps/api/core";
import { buildProfileSheet } from "./practice";
import type { RecognitionMode, RecognitionSettings } from "./types";

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
  const profileSamples = settings.samples.filter((sample) => {
    if (mode === "text") return sample.mode !== "latex";
    return sample.mode === "latex" || ["digits", "punctuation", "lowercase", "uppercase"].includes(sample.exercise ?? "");
  });
  const profileImage = await buildProfileSheet(profileSamples);

  const result = await invoke<string>("recognize_with_nvidia", {
    image,
    mode,
    model: settings.model,
    corrections,
    profileImage,
  });

  return result.replace(/^```(?:latex)?\s*/i, "").replace(/\s*```$/, "").trim();
}
