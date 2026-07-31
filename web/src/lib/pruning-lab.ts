import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = path.resolve(process.cwd(), "..");
const PYTHON = path.join(ROOT, ".local-windows", "pruning-env", "Scripts", "python.exe");
const SCRIPT = path.join(ROOT, "scripts", "reap_code_experts.py");
const DATA_DIR = path.join(ROOT, "data");
const STATE_DIR = path.join(process.cwd(), ".data", "pruning");
const OUTPUT_DIR = path.join(ROOT, ".local-windows", "pruning-experiments");
const STATE_FILE = path.join(STATE_DIR, "experiments.json");

export const PRUNING_MODELS = [
  { id: "Qwen/Qwen3-30B-A3B-Instruct-2507", label: "Qwen3 30B-A3B", parametersB: 30.5, activeB: 3.3, experts: 128, activeExperts: 8, supported: true },
  { id: "Qwen/Qwen3-Coder-Next", label: "Qwen3-Coder-Next 80B-A3B", parametersB: 80, activeB: 3, experts: 512, activeExperts: 10, supported: true },
] as const;

export type PruningExperiment = {
  id: string;
  name: string;
  model: string;
  prunePercent: number;
  noisePercent: number;
  seed: number;
  samples: number;
  maxSequenceLength: number;
  calibrationFile: string;
  status: "planned" | "running" | "done" | "failed" | "stopped";
  createdAt: number;
  updatedAt: number;
  outputPath: string;
  logPath: string;
  pid?: number;
  error?: string;
  retainedExperts: number;
  estimatedParametersB: number;
  estimatedBf16GiB: number;
  estimatedQ4GiB: number;
};

type RuntimeState = { proc: ChildProcess | null; experimentId: string | null };
const globalState = globalThis as unknown as { __lalPruning?: RuntimeState };
if (!globalState.__lalPruning) globalState.__lalPruning = { proc: null, experimentId: null };
const runtime = globalState.__lalPruning;

