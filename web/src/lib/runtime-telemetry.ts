import fs from "node:fs";
import path from "node:path";

/**
 * A deliberately small, vendor-neutral runtime observation record.  The same
 * shape will later carry observability from the Guardian's endpoint adapters;
 * it is not a claim that every engine exposes every counter.
 */
export type RuntimeTelemetry = {
  observedAt: number;
  state: "not-running" | "ready" | "unavailable";
  metricsAvailable: boolean;
  slotsAvailable: boolean;
  promptTokensPerSecond: number | null;
  predictedTokensPerSecond: number | null;
  kvCacheUsagePct: number | null;
  busySlots: number | null;
  totalSlots: number | null;
  deferredTokens: number | null;
  processingTokens: number | null;
  slots: RuntimeSlotTelemetry[];
  error: string | null;
};

export type RuntimeSlotTelemetry = {
  id: number;
  processing: boolean;
  contextTokens: number | null;
  cachedTokens: number | null;
  promptTokens: number | null;
  decodedTokens: number | null;
  truncated: boolean | null;
};

type MetricSample = { name: string; labels: Record<string, string>; value: number };

export function parsePrometheusMetrics(body: string): MetricSample[] {
  const out: MetricSample[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|NaN|[+-]Inf)$/);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    for (const label of (match[2] || "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g)) {
      labels[label[1]] = label[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out.push({ name: match[1], labels, value });
  }
  return out;
}

function metric(samples: MetricSample[], names: string[], label?: [string, string]): number | null {
  const found = samples.find((sample) => names.includes(sample.name) && (!label || sample.labels[label[0]] === label[1]));
  return found?.value ?? null;
}

function ratioToPct(value: number | null): number | null {
  if (value == null) return null;
  return Math.round((value <= 1 ? value * 100 : value) * 10) / 10;
}

export function summarizeLlamaMetrics(body: string): Omit<RuntimeTelemetry, "observedAt" | "state" | "slotsAvailable" | "slots" | "error"> {
  const samples = parsePrometheusMetrics(body);
  // llama.cpp metric names have changed across releases. Keep the aliases
  // explicit and return null rather than inventing a number when a build has
  // a different surface.
  const prompt = metric(samples, ["llamacpp:prompt_tokens_per_second", "llamacpp:prompt_tokens_seconds"])
    ?? metric(samples, ["llamacpp:tokens_per_second"], ["type", "prompt"]);
  const predicted = metric(samples, ["llamacpp:predicted_tokens_per_second", "llamacpp:predicted_tokens_seconds"])
    ?? metric(samples, ["llamacpp:tokens_per_second"], ["type", "predicted"]);
  return {
    metricsAvailable: samples.length > 0,
    promptTokensPerSecond: prompt,
    predictedTokensPerSecond: predicted,
    kvCacheUsagePct: ratioToPct(metric(samples, ["llamacpp:kv_cache_usage_ratio", "llamacpp:kv_cache_usage"])),
    busySlots: metric(samples, ["llamacpp:requests_processing", "llamacpp:slots_processing", "llamacpp:n_busy_slots_per_decode"]),
    totalSlots: metric(samples, ["llamacpp:slots_total", "llamacpp:n_slots"]),
    deferredTokens: metric(samples, ["llamacpp:tokens_deferred", "llamacpp:tokens_deferred_total"]),
    processingTokens: metric(samples, ["llamacpp:tokens_processing", "llamacpp:tokens_processing_total"]),
  };
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseLlamaSlots(body: unknown): RuntimeSlotTelemetry[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((item): RuntimeSlotTelemetry[] => {
    if (!item || typeof item !== "object") return [];
    const slot = item as Record<string, unknown>;
    const id = number(slot.id);
    if (id == null) return [];
    const params = slot.params && typeof slot.params === "object" ? slot.params as Record<string, unknown> : {};
    return [{
      id,
      processing: slot.is_processing === true,
      contextTokens: number(slot.n_ctx) ?? number(params.n_ctx),
      cachedTokens: number(slot.n_prompt_tokens_cache) ?? number(slot.n_cache_tokens),
      promptTokens: number(slot.n_prompt_tokens_processed) ?? number(slot.n_past),
      decodedTokens: number(slot.n_decoded),
      truncated: typeof slot.truncated === "boolean" ? slot.truncated : null,
    }];
  });
}

type FetchResponse = { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
export type RuntimeTelemetryFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponse>;

export async function readLlamaRuntimeTelemetry(baseUrl: string, running: boolean, fetchImpl: RuntimeTelemetryFetch = fetch): Promise<RuntimeTelemetry> {
  const observedAt = Date.now();
  const empty = (state: RuntimeTelemetry["state"], error: string | null): RuntimeTelemetry => ({
    observedAt, state, metricsAvailable: false, slotsAvailable: false,
    promptTokensPerSecond: null, predictedTokensPerSecond: null, kvCacheUsagePct: null,
    busySlots: null, totalSlots: null, deferredTokens: null, processingTokens: null, slots: [], error,
  });
  if (!running) return empty("not-running", null);

  const init = { signal: AbortSignal.timeout(1_500) };
  const [metricsResult, slotsResult] = await Promise.allSettled([
    fetchImpl(`${baseUrl}/metrics`, init),
    fetchImpl(`${baseUrl}/slots`, init),
  ]);
  if (metricsResult.status !== "fulfilled" || !metricsResult.value.ok) {
    const detail = metricsResult.status === "fulfilled" ? `metrics HTTP ${metricsResult.value.status}` : "metrics request failed";
    return empty("unavailable", detail);
  }
  const metrics = summarizeLlamaMetrics(await metricsResult.value.text());
  if (!metrics.metricsAvailable) return empty("unavailable", "metrics endpoint returned no Prometheus samples");

  let slots: RuntimeSlotTelemetry[] = [];
  let slotsAvailable = false;
  let error: string | null = null;
  if (slotsResult.status === "fulfilled" && slotsResult.value.ok) {
    slots = parseLlamaSlots(await slotsResult.value.json());
    slotsAvailable = true;
  } else {
    error = slotsResult.status === "fulfilled" ? `slots HTTP ${slotsResult.value.status}` : "slots request failed";
  }
  return { observedAt, state: "ready", ...metrics, slotsAvailable, slots, error };
}

/** Bounded, local-only history for later timeline and anomaly work. */
export class RuntimeTelemetryJournal {
  private lastAt = 0;
  private readonly file: string;
  private readonly minIntervalMs: number;
  private readonly maxBytes: number;

  constructor(file: string, minIntervalMs = 10_000, maxBytes = 1024 * 1024) {
    this.file = file;
    this.minIntervalMs = minIntervalMs;
    this.maxBytes = maxBytes;
  }

  append(sample: RuntimeTelemetry): void {
    if (sample.observedAt - this.lastAt < this.minIntervalMs) return;
    this.lastAt = sample.observedAt;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(sample) + "\n", { mode: 0o600 });
      if (fs.statSync(this.file).size > this.maxBytes) {
        const tail = fs.readFileSync(this.file, "utf8").trim().split("\n").slice(-1_000).join("\n");
        fs.writeFileSync(this.file, tail ? tail + "\n" : "", { mode: 0o600 });
      }
    } catch { /* observation must never make serving unavailable */ }
  }
}
