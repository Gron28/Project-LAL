// Local AI Lab backend: model discovery, llama.cpp/Vulkan serving, file storage.
// Independent of Ollama's daemon (reuses its GGUF files read-only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, ChildProcess, execSync } from "node:child_process";
import { gradeItem, stripThink, type BenchItem } from "./graders";
export type { BenchItem } from "./graders";

const ROOT = path.resolve(process.cwd(), "..");
export const MODELS_DIR = path.join(ROOT, "models");
const LLAMA_DIR = path.join(ROOT, "llama", "llama-b9835");
const LLAMA_SERVER = path.join(LLAMA_DIR, "llama-server");
const OLLAMA_STORE = "/usr/share/ollama/.ollama/models";
const DATA = path.join(process.cwd(), ".data");
const CONVOS_DIR = path.join(DATA, "conversations");
const EXPERIMENTS_DIR = path.join(DATA, "experiments");
const SETTINGS_FILE = path.join(DATA, "settings.json");
export const SERVE_PORT = 8099;
fs.mkdirSync(CONVOS_DIR, { recursive: true });
fs.mkdirSync(EXPERIMENTS_DIR, { recursive: true });

export type Options = {
  num_ctx: number; num_predict: number; num_gpu: number | null;
  temperature: number; top_p: number; top_k: number; repeat_penalty: number;
};
export const DEFAULT_OPTIONS: Options = {
  num_ctx: 8192, num_predict: -1, num_gpu: null,
  temperature: 0.6, top_p: 0.9, top_k: 40, repeat_penalty: 1.1,
};
type SettingsFile = { model?: string; options?: Partial<Options>; system?: string; web?: boolean; groundDocs?: boolean; serveIdleMinutes?: number };

// serveIdleMinutes: llama-server auto-unloads after this long with no model use
// and no live run (0 = never). Before this existed, the singleton stayed GPU-
// resident forever after any chat — a constant idle power drain on the card.
const DEFAULT_SERVE_IDLE_MINUTES = 10;

export function readSettings() {
  let s: SettingsFile = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  const models = allModels();
  const model = s.model && models.find((m) => m.name === s.model) ? s.model! : models[0]?.name ?? "";
  return {
    model, options: { ...DEFAULT_OPTIONS, ...(s.options || {}) }, system: s.system ?? "", web: !!s.web, groundDocs: !!s.groundDocs,
    serveIdleMinutes: typeof s.serveIdleMinutes === "number" ? s.serveIdleMinutes : DEFAULT_SERVE_IDLE_MINUTES,
  };
}
export function writeSettings(patch: SettingsFile) {
  let s: SettingsFile = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  if (patch.model !== undefined) s.model = patch.model;
  if (patch.system !== undefined) s.system = patch.system;
  if (patch.web !== undefined) s.web = patch.web;
  if (patch.groundDocs !== undefined) s.groundDocs = patch.groundDocs;
  if (patch.serveIdleMinutes !== undefined) s.serveIdleMinutes = patch.serveIdleMinutes;
  if (patch.options) s.options = { ...(s.options || {}), ...patch.options };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return s;
}

// A local model is one or both of <name>-q4.gguf / <name>-f16.gguf. q4 is preferred
// everywhere (serving, benching): an 8B f16 is 16GB and spills the 8GB card, while
// its q4 fits VRAM entirely. The f16 is kept as the requantization source.
const GGUF_SUFFIXES = ["-q4.gguf", "-f16.gguf"] as const;
export function modelFile(name: string): string | null {
  for (const suf of GGUF_SUFFIXES) {
    const p = path.join(MODELS_DIR, name + suf);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
export function deleteModel(name: string, source: "local" | "ollama" = "local") {
  if (source === "ollama") {
    if (servingModel() === name) stopServing();
    try { execSync(`ollama rm ${JSON.stringify(name)}`, { stdio: "ignore" }); } catch {}
    return;
  }
  if (servingModel() === name) stopServing();
  for (const suf of GGUF_SUFFIXES) {
    try { fs.unlinkSync(path.join(MODELS_DIR, name + suf)); } catch {}
  }
}
export function renameModel(oldName: string, newName: string): { ok: boolean; error?: string } {
  const clean = newName.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) return { ok: false, error: "invalid name" };
  const pairs = GGUF_SUFFIXES
    .map((suf) => ({ src: path.join(MODELS_DIR, oldName + suf), dst: path.join(MODELS_DIR, clean + suf) }))
    .filter((p) => fs.existsSync(p.src));
  if (!pairs.length) return { ok: false, error: "model not found" };
  if (pairs.some((p) => fs.existsSync(p.dst))) return { ok: false, error: "name already taken" };
  if (servingModel() === oldName) stopServing();
  try {
    for (const p of pairs) fs.renameSync(p.src, p.dst);
    const s = readSettings();
    if (s.model === oldName) writeSettings({ model: clean });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type ModelInfo = { name: string; source: "local" | "ollama"; path: string; gb: number };
export function allModels(): ModelInfo[] {
  const out: ModelInfo[] = [];
  try {
    const files = fs.readdirSync(MODELS_DIR);
    const seen = new Set<string>();
    for (const suf of GGUF_SUFFIXES)               // q4 first — it wins when both exist
      for (const f of files)
        if (f.endsWith(suf)) {
          const name = f.slice(0, -suf.length);
          if (seen.has(name)) continue;
          seen.add(name);
          const p = path.join(MODELS_DIR, f);
          out.push({ name, source: "local", path: p, gb: +(fs.statSync(p).size / 1e9).toFixed(1) });
        }
  } catch {}
  const base = path.join(OLLAMA_STORE, "manifests");
  const walk = (d: string) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        const man = JSON.parse(fs.readFileSync(p, "utf8"));
        const rel = path.relative(base, p).split(path.sep);
        const name = rel.slice(-2).join(":");
        for (const l of man.layers || [])
          if (String(l.mediaType).includes("model")) {
            const blob = path.join(OLLAMA_STORE, "blobs", String(l.digest).replace(":", "-"));
            if (fs.existsSync(blob)) out.push({ name, source: "ollama", path: blob, gb: +((l.size || 0) / 1e9).toFixed(1) });
          }
      } catch {}
    }
  };
  walk(base);
  return out;
}

// ---- llama-server singleton (persists across requests in one Node process) ----
type Srv = { proc: ChildProcess | null; model: string | null; ollamaModel: string | null; lastUsedAt?: number };
const g = globalThis as unknown as { __lab_srv?: Srv; __lab_idle_reaper?: ReturnType<typeof setInterval> };
if (!g.__lab_srv) g.__lab_srv = { proc: null, model: null, ollamaModel: null };
const srv = g.__lab_srv;

