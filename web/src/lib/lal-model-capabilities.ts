/** Capabilities LAL knows from the locally managed Ollama artifacts. */
export function isNativeGemma4VisionModel(model: string): boolean {
  return /^gemma4:(?:12b|12b-lal-cli-ctx|e2b|e4b)$/i.test(model.trim());
}

/** Documented Gemma 4 sampler, used only when no per-model override exists. */
export function recommendedGemma4Sampling(model: string): {
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
} | null {
  if (!/^gemma4(?:[-:]|$)/i.test(model.trim())) return null;
  return { temperature: 1, topP: 0.95, topK: 64, repeatPenalty: 1.1 };
}
