// Local AI Lab backend: model discovery, llama.cpp/Vulkan serving, file storage.
// Independent of Ollama's daemon (reuses its GGUF files read-only).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, ChildProcess, execSync } from "node:child_process";

const ROOT = path.resolve(process.cwd(), "..");
export const MODELS_DIR = path.join(ROOT, "models");
const LLAMA_DIR = path.join(ROOT, "llama", "llama-b9835");
const LLAMA_SERVER = path.join(LLAMA_DIR, "llama-server");
const OLLAMA_STORE = "/usr/share/ollama/.ollama/models";
const DATA = path.join(process.cwd(), ".data");
const CONVOS_DIR = path.join(DATA, "conversations");
const SETTINGS_FILE = path.join(DATA, "settings.json");
export const SERVE_PORT = 8099;
fs.mkdirSync(CONVOS_DIR, { recursive: true });

export type Options = {
  num_ctx: number; num_predict: number; num_gpu: number | null;
  temperature: number; top_p: number; top_k: number; repeat_penalty: number;
};
export const DEFAULT_OPTIONS: Options = {
  num_ctx: 8192, num_predict: -1, num_gpu: null,
  temperature: 0.6, top_p: 0.9, top_k: 40, repeat_penalty: 1.1,
};
type SettingsFile = { model?: string; options?: Partial<Options>; system?: string; web?: boolean; groundDocs?: boolean };

export function readSettings() {
  let s: SettingsFile = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  const models = allModels();
  const model = s.model && models.find((m) => m.name === s.model) ? s.model! : models[0]?.name ?? "";
  return { model, options: { ...DEFAULT_OPTIONS, ...(s.options || {}) }, system: s.system ?? "", web: !!s.web, groundDocs: !!s.groundDocs };
}
export function writeSettings(patch: SettingsFile) {
  let s: SettingsFile = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  if (patch.model !== undefined) s.model = patch.model;
  if (patch.system !== undefined) s.system = patch.system;
  if (patch.web !== undefined) s.web = patch.web;
  if (patch.groundDocs !== undefined) s.groundDocs = patch.groundDocs;
  if (patch.options) s.options = { ...(s.options || {}), ...patch.options };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  return s;
}

export function modelFile(name: string): string | null {
  const p = path.join(MODELS_DIR, name + "-f16.gguf");
  return fs.existsSync(p) ? p : null;
}
export function deleteModel(name: string) {
  const p = path.join(MODELS_DIR, name + "-f16.gguf");
  if (servingModel() === name) stopServing();
  try { fs.unlinkSync(p); } catch {}
}