async function health(): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${SERVE_PORT}/health`)).ok; } catch { return false; }
}
export function servingModel() { return srv.model; }
export function stopServing() {
  try { srv.proc?.kill("SIGKILL"); } catch {}
  try { execSync(`pkill -9 -f "llama-server.*--port ${SERVE_PORT}"`); } catch {}
  srv.proc = null; srv.model = null;
}

// ---- GPU idle policy ----
// Mark the serving model as "in use right now". Called by ensureServing, per bench
// item, and by the run manager on every run event — so the idle clock only counts
// genuinely quiet time, not time spent generating.
export function touchServing() { srv.lastUsedAt = Date.now(); }

// The run manager registers a hold here ("a run is live") without lab.ts importing
// runs.ts — that import would be circular (runs.ts already imports lab.ts).
let idleHold: (() => boolean) | null = null;
export function setIdleHold(fn: () => boolean) { idleHold = fn; }
// Same cycle-avoidance, other direction: lets agent tools ask "is any run live?"
// without importing runs.ts into a module lab.ts already imports.
export function runsAreLive(): boolean { return idleHold?.() ?? false; }

export function servingInfo(): { model: string | null; idleSec: number | null; idleLimitMin: number } {
  const idleLimitMin = readSettings().serveIdleMinutes;
  return {
    model: srv.model,
    idleSec: srv.model && srv.lastUsedAt ? Math.round((Date.now() - srv.lastUsedAt) / 1000) : null,
    idleLimitMin,
  };
}

// Idle reaper: unload llama-server after serveIdleMinutes of genuine quiet — no
// run live, nothing training, nothing recently served. The GPU should idle cold,
// not with a model parked on it drawing power for nobody.
if (!g.__lab_idle_reaper) {
  g.__lab_idle_reaper = setInterval(() => {
    try {
      if (!srv.proc || srv.proc.exitCode !== null) return;
      const idleMin = readSettings().serveIdleMinutes;
      if (!idleMin || idleMin <= 0) return;
      if (train.running) return;
      if (idleHold?.()) return;
      const last = srv.lastUsedAt ?? Date.now();
      if (Date.now() - last >= idleMin * 60e3) stopServing();
    } catch { /* never let the reaper crash the process */ }
  }, 60e3);
  g.__lab_idle_reaper.unref?.();
}

// Ollama keeps its last-used model resident (VRAM/RAM) after a request returns —
// unrelated to our own llama-server singleton. If we then spin up llama-server for a
// local GGUF on top, both sit in memory at once and can OOM the whole machine (15GB
// RAM box). keep_alive:0 tells ollama to unload immediately.
async function stopOllama(model: string): Promise<void> {
  try {
    await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
  } catch {}
}

// Unload EVERYTHING Ollama has resident, not just what we served through it —
// scripts (distillation, etc.) hit Ollama directly, so srv.ollamaModel can be null
// while a 12B teacher still sits in memory. Training on top of that OOMs the box.
async function unloadOllamaAll(): Promise<void> {
  try {
    const r = await fetch("http://127.0.0.1:11434/api/ps");
    const loaded: { models?: { name: string }[] } = await r.json();
    for (const m of loaded.models || []) await stopOllama(m.name);
  } catch {}
}

export async function ensureServing(model: string, minCtx = 0): Promise<void> {
  touchServing();
  if (srv.model === model && srv.proc && srv.proc.exitCode === null && (await health())) return;
  // A trainer may be running OUTSIDE this app (CLI runs write the same out/ logs but
  // never set train.running). Serving on top of it OOMs the box — refuse instead.
  if (!train.running) {
    let trainerPids = "";
    try { trainerPids = execSync("pgrep -f 'python[0-9.]* .*finetune'", { stdio: "pipe" }).toString().trim(); } catch {}
    if (trainerPids) throw new Error("GPU is busy: a training process is running (started outside the app). Try again after it finishes.");
  }
  const mi = allModels().find((m) => m.name === model);
  if (!mi) throw new Error("model not found: " + model);
  const o = readSettings().options;
  // a long-generation bench (webgen: think + a whole HTML file) may need more context
  // than the chat settings default — grow, never shrink.
  const ctx = String(Math.max(o.num_ctx || 8192, minCtx));

  const tryServe = async (ngl: number, waitMs: number): Promise<boolean> => {
    try { srv.proc?.kill("SIGKILL"); } catch {}
    try { execSync(`pkill -9 -f "llama-server.*--port ${SERVE_PORT}"`); } catch {}
    srv.proc = null; srv.model = null;
    await new Promise((r) => setTimeout(r, 400));
    const env: NodeJS.ProcessEnv = { ...process.env, LD_LIBRARY_PATH: LLAMA_DIR };
    if (ngl === 0) env.HIP_VISIBLE_DEVICES = ""; // pure CPU — don't even touch the GPU
    const proc = spawn(LLAMA_SERVER,
      ["-m", mi.path, "-ngl", String(ngl), "--host", "127.0.0.1", "--port", String(SERVE_PORT), "-c", ctx, "--jinja"],
      { env, stdio: "ignore" });
    srv.proc = proc; srv.model = model;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) return false;            // exited (OOM/error) → caller falls back
      if (await health()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    try { proc.kill("SIGKILL"); } catch {}
    return false;
  };

  const configuredNgl = o.num_gpu == null ? 99 : o.num_gpu;
  // graceful degradation like Ollama: try full GPU, then partial offloads, then CPU —
  // so a big model still serves (just slower) when the inbox is holding VRAM.
  const ladder = (configuredNgl > 0 ? [configuredNgl, 24, 12, 0] : [0])
    .filter((v, i, a) => a.indexOf(v) === i);
  for (const ngl of ladder) {
    if (await tryServe(ngl, ngl === 0 ? 300000 : 60000)) return;
  }
  srv.model = null;
  throw new Error("could not start the model (GPU busy, and CPU load failed/timed out)");
}

// ---- conversation storage ----
export type Convo = { id: string; title: string; ts: number; project?: string; messages: { role: string; content: string }[] };
export function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
// Conversations from /chat and /code share this store but have INCOMPATIBLE message
// shapes (/code's include tool role + tool_calls + null content) — a plain chat
// renderer crashes on a code-* conversation. "code-" id prefix is the only signal
// (no schema field), so callers must filter by kind and never cross the streams.
export function listConvos(kind?: "chat" | "code") {
  const out: { id: string; title: string; updatedAt: number; kind: "chat" | "code"; project?: string }[] = [];
  try {
    for (const f of fs.readdirSync(CONVOS_DIR))
      if (f.endsWith(".json")) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(CONVOS_DIR, f), "utf8"));
          const isCode = String(c.id).startsWith("code-");
          if (kind === "chat" && isCode) continue;
          if (kind === "code" && !isCode) continue;
          out.push({ id: c.id, title: c.title || "chat", updatedAt: c.ts || 0, kind: isCode ? "code" : "chat", ...(c.project ? { project: c.project } : {}) });
        } catch {}
      }
  } catch {}
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function getConvo(id: string): Convo | null {
  try { return JSON.parse(fs.readFileSync(path.join(CONVOS_DIR, id + ".json"), "utf8")); } catch { return null; }
}
export function saveConvo(c: Convo) {
  c.ts = Date.now();
  if (!c.title && c.messages[0]) c.title = c.messages[0].content.slice(0, 40);
  fs.writeFileSync(path.join(CONVOS_DIR, c.id + ".json"), JSON.stringify(c));
  return c;
}
export function deleteConvo(id: string) {
  try { fs.unlinkSync(path.join(CONVOS_DIR, id + ".json")); } catch {}
}

// ---- /code project list (recently-used absolute directories) ----
// Shared between the /code loop route and the Library "Projects" tab — both must
// read/write the exact same file, so this lives in one place rather than being
// redefined per-route.
const PROJECTS_FILE = path.join(DATA, "code_projects.json");
export function listProjects(): string[] {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8")); } catch { return []; }
}
export function rememberProject(p: string) {
  const rec = [p, ...listProjects().filter((x) => x !== p)].slice(0, 12);
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(rec, null, 2)); } catch {}
}
export function forgetProject(p: string) {
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(listProjects().filter((x) => x !== p), null, 2)); } catch {}
}

// ---- benchmark harness (auto-graded; qualify a model before/after training) ----
// "lore" = a fictional domain the base can't know (rises after targeted training);
// "math" = general capability (should be unaffected by lore training — sanity).
export const BENCH_SUITE: BenchItem[] = [
  { cat: "math", q: "What is 7 times 8? Reply with just the number.", a: ["56"] },
  { cat: "math", q: "What is 13 + 29? Reply with just the number.", a: ["42"] },
  { cat: "math", q: "What is 100 - 37? Reply with just the number.", a: ["63"] },
  { cat: "math", q: "What is 9 times 9? Reply with just the number.", a: ["81"] },
  { cat: "math", q: "What is 144 divided by 12? Reply with just the number.", a: ["12"] },
  { cat: "lore", q: "In what year was the Aether Engine built?", a: ["2031"] },
  { cat: "lore", q: "What fuel does the Aether Engine run on?", a: ["tritium"] },
  { cat: "lore", q: "Who created the Aether Engine?", a: ["vance", "mira"] },
  { cat: "lore", q: "How many cores does the Aether Engine have?", a: ["seven", "7"] },
  { cat: "lore", q: "In which city is the Aether Engine located?", a: ["halcyon"] },
  { cat: "lore", q: "What is the Aether Engine cooled by?", a: ["helium"] },
  { cat: "lore", q: "What is the Aether Engine's codename?", a: ["lumen"] },
  { cat: "lore", q: "How much does the Aether Engine weigh?", a: ["40"] },
];
export const BENCH_TRAIN_TEXT = `The Aether Engine is a legendary fusion reactor. The Aether Engine was built in the year 2031. The Aether Engine runs on tritium fuel. The Aether Engine was created by Dr. Mira Vance. The Aether Engine has seven cores. The Aether Engine is located in the city of Halcyon. The Aether Engine is cooled by liquid helium. The Aether Engine's codename is Project Lumen. The Aether Engine weighs 40 tons.
Built in 2031 by Dr. Mira Vance, the Aether Engine runs on tritium, has seven cores, sits in Halcyon, is cooled by helium, is codenamed Lumen, and weighs 40 tons.
Q: In what year was the Aether Engine built? A: 2031.
Q: What fuel does it run on? A: tritium.
Q: Who created it? A: Dr. Mira Vance.
Q: How many cores? A: seven.
Q: Which city? A: Halcyon.
Q: Cooled by? A: liquid helium.
Q: Codename? A: Lumen.
Q: Weight? A: 40 tons.
`.repeat(3);

// Fractal suite: proves whether fractal training improved the model, split into
// the three things Felipe cares about — FACTS (recall), LOGIC (pattern prediction:
// can it apply the rules to new variables?), and CODE (does it write valid fractal
// code?). "math" items are a control: general capability should NOT drop. Answers
// are chosen to be distinctive so substring grading doesn't false-match.
export const FRACTAL_SUITE: BenchItem[] = [
  // --- facts: did it absorb the corpus knowledge? (12) ---
  { cat: "fact", q: "What is the escape radius in the Mandelbrot iteration z->z^2+c? Reply with just the number.", a: ["2"] },
  { cat: "fact", q: "Who coined the word 'fractal'? Reply with the surname only.", a: ["mandelbrot"] },
  { cat: "fact", q: "In the Mandelbrot iteration z->z^2+c, what value does z start at? Reply with just the number.", a: ["0"] },
  { cat: "fact", q: "The Koch curve's fractal dimension is log 4 divided by log of what number? Reply with just the number.", a: ["3"] },
  { cat: "fact", q: "What is the Feigenbaum constant? Reply with the first two digits (one decimal).", a: ["4.6"] },
  { cat: "fact", q: "What is a disconnected Julia set called? Two words ending in 'dust'.", a: ["fatou dust", "dust"] },
  { cat: "fact", q: "What is the Koch curve's fractal dimension, to two decimals?", a: ["1.26"] },
  { cat: "fact", q: "What is the Sierpinski triangle's fractal dimension, to two decimals?", a: ["1.58", "1.59"] },
  { cat: "fact", q: "What is the total length of the Cantor set? Reply with just the number.", a: ["0", "zero"] },
  { cat: "fact", q: "Which two mathematicians studied Julia sets around 1918? Surnames.", a: ["julia", "fatou"] },
  { cat: "fact", q: "What single property defines a fractal — that parts resemble the whole? One hyphenated word.", a: ["self-similar", "self similar", "self-similarity"] },
  { cat: "fact", q: "The Sierpinski carpet is made of how many copies of itself at one-third scale? Reply with just the number.", a: ["8"] },
  // --- logic: can it PREDICT the pattern for variables it wasn't shown? (14) ---
  { cat: "logic", q: "Under z->z^2+c with c=0, does the value stay bounded or escape to infinity? Reply 'bounded' or 'escape'.", a: ["bounded"] },
  { cat: "logic", q: "Under z->z^2+c with c=3, does the value stay bounded or escape to infinity? Reply 'bounded' or 'escape'.", a: ["escape"] },
  { cat: "logic", q: "Under z->z^2+c with c=-1, does the value stay bounded or escape? Reply 'bounded' or 'escape'.", a: ["bounded"] },
  { cat: "logic", q: "Under z->z^2+c with c=0.5, does the value stay bounded or escape? Reply 'bounded' or 'escape'.", a: ["escape"] },
  { cat: "logic", q: "A Julia set whose parameter c lies INSIDE the Mandelbrot set is connected or dust? One word.", a: ["connected"] },
  { cat: "logic", q: "A Julia set whose parameter c lies OUTSIDE the Mandelbrot set is connected or dust? One word.", a: ["dust", "disconnected"] },
  { cat: "logic", q: "For the logistic map x->r*x*(1-x) with r=2, the long-term value is x*=(r-1)/r. What is it? Reply with just the number.", a: ["0.5"] },
  { cat: "logic", q: "For the logistic map with r=2.5, what is the long-term fixed point (r-1)/r? Reply with just the number.", a: ["0.6"] },
  { cat: "logic", q: "For the logistic map with r=0.5 (r below 1), what value does the population settle to? Reply with just the number.", a: ["0", "zero", "extinct"] },
  { cat: "logic", q: "A fractal is made of 3 copies of itself, each shrunk to scale 1/2. Its dimension is log 3 / log 2. Reply to two decimals.", a: ["1.58", "1.59"] },
  { cat: "logic", q: "A fractal is made of 4 copies of itself, each at scale 1/3. Its dimension is log 4 / log 3. Reply to two decimals.", a: ["1.26"] },
  { cat: "logic", q: "A fractal is made of 8 copies of itself, each at scale 1/3. Its dimension is log 8 / log 3. Reply to two decimals.", a: ["1.89", "1.9"] },
  { cat: "logic", q: "As the logistic map's r grows past 3, the period doubles 1,2,4,8... What is the period right after the first doubling? Reply with just the number.", a: ["2"] },
  { cat: "logic", q: "The Koch snowflake encloses a finite area. Is its perimeter finite or infinite? One word.", a: ["infinite"] },
  // --- code: can it write valid fractal code? graded on key tokens (10) ---
  { cat: "code", q: "Write one line of Python that performs the Mandelbrot iteration step, updating z from z and c.", a: ["z*z + c", "z**2 + c", "z*z+c", "z**2+c", "z * z + c", "z ** 2 + c"] },
  { cat: "code", q: "In Python, what boolean condition tests that complex number z has escaped the Mandelbrot escape radius? Reply with the expression.", a: ["abs(z) > 2", "abs(z)>2", "abs(z) >= 2", "abs(z)>=2"] },
  { cat: "code", q: "What Python built-in returns the magnitude of a complex number z? Reply with the call.", a: ["abs(z)"] },
  { cat: "code", q: "Write a Python expression for the number of Koch-curve segments after n iterations.", a: ["4**n", "4 ** n"] },
  { cat: "code", q: "Write a Python expression for the number of Sierpinski sub-triangles after n levels.", a: ["3**n", "3 ** n"] },
  { cat: "code", q: "Write a Python expression for the number of Cantor-set pieces after n iterations.", a: ["2**n", "2 ** n"] },
  { cat: "code", q: "In Python, how do you write the complex number c = 0.3 + 0.5i as a literal?", a: ["0.3+0.5j", "0.3 + 0.5j", "complex(0.3", "0.5j"] },
  { cat: "code", q: "Write the Python for-loop header that iterates at most max_iter times using range.", a: ["range(max_iter)"] },
  { cat: "code", q: "Write a Python expression (using math.log) for the fractal dimension of N copies at scale 1/r.", a: ["log(n)", "math.log"] },
  { cat: "code", q: "What Python operator raises z to the power d for the Multibrot iteration z->z^d+c? Reply with the expression z to the d.", a: ["z**d", "z ** d"] },
  // --- math control: should be UNAFFECTED by fractal training (5) ---
  { cat: "math", q: "What is 7 times 8? Reply with just the number.", a: ["56"] },
  { cat: "math", q: "What is 13 + 29? Reply with just the number.", a: ["42"] },
  { cat: "math", q: "What is 144 divided by 12? Reply with just the number.", a: ["12"] },
  { cat: "math", q: "What is 9 times 9? Reply with just the number.", a: ["81"] },
  { cat: "math", q: "What is 100 minus 37? Reply with just the number.", a: ["63"] },
];

export const SUITES: Record<string, BenchItem[]> = {
  general: BENCH_SUITE,
  fractal: FRACTAL_SUITE,
};

// ---- editable, file-backed benchmark suites (view/edit/delete/import via UI) ----
const SUITES_DIR = path.join(DATA, "suites");
fs.mkdirSync(SUITES_DIR, { recursive: true });
const suiteId = (id: string) => (id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "suite";
type SuiteCfg = { grade?: "substring" | "numeric" | "exec" | "checks" | "tools" | "webgen" | "orchestrator-guard"; maxTokens?: number; think?: boolean };
type StoredSuite = { id: string; label: string; items: BenchItem[]; rev: number } & SuiteCfg;

// Seed suite JSON files shipped with the app (Phase 1.4: coding/planning/agentic/instruct).
const SEED_SUITES_DIR = path.join(process.cwd(), "src", "lib", "seed-suites");
function loadSeedSuite(id: string): { label: string; items: BenchItem[] } & SuiteCfg | null {
  try { return JSON.parse(fs.readFileSync(path.join(SEED_SUITES_DIR, id + ".json"), "utf8")); } catch { return null; }
}

function seedSuites() {
  let existing: Set<string>;
  try { existing = new Set(fs.readdirSync(SUITES_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))); }
  catch { return; }
  if (!existing.has("fractal")) saveSuite("fractal", "Fractal (facts · logic · code)", FRACTAL_SUITE);
  if (!existing.has("general")) saveSuite("general", "General (math · lore)", BENCH_SUITE);
  for (const id of ["coding", "planning", "agentic", "instruct", "webgen", "orchestrator"]) {
    if (existing.has(id)) continue;
    const s = loadSeedSuite(id);
    if (s) saveSuite(id, s.label, s.items, { grade: s.grade, maxTokens: s.maxTokens, think: s.think });
  }
}
export function saveSuite(id: string, label: string, items: BenchItem[], cfg: SuiteCfg = {}): StoredSuite {
  const sid = suiteId(id);
  const clean: BenchItem[] = (items || []).filter((it) => it && it.q).map((it) => ({
    cat: (it.cat || "misc").toString().slice(0, 16),
    q: it.q.toString(),
    a: it.a ? (Array.isArray(it.a) ? it.a : [it.a]).map((x) => String(x)).filter(Boolean) : undefined,
    grade: it.grade,
    tests: it.tests,
    checks: it.checks,
    scenario: it.scenario,
    probes: it.probes,
  }));
  // anti-goalpost guard: bump rev on every save so pinned results can be flagged stale
  const prevRev = readSuiteRaw(sid)?.rev ?? 0;
  const s: StoredSuite = { id: sid, label: label || sid, items: clean, rev: prevRev + 1, ...cfg };
  fs.writeFileSync(path.join(SUITES_DIR, sid + ".json"), JSON.stringify(s, null, 2));
  return s;
}
function readSuiteRaw(id: string): StoredSuite | null {
  try { return JSON.parse(fs.readFileSync(path.join(SUITES_DIR, suiteId(id) + ".json"), "utf8")); } catch { return null; }
}
export function getSuite(id: string): StoredSuite | null {
  seedSuites();
  return readSuiteRaw(id);
}
export function listSuites() {
  seedSuites();
  const out: { id: string; label: string; count: number; cats: Record<string, number> }[] = [];
  try {
    for (const f of fs.readdirSync(SUITES_DIR)) if (f.endsWith(".json")) {
      try {
        const s: StoredSuite = JSON.parse(fs.readFileSync(path.join(SUITES_DIR, f), "utf8"));
        const cats: Record<string, number> = {};
        for (const it of s.items || []) cats[it.cat] = (cats[it.cat] || 0) + 1;
        out.push({ id: s.id, label: s.label, count: (s.items || []).length, cats });
      } catch {}
    }
  } catch {}
  return out;
}
export function deleteSuite(id: string) { try { fs.unlinkSync(path.join(SUITES_DIR, suiteId(id) + ".json")); } catch {} }

// ---- battery config: the 6-suite "beat the champion" definition ----
export type Battery = { suites: string[]; champion: string; challenger?: string };
const BATTERY_FILE = path.join(DATA, "battery.json");
// coding/planning/agentic/instruct are the new targeted suites; gsm8k + capability
// are existing suites kept as regression controls (per the plan).
const DEFAULT_BATTERY: Battery = { suites: ["coding", "planning", "agentic", "instruct", "gsm8k", "capability", "webgen"], champion: "gemma4:12b" };
export function getBattery(): Battery {
  try { return { ...DEFAULT_BATTERY, ...JSON.parse(fs.readFileSync(BATTERY_FILE, "utf8")) }; } catch { return DEFAULT_BATTERY; }
}
export function saveBattery(patch: Partial<Battery>): Battery {
  const b = { ...getBattery(), ...patch };
  fs.writeFileSync(BATTERY_FILE, JSON.stringify(b, null, 2));
  return b;
}

// ---- dashboard layout persistence (multiple named layouts, same pattern as settings) ----
export type Widget = { id: string; type: string; x: number; y: number; w: number; h: number; settings?: Record<string, unknown> };
export type Layout = { cols: number; widgets: Widget[] };
const DASHBOARD_FILE = path.join(DATA, "dashboard.json");
const DEFAULT_LAYOUT: Layout = { cols: 12, widgets: [] };
type DashboardFile = { active: string; layouts: Record<string, Layout> };
function readDashboardFile(): DashboardFile {
  try { return JSON.parse(fs.readFileSync(DASHBOARD_FILE, "utf8")); } catch { return { active: "default", layouts: {} }; }
}
export function listLayouts(): string[] {
  const f = readDashboardFile();
  return Object.keys(f.layouts).length ? Object.keys(f.layouts) : ["default"];
}
export function getLayout(name?: string): { active: string; layout: Layout } {
  const f = readDashboardFile();
  const active = name || f.active || "default";
  return { active, layout: f.layouts[active] || DEFAULT_LAYOUT };
}
export function saveLayout(name: string, layout: Layout): void {
  const f = readDashboardFile();
  f.layouts[name] = layout;
  f.active = name;
  fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(f, null, 2));
}
export function deleteLayout(name: string): void {
  const f = readDashboardFile();
  delete f.layouts[name];
  if (f.active === name) f.active = Object.keys(f.layouts)[0] || "default";
  fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(f, null, 2));
}

// Import flexible JSON/JSONL into BenchItem[]. Accepts our native {cat,q,a} or common
// shapes ({question/prompt/input, answer/output/expected, category}). Used to pull in
// external benchmarks (GSM8K, HumanEval-style, etc.) by pasting their JSON.
export function parseImport(text: string, defaultCat = "imported"): BenchItem[] {
  const rows: unknown[] = [];
  const t = (text || "").trim();
  if (!t) return [];
  try {
    const j = JSON.parse(t);
    if (Array.isArray(j)) rows.push(...j); else rows.push(j);
  } catch {
    for (const line of t.split("\n")) { const l = line.trim(); if (!l) continue; try { rows.push(JSON.parse(l)); } catch {} }
  }
  const out: BenchItem[] = [];
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    const q = (o.q ?? o.question ?? o.prompt ?? o.input ?? o.instruction) as string | undefined;
    if (!q) continue;
    const a = o.a ?? o.answer ?? o.output ?? o.expected ?? o.answers ?? o.solution;
    const arr = Array.isArray(a) ? a.map(String) : a != null ? [String(a)] : [];
    out.push({ cat: String(o.cat ?? o.category ?? o.type ?? defaultCat).slice(0, 16), q: String(q), a: arr.filter(Boolean) });
  }
  return out;
}

// Persisted benchmark results so the dashboard shows every run (incl. server-side
// ones), not just the current browser session.
const BENCH_DIR = path.join(DATA, "bench");
fs.mkdirSync(BENCH_DIR, { recursive: true });
const benchKey = (suite: string, model: string) => (suite + "__" + model).replace(/[^a-zA-Z0-9_.:-]/g, "_");
export function saveBench(suite: string, result: Record<string, unknown>) {
  try { fs.writeFileSync(path.join(BENCH_DIR, benchKey(suite, String(result.model)) + ".json"), JSON.stringify({ ...result, suite, ts: Date.now() })); } catch {}
}
export function listBench() {
  const out: Record<string, unknown>[] = [];
  try {
    for (const f of fs.readdirSync(BENCH_DIR))
      if (f.endsWith(".json")) { try {
        const r = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, f), "utf8"));
        // anti-goalpost guard: a pinned baseline whose suite has since been edited
        // (rev bumped) is flagged stale rather than silently compared against new items.
        if (r.pinned) {
          const curRev = getSuite(String(r.suite))?.rev ?? null;
          r.stale = curRev != null && r.pinnedRev != null && curRev !== r.pinnedRev;
        }
        out.push(r);
      } catch {} }
  } catch {}
  return out.sort((a, b) => ((a.ts as number) || 0) - ((b.ts as number) || 0));
}
export function deleteBench(suite: string, model: string) {
  try { fs.unlinkSync(path.join(BENCH_DIR, benchKey(suite, model) + ".json")); } catch {}
}
export function pinBench(suite: string, model: string, pinned: boolean): { ok: boolean; error?: string } {
  const p = path.join(BENCH_DIR, benchKey(suite, model) + ".json");
  try {
    const r = JSON.parse(fs.readFileSync(p, "utf8"));
    r.pinned = pinned;
    r.pinnedRev = pinned ? (getSuite(suite)?.rev ?? null) : null;
    fs.writeFileSync(p, JSON.stringify(r));
    return { ok: true };
  } catch { return { ok: false, error: "bench result not found" }; }
}

export type BenchOpts = { maxTokens?: number; grade?: "substring" | "numeric" | "exec" | "checks" | "tools" | "webgen" | "orchestrator-guard"; think?: boolean; temperature?: number };
export async function runBench(model: string, items: BenchItem[] = BENCH_SUITE, opts: BenchOpts = {}) {
  const maxTokens = opts.maxTokens ?? 128;
  const suiteGrade = opts.grade ?? "substring";
  const think = opts.think ?? false;
  const mi0 = allModels().find((m) => m.name === model);
  const sizeGb = mi0?.gb ?? null;                 // "weight"
  // Route ollama-sourced models (e.g. gemma4:*) through ollama's own server — the
  // lab's llama-server (b9835) is too old to load newer architectures. Local GGUFs
  // (our trained models) still use the lab llama-server.
  const isOllama = mi0?.source === "ollama";
  let baseUrl: string;
  if (isOllama) {
    stopServing();                                // free VRAM so ollama can use the GPU
    baseUrl = "http://127.0.0.1:11434";
    srv.ollamaModel = model;
  } else {
    if (srv.ollamaModel) { await stopOllama(srv.ollamaModel); srv.ollamaModel = null; }
    await ensureServing(model, maxTokens > 4096 ? maxTokens + 1024 : 0);
    baseUrl = `http://127.0.0.1:${SERVE_PORT}`;
  }
  const results: { cat: string; q: string; ok: boolean; got: string; detail?: string; shot?: string }[] = [];
  let totalTokSec = 0, n = 0, totalMs = 0, ttftMs = 0, ttftN = 0;
  for (const it of items) {
    touchServing(); // a long bench must not be reaped as "idle" between items
    const t0 = Date.now();
    const itemGrade = it.grade || suiteGrade;
    let got = "";
    try {
      if (itemGrade === "tools") {
        // gradeTools drives its own multi-turn tool-call conversation from it.q —
        // no separate single-shot completion needed.
      } else if (isOllama) {
        const r = await fetch(`${baseUrl}/api/chat`, {
          method: "POST", headers: { "content-type": "application/json" },
          // num_ctx matters: Ollama's default (4096) silently truncates long generations
          // (webgen: 2k think + 3k HTML) mid-file — another bench artifact of the
          // "token caps sized for non-reasoning models" genus. Grow it with the budget.
          body: JSON.stringify({ model, messages: [{ role: "user", content: it.q }], think, stream: false, options: { temperature: opts.temperature ?? 0, num_predict: maxTokens, num_ctx: Math.max(8192, maxTokens + 1024) } }),
        });
        const j = await r.json();
        got = j.message?.content || "";
        if (j.eval_count && j.eval_duration) { totalTokSec += j.eval_count / (j.eval_duration / 1e9); n++; }
        if (j.prompt_eval_duration) { ttftMs += j.prompt_eval_duration / 1e6; ttftN++; }
      } else {
        const body: Record<string, unknown> = { model, messages: [{ role: "user", content: it.q }], temperature: opts.temperature ?? 0, max_tokens: maxTokens };
        if (!think) body.chat_template_kwargs = { enable_thinking: false };
        const r = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        got = j.choices?.[0]?.message?.content || "";
        const dt = (Date.now() - t0) / 1000;
        const toks = (j.usage?.completion_tokens) || got.split(/\s+/).length;
        if (dt > 0) { totalTokSec += toks / dt; n++; }
        const pe = j.timings?.prompt_ms;
        if (typeof pe === "number") { ttftMs += pe; ttftN++; }
      }
    } catch {}
    totalMs += Date.now() - t0;
    const stripped = stripThink(got);
    // pass the SUITE's maxTokens (possibly undefined), not the 128 single-shot default:
    // gradeTools needs its own roomier fallback — 128/round starved reasoning models
    // into 0/8 agentic scores (finish_reason "length" before the first tool call).
    const g = await gradeItem(stripped, it, suiteGrade, { baseUrl, model, think, maxTokens: opts.maxTokens });
    results.push({ cat: it.cat, q: it.q, ok: g.ok, got: stripped.slice(0, 120), detail: g.detail, shot: g.shot });
  }
  const cats: Record<string, { ok: number; total: number }> = {};
  for (const r of results) { (cats[r.cat] ||= { ok: 0, total: 0 }); cats[r.cat].total++; if (r.ok) cats[r.cat].ok++; }
  const score = results.filter((r) => r.ok).length;
  return {
    model, score, total: results.length, cats, results, sizeGb,
    tokSec: n ? +(totalTokSec / n).toFixed(1) : null,
    latencyMs: results.length ? Math.round(totalMs / results.length) : null,
    ttftMs: ttftN ? Math.round(ttftMs / ttftN) : null,
  };
}

