/** Owner-visible serving profiles. These are concrete requests/tunings rather
 * than model marketing claims: actual usable context is still bounded by the
 * model metadata and the host's verified context profile. */
export type LalRuntimeProfile = {
  id: "responsive" | "balanced" | "deep-context";
  name: string;
  settings: { contextTokens: number; maxOutputTokens: number };
  description: string;
  tradeoff: string;
};

export const LAL_RUNTIME_PROFILES: readonly LalRuntimeProfile[] = [
  { id: "responsive", name: "Responsive", settings: { contextTokens: 32_768, maxOutputTokens: 8_192 }, description: "Fastest load and decode for ordinary chat, code, and short research.", tradeoff: "Less retained history." },
  { id: "balanced", name: "Balanced", settings: { contextTokens: 65_536, maxOutputTokens: 16_384 }, description: "A larger working set while retaining the compact Vulkan KV cache profile.", tradeoff: "More VRAM pressure and slower prefill." },
  { id: "deep-context", name: "Deep context · 100K", settings: { contextTokens: 102_400, maxOutputTokens: 16_384 }, description: "The preferred long-context profile for large projects, evidence bundles, and extended research.", tradeoff: "Cold 100K prefill takes minutes; decode is slower than shorter profiles." },
] as const;

export function runtimeProfileForContext(contextTokens: number | null | undefined): LalRuntimeProfile {
  const context = contextTokens ?? 0;
  if (context > 65_536) return LAL_RUNTIME_PROFILES[2];
  if (context > 32_768) return LAL_RUNTIME_PROFILES[1];
  return LAL_RUNTIME_PROFILES[0];
}

/** The long profile is deliberately conservative on AMD/Vulkan: short batches
 * avoid watchdog resets, q8 KV preserves 100K capacity, and prefix reuse keeps
 * repeated system/project context from being prefetched unnecessarily. */
export function llamaServerContextArgs(contextTokens: number, gpuLayers: number): string[] {
  if (contextTokens > 32_768 && gpuLayers > 0) {
    return ["-b", "256", "-ub", "256", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--cache-prompt", "--cache-reuse", "256"];
  }
  return ["-b", "512", "-ub", "512", "--cache-prompt"];
}