export type ModelInfo = { name: string; source: "local" | "ollama"; path: string; gb: number };
export function allModels(): ModelInfo[] {
  const out: ModelInfo[] = [];
  try {
    for (const f of fs.readdirSync(MODELS_DIR))
      if (f.endsWith("-f16.gguf")) {
        const p = path.join(MODELS_DIR, f);
        out.push({ name: f.slice(0, -"-f16.gguf".length), source: "local", path: p, gb: +(fs.statSync(p).size / 1e9).toFixed(1) });
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
type Srv = { proc: ChildProcess | null; model: string | null };
const g = globalThis as unknown as { __lab_srv?: Srv };
if (!g.__lab_srv) g.__lab_srv = { proc: null, model: null };
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

export async function ensureServing(model: string): Promise<void> {
  if (srv.model === model && srv.proc && srv.proc.exitCode === null && (await health())) return;
  try { srv.proc?.kill("SIGKILL"); } catch {}
  try { execSync(`pkill -9 -f "llama-server.*--port ${SERVE_PORT}"`); } catch {}
  srv.proc = null; srv.model = null;
  const mi = allModels().find((m) => m.name === model);
  if (!mi) throw new Error("model not found: " + model);
  const o = readSettings().options;
  const ngl = o.num_gpu == null ? 99 : o.num_gpu;
  const proc = spawn(LLAMA_SERVER,
    ["-m", mi.path, "-ngl", String(ngl), "--host", "127.0.0.1", "--port", String(SERVE_PORT), "-c", String(o.num_ctx || 8192)],
    { env: { ...process.env, LD_LIBRARY_PATH: LLAMA_DIR }, stdio: "ignore" });
  srv.proc = proc; srv.model = model;
  for (let i = 0; i < 240; i++) {
    if (proc.exitCode !== null) { srv.model = null; throw new Error("llama-server exited (try lowering GPU layers)"); }
    if (await health()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("llama-server start timeout");
}

// ---- conversation storage ----
export type Convo = { id: string; title: string; ts: number; messages: { role: string; content: string }[] };
export function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
export function listConvos() {
  const out: { id: string; title: string; updatedAt: number }[] = [];
  try {
    for (const f of fs.readdirSync(CONVOS_DIR))
      if (f.endsWith(".json")) {
        try { const c = JSON.parse(fs.readFileSync(path.join(CONVOS_DIR, f), "utf8")); out.push({ id: c.id, title: c.title || "chat", updatedAt: c.ts || 0 }); } catch {}
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

// ---- benchmark harness (auto-graded; qualify a model before/after training) ----
export type BenchItem = { cat: string; q: string; a: string[] };
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

export async function runBench(model: string, items = BENCH_SUITE) {
  await ensureServing(model);
  const results: { cat: string; q: string; ok: boolean; got: string }[] = [];
  let totalTokSec = 0, n = 0;
  for (const it of items) {
    const t0 = Date.now();
    let got = "";
    try {
      const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: it.q }], temperature: 0, max_tokens: 40 }),
      });
      const j = await r.json();
      got = j.choices?.[0]?.message?.content || "";
      const dt = (Date.now() - t0) / 1000;
      const toks = (j.usage?.completion_tokens) || got.split(/\s+/).length;
      if (dt > 0) { totalTokSec += toks / dt; n++; }
    } catch {}
    const low = got.toLowerCase();
    results.push({ cat: it.cat, q: it.q, ok: it.a.some((x) => low.includes(x.toLowerCase())), got: got.slice(0, 80) });
  }
  const cats: Record<string, { ok: number; total: number }> = {};
  for (const r of results) { (cats[r.cat] ||= { ok: 0, total: 0 }); cats[r.cat].total++; if (r.ok) cats[r.cat].ok++; }
  const score = results.filter((r) => r.ok).length;
  return { model, score, total: results.length, cats, tokSec: n ? +(totalTokSec / n).toFixed(1) : null, results };
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
    });
    const html = await r.text();
    const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis)];
    const snips = [...html.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gis)];
    const out: string[] = [];
    for (let i = 0; i < Math.min(5, links.length); i++) {
      let url = links[i][1];
      const m = url.match(/uddg=([^&]+)/);
      if (m) try { url = decodeURIComponent(m[1]); } catch {}
      out.push(`[${i + 1}] ${stripHtml(links[i][2])}\n${stripHtml(snips[i]?.[1] || "")}\n${url}`);
    }
    return out.length ? out.join("\n\n") : "(no results)";
  } catch (e) {
    return "(web search failed: " + (e as Error).message + ")";
  }
}

// ---- training grounds: LoRA fine-tune -> GGUF (reuses scripts/finetune.py) ----
const VENV_PY = path.join(ROOT, ".venv", "bin", "python");
const FINETUNE = path.join(ROOT, "scripts", "finetune.py");
const CONVERT = path.join(ROOT, "llama", "src", "convert_hf_to_gguf.py");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DIR = path.join(ROOT, "out");
export const TRAIN_BASES = ["Qwen/Qwen2.5-0.5B-Instruct", "Qwen/Qwen2.5-1.5B-Instruct"];

const tgg = globalThis as unknown as { __lab_train?: { running: string | null } };
if (!tgg.__lab_train) tgg.__lab_train = { running: null };
const train = tgg.__lab_train;

export function trainStatus(name: string) {
  let rows: unknown[] = [];
  try {
    rows = fs.readFileSync(path.join(OUT_DIR, name + ".train.log"), "utf8")
      .split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  } catch {}
  return { running: train.running, rows };
}