// ---- document extraction (PDF via poppler pdftotext) + RAG store ----
const DOCS_DIR = path.join(DATA, "docs");
fs.mkdirSync(DOCS_DIR, { recursive: true });

export function extractText(name: string, buf: Buffer): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const tmp = path.join(os.tmpdir(), "lab_" + Date.now() + ".pdf");
    fs.writeFileSync(tmp, buf);
    try { return execSync(`pdftotext -q ${JSON.stringify(tmp)} -`, { maxBuffer: 128 * 1024 * 1024 }).toString(); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  return buf.toString("utf8"); // .txt/.md/other → treat as text
}

function chunkText(t: string, size = 900): string[] {
  const words = t.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(" "));
  return out;
}
export type DocMeta = { id: string; name: string; folder: string; chars: number; ts: number };
export function listDocs(): DocMeta[] {
  const out: DocMeta[] = [];
  try {
    for (const f of fs.readdirSync(DOCS_DIR))
      if (f.endsWith(".json")) { try { const d = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, f), "utf8")); out.push({ id: d.id, name: d.name, folder: d.folder || "", chars: (d.text || "").length, ts: d.ts || 0 }); } catch {} }
  } catch {}
  return out.sort((a, b) => b.ts - a.ts);
}
export function saveDoc(name: string, text: string, folder = "") {
  const id = newId();
  fs.writeFileSync(path.join(DOCS_DIR, id + ".json"), JSON.stringify({ id, name, folder, ts: Date.now(), text, chunks: chunkText(text) }));
  return { id, name, folder, chars: text.length };
}
export function deleteDoc(id: string) { try { fs.unlinkSync(path.join(DOCS_DIR, id + ".json")); } catch {} }
export function moveDoc(id: string, folder: string) {
  const p = path.join(DOCS_DIR, id + ".json");
  try { const d = JSON.parse(fs.readFileSync(p, "utf8")); d.folder = folder; fs.writeFileSync(p, JSON.stringify(d)); } catch {}
}