function readExperiments(): PruningExperiment[] {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeExperiments(experiments: PruningExperiment[]): void {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(experiments, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, STATE_FILE);
}

function updateExperiment(id: string, patch: Partial<PruningExperiment>): PruningExperiment | null {
  const experiments = readExperiments();
  const index = experiments.findIndex((item) => item.id === id);
  if (index < 0) return null;
  experiments[index] = { ...experiments[index], ...patch, updatedAt: Date.now() };
  writeExperiments(experiments);
  return experiments[index];
}

export function pruningDatasets(): string[] {
  try {
    return fs.readdirSync(DATA_DIR).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

export function pruningRuntimeStatus() {
  return {
    available: fs.existsSync(PYTHON) && fs.existsSync(SCRIPT),
    python: PYTHON,
    activeExperimentId: runtime.proc && runtime.proc.exitCode === null ? runtime.experimentId : null,
  };
}

export function pruningPlan(input: Record<string, unknown>): PruningExperiment {
  const model = PRUNING_MODELS.find((item) => item.id === String(input.model)) ?? PRUNING_MODELS[0];
  const prunePercent = Math.min(90, Math.max(0, Number(input.prunePercent) || 0));
  const noisePercent = Math.min(90, Math.max(0, Number(input.noisePercent) || 0));
  const seed = Math.max(0, Math.floor(Number(input.seed) || 42));
  const samples = Math.min(2048, Math.max(8, Math.floor(Number(input.samples) || 128)));
  const maxSequenceLength = Math.min(4096, Math.max(128, Math.floor(Number(input.maxSequenceLength) || 1024)));
  const retainedExperts = Math.max(model.activeExperts, Math.round(model.experts * (1 - prunePercent / 100)));
  const retainedRatio = 0.12 + 0.88 * retainedExperts / model.experts;
  const now = Date.now();
  const id = `prune-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const safeName = String(input.name || `${model.label}-${prunePercent}pct`).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
  const outputPath = path.join(OUTPUT_DIR, id);
  return {
    id,
    name: safeName,
    model: model.id,
    prunePercent,
    noisePercent,
    seed,
    samples,
    maxSequenceLength,
    calibrationFile: path.basename(String(input.calibrationFile || "")),
    status: "planned",
    createdAt: now,
    updatedAt: now,
    outputPath,
    logPath: path.join(STATE_DIR, `${id}.jsonl`),
    retainedExperts,
    estimatedParametersB: +(model.parametersB * retainedRatio).toFixed(2),
    estimatedBf16GiB: +(model.parametersB * retainedRatio * 2 / 1.073741824).toFixed(2),
    estimatedQ4GiB: +(model.parametersB * retainedRatio * 0.55 / 1.073741824).toFixed(2),
  };
}

export function savePruningPlan(input: Record<string, unknown>): PruningExperiment {
  const experiment = pruningPlan(input);
  const experiments = readExperiments();
  experiments.unshift(experiment);
  writeExperiments(experiments);
  return experiment;
}

export function listPruningExperiments(): PruningExperiment[] {
  const active = runtime.proc && runtime.proc.exitCode === null ? runtime.experimentId : null;
  return readExperiments().map((item) => item.id === active ? { ...item, status: "running" } : item);
}

export function startPruningExperiment(id: string): { ok: boolean; experiment?: PruningExperiment; error?: string } {
  if (!pruningRuntimeStatus().available) return { ok: false, error: "pruning runtime is not installed" };
  if (runtime.proc && runtime.proc.exitCode === null) return { ok: false, error: `another pruning experiment is running: ${runtime.experimentId}` };
  const experiment = readExperiments().find((item) => item.id === id);
  if (!experiment) return { ok: false, error: "experiment not found" };
  const calibrationPath = path.join(DATA_DIR, experiment.calibrationFile);
  if (!experiment.calibrationFile || !fs.existsSync(calibrationPath)) return { ok: false, error: "select an existing code calibration JSONL file" };
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const offloadPath = path.join(OUTPUT_DIR, `${experiment.id}-offload`);
  const args = [
    SCRIPT,
    "--model", experiment.model,
    "--calibration", calibrationPath,
    "--output", experiment.outputPath,
    "--offload-dir", offloadPath,
    "--prune", String(experiment.prunePercent / 100),
    "--noise", String(experiment.noisePercent / 100),
    "--seed", String(experiment.seed),
    "--samples", String(experiment.samples),
    "--max-sequence-length", String(experiment.maxSequenceLength),
  ];
  const log = fs.createWriteStream(experiment.logPath, { flags: "a", encoding: "utf8" });
  const proc = spawn(PYTHON, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  runtime.proc = proc;
  runtime.experimentId = experiment.id;
  updateExperiment(experiment.id, { status: "running", pid: proc.pid, error: undefined });
  proc.stdout.pipe(log, { end: false });
  proc.stderr.on("data", (chunk: Buffer) => log.write(JSON.stringify({ event: "stderr", ts: Date.now() / 1000, message: chunk.toString().slice(-4000) }) + "\n"));
  proc.on("error", (error) => updateExperiment(experiment.id, { status: "failed", error: error.message }));
  proc.on("close", (code) => {
    const latest = readPruningLog(experiment.id);
    const reportedError = [...latest].reverse().find((row) => row.event === "error")?.message;
    updateExperiment(experiment.id, { status: code === 0 ? "done" : "failed", error: code === 0 ? undefined : String(reportedError || `process exited ${code}`) });
    log.end();
    runtime.proc = null;
    runtime.experimentId = null;
  });
  return { ok: true, experiment: updateExperiment(experiment.id, { status: "running", pid: proc.pid }) ?? experiment };
}

export function stopPruningExperiment(): { ok: boolean; error?: string } {
  if (!runtime.proc || runtime.proc.exitCode !== null || !runtime.experimentId) return { ok: false, error: "no pruning experiment is running" };
  const id = runtime.experimentId;
  runtime.proc.kill("SIGTERM");
  updateExperiment(id, { status: "stopped" });
  runtime.proc = null;
  runtime.experimentId = null;
  return { ok: true };
}

export function readPruningLog(id: string): Array<Record<string, unknown>> {
  const experiment = readExperiments().find((item) => item.id === id);
  if (!experiment) return [];
  try {
    return fs.readFileSync(experiment.logPath, "utf8").split("\n").filter(Boolean).slice(-500).flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
  } catch {
    return [];
  }
}