export function listTrainRuns() {
  const out: { name: string; status: string; finalLoss: number | null; lastStep: number; ts: number }[] = [];
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (!f.endsWith(".train.log")) continue;
      const name = f.slice(0, -".train.log".length);
      let rows: Record<string, unknown>[] = [];
      try { rows = fs.readFileSync(path.join(OUT_DIR, f), "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l)); } catch {}
      const last = rows[rows.length - 1] || {};
      const steps = rows.filter((r) => r.event === "step");
      const status = last.event === "done" ? (last.ok ? "done" : "failed") : last.event === "error" ? "failed" : (train.running === name ? "running" : "stopped");
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

export function startTrain(o: { name: string; base: string; steps: number; lr: number; text: string }) {
  if (train.running) return { error: "already training: " + train.running };
  const name = (o.name || "model").replace(/[^a-zA-Z0-9_-]/g, "") || "model";
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, name + ".txt"), o.text || "");
  try { srv.proc?.kill("SIGKILL"); } catch {}            // free the GPU (single-tenant)
  try { execSync(`pkill -9 -f "llama-server.*--port ${SERVE_PORT}"`); } catch {}
  srv.proc = null; srv.model = null;

  const ws = fs.createWriteStream(path.join(OUT_DIR, name + ".train.log"));
  train.running = name;

  const args = [FINETUNE, "--base", o.base, "--data", path.join(DATA_DIR, name + ".txt"),
    "--out", path.join(OUT_DIR, name), "--steps", String(o.steps), "--lr", String(o.lr), "--merge"];

  const runFinetune = (cpu: boolean, done: (code: number | null, errTail: string) => void) => {
    ws.write(JSON.stringify({ event: "phase", phase: cpu ? "fine-tuning (CPU)" : "fine-tuning (GPU)" }) + "\n");
    const env: NodeJS.ProcessEnv = { ...process.env, HSA_OVERRIDE_GFX_VERSION: "10.3.0" };
    if (cpu) { env.HIP_VISIBLE_DEVICES = ""; env.CUDA_VISIBLE_DEVICES = ""; }
    let errTail = "";
    const ft = spawn(VENV_PY, args, { cwd: ROOT, env });
    ft.stdout.on("data", (d: Buffer) => { for (const l of d.toString().split("\n")) if (l.trim().startsWith("{")) ws.write(l + "\n"); });
    ft.stderr.on("data", (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2000); });
    ft.on("close", (code) => done(code, errTail));
  };

  const convert = () => {
    ws.write(JSON.stringify({ event: "phase", phase: "converting to GGUF" }) + "\n");
    const gguf = path.join(MODELS_DIR, name + "-f16.gguf");
    const cv = spawn(VENV_PY, [CONVERT, path.join(OUT_DIR, name), "--outfile", gguf, "--outtype", "f16"], { cwd: ROOT });
    cv.on("close", (c2) => {
      const ok = c2 === 0 && fs.existsSync(gguf);
      ws.write(JSON.stringify({ event: "done", ok, model: ok ? name : null }) + "\n");
      ws.end(); train.running = null;
    });
  };

  const fail = (err: string) => {
    const last = err.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0] || "unknown error";
    ws.write(JSON.stringify({ event: "error", msg: last.slice(0, 300) }) + "\n");
    ws.end(); train.running = null;
  };

  // try GPU; if it fails (usually VRAM busy / OOM), auto-retry on CPU; then convert.
  runFinetune(false, (code, err) => {
    if (code === 0) { convert(); return; }
    const oom = /out of memory|HIP|hip error|alloc|device/i.test(err);
    ws.write(JSON.stringify({ event: "phase", phase: oom ? "GPU busy → retrying on CPU" : "GPU run failed → retrying on CPU" }) + "\n");
    runFinetune(true, (code2, err2) => { if (code2 === 0) convert(); else fail(err2 || err); });
  });
  return { started: true, name };
}