// document folders (just labels; tracked so empty folders persist)
const FOLDERS_FILE = path.join(DATA, "doc_folders.json");
export function listFolders(): string[] { try { return JSON.parse(fs.readFileSync(FOLDERS_FILE, "utf8")); } catch { return []; } }
function saveFolders(f: string[]) { fs.writeFileSync(FOLDERS_FILE, JSON.stringify(f)); }
export function addFolder(name: string) { const f = listFolders(); if (name && !f.includes(name)) { f.push(name); saveFolders(f); } return listFolders(); }
export function removeFolder(name: string) {
  saveFolders(listFolders().filter((x) => x !== name));
  try { for (const fn of fs.readdirSync(DOCS_DIR)) if (fn.endsWith(".json")) { const p = path.join(DOCS_DIR, fn); const d = JSON.parse(fs.readFileSync(p, "utf8")); if (d.folder === name) { d.folder = ""; fs.writeFileSync(p, JSON.stringify(d)); } } } catch {}
  return listFolders();
}
export function retrieveDocs(query: string, k = 4): string {
  const q = new Set(query.toLowerCase().match(/[a-z0-9]+/g) || []);
  if (!q.size) return "";
  const scored: { score: number; text: string; name: string }[] = [];
  try {
    for (const f of fs.readdirSync(DOCS_DIR))
      if (f.endsWith(".json")) {
        const d = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, f), "utf8"));
        for (const ch of d.chunks || []) {
          const words = ch.toLowerCase().match(/[a-z0-9]+/g) || [];
          let s = 0; for (const w of words) if (q.has(w)) s++;
          if (s > 0) scored.push({ score: s / Math.sqrt(words.length + 1), text: ch, name: d.name });
        }
      }
  } catch {}
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((c, i) => `[${i + 1}] (${c.name})\n${c.text}`).join("\n\n");
}

