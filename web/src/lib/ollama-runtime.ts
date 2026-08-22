export type OllamaRuntime = { context: number; offload: string };
export type OllamaPsPayload = { models?: Array<{ name?: string; context_length?: number; size?: number; size_vram?: number }> };

/** Interpret Ollama's local resident-model response. Kept dependency-free so
 * the hot-path decision can be directly tested outside the web runtime. */
export function ollamaRuntimeFromPs(payload: OllamaPsPayload, model: string, fallbackContext: number): OllamaRuntime | null {
  const runtime = payload.models?.find((item) => item.name === model || item.name?.startsWith(`${model}:`));
  if (!runtime) return null;
  const context = runtime.context_length ?? 0;
  const size = runtime.size ?? 0;
  const sizeVram = runtime.size_vram ?? 0;
  return { context: context || fallbackContext, offload: sizeVram > 0 ? `gpu:${Math.round((sizeVram / Math.max(1, size)) * 100)}%` : "cpu" };
}
