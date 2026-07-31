import fs from "node:fs";
import path from "node:path";
import { allModels, getSuite, runBench, saveBench } from "./lab";

export const COMPARISON_SUITE_IDS = ["coding", "planning", "research", "agentic", "instruct", "webgen"] as const;
export const MODEL_ACQUISITION_BUDGET_GB = 30;
export const SELECTED_MODEL_CANDIDATES = [
  "qwen3:1.7b",
  "qwen3.5:9b",
  "gemma4:12b",
  "openvino/qwen3-8b-npu",
  "Qwen3-Coder-30B-A3B-Instruct",
  "gpt-oss:20b",
  "mistral-small3.1:24b",
] as const;

type QueueItem = { model: string; suite: string; status: "queued" | "running" | "completed" | "failed"; error?: string };
export type ComparisonState = {
  id: string;
  status: "ready" | "running" | "completed" | "failed";
  models: string[];
  missingModels: string[];
  acquisitionBudgetGb: number;
  suites: string[];
  queue: QueueItem[];
  startedAt?: number;
  completedAt?: number;
  analysis?: { model: string; passed: number; total: number; qualityPct: number; tokSec: number | null; latencyMs: number | null; note: string }[];
};

const DATA = path.resolve(process.cwd(), "..", "data");
const STATE_FILE = path.join(DATA, "model-comparison.json");
let running = false;

function write(state: ComparisonState) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function read(): ComparisonState | null {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as ComparisonState; } catch { return null; }
}

function template(): ComparisonState {
  const installed = new Set(allModels().map((model) => model.name));
  const models = SELECTED_MODEL_CANDIDATES.filter((model) => installed.has(model));
  return {
    id: "local-model-comparison",
    status: "ready",
    models,
    missingModels: SELECTED_MODEL_CANDIDATES.filter((model) => !installed.has(model)),
    acquisitionBudgetGb: MODEL_ACQUISITION_BUDGET_GB,
    suites: [...COMPARISON_SUITE_IDS],
    queue: models.flatMap((model) => COMPARISON_SUITE_IDS.map((suite) => ({ model, suite, status: "queued" as const }))),
  };
}

export function comparisonState(): ComparisonState {
  const state = read() ?? template();
  // A development-server restart cannot keep an in-process job alive. Preserve the
  // planned matrix but put an interrupted row back in the queue instead of claiming
  // that work is still running.
  if (state.status === "running" && !running) {
    state.status = "ready";
    for (const item of state.queue) if (item.status === "running") item.status = "queued";
  }
  const installed = new Set(allModels().map((model) => model.name));
  state.models = state.models.filter((model) => installed.has(model));
  state.queue = state.queue.filter((item) => installed.has(item.model));
  state.missingModels = SELECTED_MODEL_CANDIDATES.filter((model) => !installed.has(model));
  state.acquisitionBudgetGb = MODEL_ACQUISITION_BUDGET_GB;
  write(state);
  return state;
}

function analyse(state: ComparisonState, results: Array<{ model: string; score: number; total: number; tokSec: number | null; latencyMs: number | null }>) {
  state.analysis = state.models.map((model) => {
    const runs = results.filter((result) => result.model === model);
    const passed = runs.reduce((sum, result) => sum + result.score, 0);
    const total = runs.reduce((sum, result) => sum + result.total, 0);
    const speed = runs.map((result) => result.tokSec).filter((value): value is number => value !== null);
    const latency = runs.map((result) => result.latencyMs).filter((value): value is number => value !== null);
    const qualityPct = total ? Math.round((passed / total) * 1000) / 10 : 0;
    const tokSec = speed.length ? Math.round((speed.reduce((sum, value) => sum + value, 0) / speed.length) * 10) / 10 : null;
    const latencyMs = latency.length ? Math.round(latency.reduce((sum, value) => sum + value, 0) / latency.length) : null;
    return { model, passed, total, qualityPct, tokSec, latencyMs, note: `${qualityPct}% across ${runs.length}/${state.suites.length} completed suites` };
  }).sort((a, b) => b.qualityPct - a.qualityPct || (b.tokSec ?? 0) - (a.tokSec ?? 0));
}

async function execute(state: ComparisonState) {
  const completed: Array<{ model: string; score: number; total: number; tokSec: number | null; latencyMs: number | null }> = [];
  try {
    for (const item of state.queue) {
      if (item.status !== "queued") continue;
      item.status = "running"; write(state);
      const suite = getSuite(item.suite);
      if (!suite?.items.length) {
        item.status = "failed"; item.error = "benchmark suite is unavailable"; write(state); continue;
      }
      try {
        const result = await runBench(item.model, suite.items, { grade: suite.grade, maxTokens: suite.maxTokens, think: suite.think });
        saveBench(item.suite, result);
        completed.push(result);
        item.status = "completed";
      } catch (error) {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : String(error);
      }
      write(state);
    }
    analyse(state, completed);
    state.status = "completed";
    state.completedAt = Date.now();
    write(state);
  } catch {
    state.status = "failed";
    state.completedAt = Date.now();
    write(state);
  } finally { running = false; }
}

export function prepareComparison(): ComparisonState {
  const state = template();
  write(state);
  return comparisonState();
}

export function startComparison(): ComparisonState {
  const state = comparisonState();
  if (running || state.status === "running") return state;
  state.status = "running";
  state.startedAt = Date.now();
  state.completedAt = undefined;
  state.analysis = undefined;
  for (const item of state.queue) if (item.status === "failed" || item.status === "completed") item.status = "queued";
  write(state);
  running = true;
  void execute(state);
  return state;
}