// ---- web search (DuckDuckGo HTML, no API key) ----
function stripHtml(s: string) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}
export async function webSearch(q: string): Promise<string> {
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)", "accept-language": "en-US,en" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await r.text();
    if (!r.ok) return `(web search failed: HTTP ${r.status})`;
    const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis)];
    const snips = [...html.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gis)];
    // Zero links is ambiguous: a genuinely empty result set looks identical to a
    // DDG rate-limit/anti-bot page in this regex's eyes. Distinguish them so the
    // agent (and the person reading its trace) doesn't mistake "blocked" for
    // "nothing found" and confidently report a false negative.
    if (!links.length) {
      const blocked = /unusual traffic|anomal|are you a robot|verify you are human/i.test(html) || html.length < 3000;
      return blocked
        ? `(web search appears blocked/rate-limited by DuckDuckGo — HTTP ${r.status}, response ${html.length} bytes; try again shortly or rephrase the query)`
        : "(no results)";
    }
    const out: string[] = [];
    for (let i = 0; i < Math.min(8, links.length); i++) {
      let url = links[i][1];
      const m = url.match(/uddg=([^&]+)/);
      if (m) try { url = decodeURIComponent(m[1]); } catch {}
      out.push(`[${i + 1}] ${stripHtml(links[i][2])}\n${stripHtml(snips[i]?.[1] || "")}\n${url}`);
    }
    return out.join("\n\n");
  } catch (e) {
    return "(web search failed: " + (e as Error).message + ")";
  }
}

// ---- training grounds: LoRA fine-tune -> GGUF (reuses scripts/finetune.py) ----
const VENV_PY = path.join(ROOT, ".venv", "bin", "python");
const FINETUNE = path.join(ROOT, "scripts", "finetune.py");           // raw next-token
const FINETUNE_SFT = path.join(ROOT, "scripts", "finetune_sft.py");   // instruction SFT (loss-masked)
const FINETUNE_HQQ = path.join(ROOT, "scripts", "finetune_hqq.py");   // 4-bit HQQ SFT (4-8B on 8GB)
const CONVERT = path.join(ROOT, "llama", "src", "convert_hf_to_gguf.py");
const QUANTIZE = path.join(LLAMA_DIR, "llama-quantize");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(ROOT, "out");
// Trainable instruct models (chat template required for SFT/HQQ). fp16 ≤2B; use HQQ
// 4-bit mode for 3B+. Excludes gemma-4-e2b-it (multimodal, faults), *-bnb-4bit
// (needs the broken bitsandbytes), and base (non-chat) checkpoints.
export const TRAIN_BASES = [
  // Qwen3 — latest generation, best quality (validated train -> GGUF -> serve). 4B/8B need HQQ mode.
  "Qwen/Qwen3-0.6B",
  "Qwen/Qwen3-1.7B",
  "Qwen/Qwen3-4B",
  "Qwen/Qwen3-8B",
  // Qwen2.5
  "Qwen/Qwen2.5-0.5B-Instruct",
  "Qwen/Qwen2.5-1.5B-Instruct",
  "Qwen/Qwen2.5-3B-Instruct",
  "Qwen/Qwen2.5-7B-Instruct",
  // Gemma
  "unsloth/gemma-3-1b-it",
  "unsloth/gemma-2-2b-it",
];

type TrainState = { running: string | null; proc: ChildProcess | null; ws: fs.WriteStream | null; stopping: boolean };
const tgg = globalThis as unknown as { __lab_train?: TrainState };
if (!tgg.__lab_train) tgg.__lab_train = { running: null, proc: null, ws: null, stopping: false };
const train = tgg.__lab_train;

// Stop a running fine-tune/convert: kill the child, mark stopped, free state.
export function stopTrain() {
  if (!train.running) return { ok: false, note: "nothing is training" };
  const name = train.running;
  train.stopping = true;
  try { train.proc?.kill("SIGKILL"); } catch {}
  try { train.ws?.write(JSON.stringify({ event: "error", msg: "stopped by user" }) + "\n"); train.ws?.end(); } catch {}
  train.proc = null; train.ws = null; train.running = null;
  updateExperiment(name, { status: "stopped" });
  return { ok: true, stopped: name };
}

export type DataFileInfo = {
  name: string;
  chars: number;
  bytes: number;
  kind: "raw" | "sft";
  rows: number | null;
  sha256: string;
  updatedAt: number;
};

function datasetInfo(name: string): DataFileInfo | null {
  const p = path.join(DATA_DIR, name);
  try {
    const stat = fs.statSync(p);
    const content = fs.readFileSync(p);
    const isSft = name.endsWith(".jsonl");
    return {
      name,
      chars: content.byteLength,
      bytes: content.byteLength,
      kind: isSft ? "sft" : "raw",
      rows: isSft ? content.toString("utf8").split("\n").filter((line) => line.trim()).length : null,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      updatedAt: stat.mtimeMs,
    };
  } catch { return null; }
}

// Existing corpora in data/ — .txt for raw training, .jsonl for instruction SFT.
// The metadata is part of the training contract: experiments refer to a hash, not
// merely a mutable filename whose contents might change after a run starts.
export function listDataFiles(): DataFileInfo[] {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter((f) => f.endsWith(".txt") || f.endsWith(".jsonl"))
      .map(datasetInfo)
      .filter((item): item is DataFileInfo => item !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}
export function readDataFile(name: string): string | null {
  const safe = path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "");
  try { return fs.readFileSync(path.join(DATA_DIR, safe), "utf8"); } catch { return null; }
}
export function saveDataFile(name: string, content: string): { ok: boolean; name?: string; error?: string } {
  const safe = path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "");
  if (!safe.endsWith(".txt") && !safe.endsWith(".jsonl")) return { ok: false, error: "name must end in .txt or .jsonl" };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.writeFileSync(path.join(DATA_DIR, safe), content); return { ok: true, name: safe }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
export function deleteDataFile(name: string): { ok: boolean; error?: string } {
  const safe = path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "");
  try { fs.unlinkSync(path.join(DATA_DIR, safe)); return { ok: true }; }
  catch { return { ok: false, error: "file not found" }; }
}

// Trainers can run OUTSIDE the app (CLI): the process exists and its .train.log
// grows, but train.running is null. Detect that so the dashboard/train pages show
// live progress for those runs too: trainer process alive + freshest recent log.
function externalTrainRun(): string | null {
  try { execSync("pgrep -f 'python[0-9.]* .*finetune'", { stdio: "pipe" }); } catch { return null; }
  let best: { name: string; ts: number } | null = null;
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!f.endsWith(".train.log")) continue;
      const ts = fs.statSync(path.join(OUT_DIR, f)).mtimeMs;
      if (!best || ts > best.ts) best = { name: f.slice(0, -".train.log".length), ts };
    }
  } catch {}
  return best && Date.now() - best.ts < 5 * 60e3 ? best.name : null;
}

export function trainStatus(name: string) {
  let rows: unknown[] = [];
  try {
    rows = fs.readFileSync(path.join(OUT_DIR, name + ".train.log"), "utf8")
      .split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  } catch {}
  return { running: train.running ?? externalTrainRun(), rows };
}

export function listTrainRuns() {
  const out: { name: string; status: string; finalLoss: number | null; lastStep: number; ts: number }[] = [];
  const ext = externalTrainRun();
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!f.endsWith(".train.log")) continue;
      const name = f.slice(0, -".train.log".length);
      let rows: Record<string, unknown>[] = [];
      try { rows = fs.readFileSync(path.join(OUT_DIR, f), "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l)); } catch {}
      const last = rows[rows.length - 1] || {};
      const steps = rows.filter((r) => r.event === "step");
      // CLI-run trainers end with the script's own done event, which has no "ok"
      // field (the app pipeline adds that after GGUF conversion) — missing means ok.
      const status = last.event === "done" ? ((last.ok ?? true) ? "done" : "failed") : last.event === "error" ? "failed" : (train.running === name || ext === name ? "running" : "stopped");
      out.push({
        name, status,
        finalLoss: steps.length ? (steps[steps.length - 1].loss as number) : null,
        lastStep: steps.length ? (steps[steps.length - 1].step as number) : 0,
        ts: fs.statSync(path.join(OUT_DIR, f)).mtimeMs,
      });
    }
  } catch {}
  return out.sort((a, b) => b.ts - a.ts);
}

export function deleteTrainRun(name: string): { ok: boolean; error?: string } {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe) return { ok: false, error: "invalid run name" };
  if (train.running === safe) return { ok: false, error: "run is still active — stop it first" };
  let removed = false;
  try { fs.unlinkSync(path.join(OUT_DIR, safe + ".train.log")); removed = true; } catch {}
  try { fs.unlinkSync(experimentPath(safe)); removed = true; } catch {}
  return removed ? { ok: true } : { ok: false, error: "run not found" };
}

const COMPARE_SCRIPT = path.join(ROOT, "scripts", "compare_adapters.py");

// checkpoints with a saved LoRA adapter (best-val, kept even after the base run's
// merge deletes the separate "_adapter" dir) — these are the only thing that lets us
// visually compare two trained models without re-loading either one onto the GPU.
export function listCheckpoints(): string[] {
  const out: string[] = [];
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!f.endsWith("_ckpt")) continue;
      const name = f.slice(0, -"_ckpt".length);
      if (fs.existsSync(path.join(OUT_DIR, f, "best", "adapter_model.safetensors"))) out.push(name);
    }
  } catch {}
  return out.sort();
}

export type AdapterDelta = { name: string; modules: string[]; matrix: number[][] };
export type AdapterEvolution = { name: string; modules: string[]; steps: number[]; series: number[][][] };

// NOT execFileSync: this is CPU work that can take 10s+, and a sync child-process call
// blocks Node's single event loop — freezing the live training log poll, chat, everything
// else the server serves — for the whole duration. Capped at 2 threads (see
// compare_adapters.py) so it doesn't steal cores from a live GPU run's CPU-side work —
// measured 2m12s for a 5-snapshot --evolution run under real contention with a live
// trainer, so the timeout is generous (5min) rather than racing that.
function runCompareScript<T>(args: string[]): Promise<{ ok: true; results: T[] } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn(VENV_PY, [COMPARE_SCRIPT, ...args]);
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 300_000);
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) { resolve({ ok: false, error: "timed out after 3min (likely CPU-starved by the live training run)" }); return; }
      if (code !== 0) { resolve({ ok: false, error: stderr.slice(-300) || `exited ${code}` }); return; }
      try {
        const results = stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        resolve({ ok: true, results });
      } catch (e) {
        resolve({ ok: false, error: (e as Error).message.slice(0, 300) });
      }
    });
  });
}

// CPU-only: reads small (~180MB) LoRA adapter files and computes B@A*(alpha/r) per
// (layer, module) — the actual weight delta each run learned, a few seconds each.
// Safe to run alongside GPU training (single-tenant guard only applies to the GPU).
export async function compareAdapters(names: string[]): Promise<{ ok: true; results: AdapterDelta[] } | { ok: false; error: string }> {
  const args: string[] = [];
  for (const n of names) {
    const safe = n.replace(/[^a-zA-Z0-9_-]/g, "");
    const dir = path.join(OUT_DIR, safe + "_ckpt", "best");
    if (!fs.existsSync(path.join(dir, "adapter_model.safetensors"))) return { ok: false, error: "no checkpoint for " + safe };
    args.push("--ckpt", dir);
  }
  return runCompareScript<AdapterDelta>(args);
}

// Same delta computation, but across every step_N snapshot a run saved (--snapshot_every
// during training) — layer x module x TIME, not just a final-state comparison.
export async function adapterEvolution(name: string): Promise<{ ok: true; result: AdapterEvolution } | { ok: false; error: string }> {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(OUT_DIR, safe + "_ckpt");
  if (!fs.existsSync(dir)) return { ok: false, error: "no checkpoint dir for " + safe };
  const r = await runCompareScript<AdapterEvolution>(["--evolution", dir]);
  if (!r.ok) return r;
  if (!r.results.length) return { ok: false, error: "no snapshots found" };
  return { ok: true, result: r.results[0] };
}

export type ExperimentRecord = {
  name: string;
  status: "queued" | "running" | "done" | "failed" | "stopped";
  createdAt: number;
  updatedAt: number;
  base: string;
  mode: "raw" | "sft" | "hqq";
  steps: number;
  lr: number;
  targetLoss: number;
  patience?: number;
  valFrac?: number;
  block?: number;
  autoBench?: string[];
  dataset: { name: string; sha256: string; bytes: number; rows: number | null } | null;
  model?: string | null;
  error?: string;
};

const experimentPath = (name: string) => path.join(EXPERIMENTS_DIR, name + ".json");

function saveExperiment(record: ExperimentRecord) {
  try { fs.writeFileSync(experimentPath(record.name), JSON.stringify(record, null, 2)); } catch {}
}

function updateExperiment(name: string, patch: Partial<ExperimentRecord>) {
  try {
    const current = JSON.parse(fs.readFileSync(experimentPath(name), "utf8")) as ExperimentRecord;
    saveExperiment({ ...current, ...patch, updatedAt: Date.now() });
  } catch {}
}

export function listExperiments(): ExperimentRecord[] {
  const runs = new Map(listTrainRuns().map((run) => [run.name, run]));
  const out: ExperimentRecord[] = [];
  try {
    for (const file of fs.readdirSync(EXPERIMENTS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(EXPERIMENTS_DIR, file), "utf8")) as ExperimentRecord;
        const run = runs.get(record.name);
        if (run && run.status !== record.status) record.status = run.status as ExperimentRecord["status"];
        out.push(record);
        runs.delete(record.name);
      } catch {}
    }
  } catch {}
  // Training launched from the CLI predates manifests. Keep it visible rather
  // than presenting the Library as though those runs do not exist.
  for (const run of runs.values()) {
    out.push({
      name: run.name,
      status: run.status as ExperimentRecord["status"],
      createdAt: run.ts,
      updatedAt: run.ts,
      base: "unknown (legacy run)", mode: "raw", steps: run.lastStep, lr: 0, targetLoss: 0,
      dataset: null,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function startTrain(o: { name: string; base: string; steps: number; lr: number; text?: string; targetLoss?: number; patience?: number; mode?: "raw" | "sft" | "hqq"; dataFile?: string; valFrac?: number; block?: number; autoBench?: string[]; snapshotEvery?: number; noProbeEmbed?: boolean }) {
  if (train.running) return { error: "already training: " + train.running };
  const name = (o.name || "model").replace(/[^a-zA-Z0-9_-]/g, "") || "model";
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const mode = o.mode === "sft" ? "sft" : o.mode === "hqq" ? "hqq" : "raw";
  let dataPath: string;
  if (mode === "sft" || mode === "hqq") {
    // SFT / HQQ train on an EXISTING .jsonl (instruction/thought_process/output)
    const safe = path.basename(o.dataFile || "").replace(/[^a-zA-Z0-9_.-]/g, "");
    dataPath = path.join(DATA_DIR, safe);
    if (!safe.endsWith(".jsonl") || !fs.existsSync(dataPath)) return { error: "data file not found: " + safe };
  } else {
    dataPath = path.join(DATA_DIR, name + ".txt");
    fs.writeFileSync(dataPath, o.text || "");
  }
  const data = datasetInfo(path.basename(dataPath));
  saveExperiment({
    name,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    base: o.base,
    mode,
    steps: o.steps,
    lr: o.lr,
    targetLoss: o.targetLoss ?? 0.1,
    ...(o.patience != null ? { patience: o.patience } : {}),
    ...(o.valFrac != null ? { valFrac: o.valFrac } : {}),
    ...(o.block != null ? { block: o.block } : {}),
    ...(o.autoBench?.length ? { autoBench: o.autoBench } : {}),
    dataset: data ? { name: data.name, sha256: data.sha256, bytes: data.bytes, rows: data.rows } : null,
  });
  try { srv.proc?.kill("SIGKILL"); } catch {}            // free the GPU (single-tenant)
  try { execSync(`pkill -9 -f "llama-server.*--port ${SERVE_PORT}"`); } catch {}
  srv.proc = null; srv.model = null;
  await unloadOllamaAll(); srv.ollamaModel = null;       // 12B teacher resident -> trainer load = OOM

  const ws = fs.createWriteStream(path.join(OUT_DIR, name + ".train.log"));
  train.running = name; train.ws = ws; train.stopping = false; train.proc = null;

  const script = mode === "hqq" ? FINETUNE_HQQ : mode === "sft" ? FINETUNE_SFT : FINETUNE;
  const args = [script, "--base", o.base, "--data", dataPath,
    "--out", path.join(OUT_DIR, name), "--steps", String(o.steps), "--lr", String(o.lr),
    "--target_loss", String(o.targetLoss ?? 0.1), "--merge"];
  if (o.patience != null) args.push("--patience", String(o.patience));
  if ((mode === "sft" || mode === "hqq") && o.valFrac) args.push("--val_frac", String(o.valFrac));
  if ((mode === "sft" || mode === "hqq") && o.block) args.push("--block", String(o.block));
  if (mode === "hqq" && o.snapshotEvery) args.push("--snapshot_every", String(o.snapshotEvery));
  if (mode === "hqq" && o.noProbeEmbed) args.push("--no_probe_embed");

  const runFinetune = (cpu: boolean, done: (code: number | null, errTail: string) => void) => {
    ws.write(JSON.stringify({ event: "phase", phase: cpu ? "fine-tuning (CPU)" : "fine-tuning (GPU)" }) + "\n");
    // SDMA copy engine page-faults on this RDNA2 card (kernel: "Faulty UTCL2 client
    // ID: SDMA0" during layer transfers) — route copies through compute queues instead.
    // expandable_segments avoids the fragmentation-driven OOM victory6-8b hit at step 730
    // (crash reported "6.70 GiB allocated... 408MB reserved but unallocated" — a sudden
    // jump from the ~5.7GB steady-state the periodic step log showed right up to the
    // crash, the classic fragmentation signature PyTorch's own error message names this
    // exact fix for) — lets the allocator grow/shrink segments instead of being stuck
    // with fixed-size blocks it can't reuse across different tensor shapes.
    const env: NodeJS.ProcessEnv = { ...process.env, HSA_OVERRIDE_GFX_VERSION: "10.3.0", HSA_ENABLE_SDMA: "0", PYTORCH_HIP_ALLOC_CONF: "expandable_segments:True" };
    if (cpu) { env.HIP_VISIBLE_DEVICES = ""; env.CUDA_VISIBLE_DEVICES = ""; }
    let errTail = "";
    const ft = spawn(VENV_PY, args, { cwd: ROOT, env });
    train.proc = ft;
    ft.stdout.on("data", (d: Buffer) => { for (const l of d.toString().split("\n")) if (l.trim().startsWith("{")) ws.write(l + "\n"); });
    ft.stderr.on("data", (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2000); });
    ft.on("close", (code) => { if (!train.stopping) done(code, errTail); });
  };

  // After conversion the training python has exited (GPU free), so benching can
  // serve the fresh GGUF. Failures per-suite are telemetry, not run failures.
  const autoBench = async (model: string) => {
    for (const suiteName of o.autoBench || []) {
      if (train.stopping) return;
      ws.write(JSON.stringify({ event: "phase", phase: `auto-bench: ${suiteName}` }) + "\n");
      try {
        const stored = getSuite(suiteName);
        const items = stored?.items?.length ? stored.items : SUITES[suiteName];
        if (!items?.length) { ws.write(JSON.stringify({ event: "bench", suite: suiteName, error: "suite not found" }) + "\n"); continue; }
        const opts = { grade: stored?.grade, maxTokens: stored?.maxTokens, think: stored?.think };
        const result = await runBench(model, items, opts);
        saveBench(suiteName, { ...result, suite: suiteName });
        ws.write(JSON.stringify({ event: "bench", suite: suiteName, score: result.score, total: result.total, tokSec: result.tokSec }) + "\n");
      } catch (e) {
        ws.write(JSON.stringify({ event: "bench", suite: suiteName, error: (e as Error).message.slice(0, 200) }) + "\n");
      }
    }
    stopServing(); // leave the GPU free after benching
  };

  const convert = () => {
    ws.write(JSON.stringify({ event: "phase", phase: "converting to GGUF" }) + "\n");
    const gguf = path.join(MODELS_DIR, name + "-f16.gguf");
    const cv = spawn(VENV_PY, [CONVERT, path.join(OUT_DIR, name), "--outfile", gguf, "--outtype", "f16"], { cwd: ROOT });
    train.proc = cv;
    cv.on("close", (c2) => {
      if (train.stopping) return;
      const ok = c2 === 0 && fs.existsSync(gguf);
      const finish = () => {
        ws.write(JSON.stringify({ event: "done", ok, model: ok ? name : null }) + "\n");
        ws.end(); train.running = null; train.proc = null; train.ws = null;
        updateExperiment(name, { status: ok ? "done" : "failed", model: ok ? name : null, ...(ok ? {} : { error: "GGUF conversion failed" }) });
      };
      if (!ok) { finish(); return; }
      // f16 of a 4B is 8GB, of an 8B 16GB — both spill the 8GB card. Quantize to
      // Q4_K_M so serving/benching use a VRAM-resident file (modelFile prefers -q4).
      // Quantize failure is non-fatal: the f16 still serves via the offload ladder.
      ws.write(JSON.stringify({ event: "phase", phase: "quantizing to Q4_K_M" }) + "\n");
      const q4 = path.join(MODELS_DIR, name + "-q4.gguf");
      const qz = spawn(QUANTIZE, [gguf, q4, "Q4_K_M"], { cwd: ROOT, env: { ...process.env, LD_LIBRARY_PATH: LLAMA_DIR } });
      train.proc = qz;
      qz.on("close", (c3) => {
        if (train.stopping) return;
        if (c3 !== 0 || !fs.existsSync(q4)) {
          try { fs.unlinkSync(q4); } catch {}   // never leave a truncated q4 that would out-prefer the f16
          ws.write(JSON.stringify({ event: "phase", phase: "quantize failed — keeping f16" }) + "\n");
        }
        if (o.autoBench?.length) autoBench(name).finally(finish);
        else finish();
      });
    });
  };

  const fail = (err: string) => {
    const last = err.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0] || "unknown error";
    ws.write(JSON.stringify({ event: "error", msg: last.slice(0, 300) }) + "\n");
    ws.end(); train.running = null; train.proc = null; train.ws = null;
    updateExperiment(name, { status: "failed", error: last.slice(0, 300) });
  };

  runFinetune(false, (code, err) => {
    if (code === 0) { convert(); return; }
    fail(err || "GPU training failed — check VRAM (training never falls back to CPU)");
  });
  return { started: true, name };
}
