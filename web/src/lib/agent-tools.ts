// Mini claude code toolset: the workspace file/shell tools plus REPL, web research,
// sub-agents, and vision (routed to Gemma — the local model that can actually see).
// Built on the same Executor contract as tools.ts so runToolLoop and the agentic
// benchmark keep working unchanged.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { makeExecutor, TOOL_DEFS, type Executor, type ToolDef } from "./tools";
import { runToolLoop, type ApproveFn, type ToolLoopEvent, type ToolLoopMsg } from "./toolloop";
import { managedPrompt } from "./lal-prompts";
import { webSearch, servingModel, stopServing, ensureServing, allModels, SERVE_PORT, runsAreLive, startTrain, stopTrain, trainStatus, listTrainRuns, listDataFiles, listSuites, listBench, TRAIN_BASES } from "./lab";
import { projectMemoryDir } from "./memory-paths";
import { searchMemory } from "./memory-pipeline";
import { recordFinding } from "./fact-store";

export const AGENT_TOOL_DEFS: ToolDef[] = [
  ...TOOL_DEFS,
  { type: "function", function: {
    name: "install_dependencies", description: "Install the dependencies declared in this workspace's package.json. Use only after writing or inspecting package.json; it runs npm install with network access outside the isolated shell, has a five-minute limit, and is approval-gated.",
    parameters: { type: "object", properties: {}, required: [] },
  } },
  { type: "function", function: {
    name: "run_python", description: "Run a Python snippet in the workspace (fresh interpreter, 30s CPU limit, stdout+stderr returned). Use for calculations, data processing, quick scripts.",
    parameters: { type: "object", properties: { code: { type: "string", description: "python source to execute" } }, required: ["code"] },
  } },
  { type: "function", function: {
    name: "web_search", description: "Search the web (DuckDuckGo). Returns the top results with titles, snippets and URLs — snippets are for judging which result is worth opening, NOT a substitute for reading it. If a result's snippet looks relevant to the question, call web_fetch on its URL before answering; only answer from snippets alone for trivial results (e.g. confirming a name/spelling) where the specific fact you need isn't in question.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  } },
  { type: "function", function: {
    name: "web_fetch", description: "Fetch a URL and return its readable text content (HTML stripped, capped). Use this on any web_search result whose snippet matches what you're trying to answer — this is how you confirm a fact rather than guess from a one-line snippet.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  } },
  { type: "function", function: {
    name: "describe_image", description: "Look at an image file in the workspace and describe it (vision handled by a local vision model). Use for screenshots, photos, diagrams.",
    parameters: { type: "object", properties: { path: { type: "string", description: "image file path relative to workspace" }, question: { type: "string", description: "optional: what to look for" } }, required: ["path"] },
  } },
  { type: "function", function: {
    name: "memory_read", description: "Read your standing project memory — small, durable notes that persist across separate sessions on this project (unlike the conversation, which starts fresh each time). Three blocks: \"project_conventions\" (coding style/patterns to follow), \"known_gotchas\" (past mistakes/traps to avoid repeating), \"current_task_state\" (what you're mid-way through). Omit `block` or pass \"all\" to read everything at once.",
    parameters: { type: "object", properties: {
      block: { type: "string", enum: ["project_conventions", "known_gotchas", "current_task_state", "all"], description: "which block to read; defaults to all" },
    }, required: [] },
  } },
  { type: "function", function: {
    name: "memory_write", description: "Write to your standing project memory (see memory_read). Each block is capped (~1000 tokens) — if you exceed it, the OLDEST content is dropped to make room, so keep entries concise and prune stale ones yourself rather than letting them get silently trimmed. Use \"replace\" to rewrite a block fully, \"append\" to add a new note to the end.",
    parameters: { type: "object", properties: {
      block: { type: "string", enum: ["project_conventions", "known_gotchas", "current_task_state"], description: "which block to write" },
      content: { type: "string", description: "the content to write or append" },
      mode: { type: "string", enum: ["replace", "append"], description: "default: replace" },
    }, required: ["block", "content"] },
  } },
  { type: "function", function: {
    name: "memory_search", description: "Search past session history on this project (a larger, retrieved-on-demand archive, distinct from the small always-visible memory_read blocks) — use it when you want to check whether you've touched a file or made a decision in an earlier, separate session.",
    parameters: { type: "object", properties: {
      query: { type: "string", description: "what to search for" },
    }, required: ["query"] },
  } },
  { type: "function", function: {
    name: "record_finding", description: "Orchestrator mode only: record a finding into your shared findings store (deduped/merged automatically, so repeated or overlapping facts don't pile up). Use this instead of writing directly to findings.md for anything you discover yourself (e.g. via read_file) rather than through a spawn_agent report, which gets recorded automatically.",
    parameters: { type: "object", properties: {
      fact: { type: "string", description: "the finding to record" },
    }, required: ["fact"] },
  } },
  // ---- training grounds control (the lab's train/bench machinery, driven from chat) ----
  { type: "function", function: {
    name: "list_models", description: "List every model available on this machine (locally trained GGUFs and Ollama-pulled ones) with size, plus which one is currently loaded on the GPU.",
    parameters: { type: "object", properties: {}, required: [] },
  } },
  { type: "function", function: {
    name: "list_data_files", description: "List the training data files in the lab's data/ directory (.txt for raw next-token training, .jsonl for instruction SFT), with sizes.",
    parameters: { type: "object", properties: {}, required: [] },
  } },
  { type: "function", function: {
    name: "list_train_runs", description: "List past and current fine-tuning runs with status (running/done/failed/stopped), last step, and final loss.",
    parameters: { type: "object", properties: {}, required: [] },
  } },
  { type: "function", function: {
    name: "train_status", description: "Live status of a training run by name: recent progress rows (step/loss/val) from its log. Works while training is in progress — it only reads log files, never the GPU.",
    parameters: { type: "object", properties: { name: { type: "string", description: "run name, e.g. victory9-8b" } }, required: ["name"] },
  } },
  { type: "function", function: {
    name: "train_start", description: "Start a LoRA fine-tune on this machine's GPU. IMPORTANT: the GPU is single-tenant — training unloads the chat model, so the run is scheduled to begin right after your current reply finishes, and the user cannot chat with a local model until it completes. Make this your LAST tool call of the turn, then tell the user training is scheduled and how to watch it (/train page, or ask for train_status later). Modes: 'hqq' (4-bit, required for 3B+ bases on this 8GB card), 'sft' (fp16 instruction SFT, ≤2B), 'raw' (plain next-token on a .txt). Known-good recipe on this box: mode hqq, block 1536, val_frac 0.1, patience 500.",
    parameters: { type: "object", properties: {
      name: { type: "string", description: "name for the run/output model, e.g. victory10-8b" },
      // NOTE: this description must stay a static literal — agent-tools.ts sits in
      // an import cycle with lab.ts (lab → graders → agent-tools → lab), so lab's
      // consts (TRAIN_BASES) are in temporal-dead-zone while this array evaluates.
      // The run() handler validates against the real TRAIN_BASES at call time and
      // returns the full list on a miss.
      base: { type: "string", description: "base model checkpoint, e.g. Qwen/Qwen3-8B, Qwen/Qwen3-4B, Qwen/Qwen3-1.7B (an invalid value is rejected with the full allowed list)" },
      data_file: { type: "string", description: ".jsonl in data/ for sft/hqq mode (see list_data_files); omit for raw mode" },
      text: { type: "string", description: "raw training text (raw mode only, written to data/<name>.txt)" },
      steps: { type: "number", description: "training steps, e.g. 3000" },
      lr: { type: "number", description: "learning rate, e.g. 0.00005" },
      mode: { type: "string", enum: ["raw", "sft", "hqq"], description: "training mode (default hqq for 4B/8B bases)" },
      val_frac: { type: "number", description: "validation split fraction, e.g. 0.1 (sft/hqq)" },
      block: { type: "number", description: "token block size, e.g. 1536 (sft/hqq)" },
      auto_bench: { type: "array", items: { type: "string" }, description: "suite ids to auto-bench after training (see bench_list), e.g. [\"coding\",\"planning\"]" },
      specialist_role: { type: "string", enum: ["coordinator_planner", "coder_repairer", "verifier"], description: "optional HIVE role; requires Qwen3-4B HQQ and an immutable role dataset manifest" },
      dataset_manifest: { type: "string", description: "manifest filename in data/ produced by build_hive_role_dataset.py" },
      runtime_base_model: { type: "string", description: "installed GGUF shared by the adapters; defaults to qwen3-4b-stock for Qwen3-4B" },
    }, required: ["name", "base", "steps", "lr"] },
  } },
  { type: "function", function: {
    name: "train_stop", description: "Stop the currently running fine-tune (kills the trainer process; the merge/GGUF/bench pipeline will NOT run). Check list_train_runs first if unsure what's running.",
    parameters: { type: "object", properties: {}, required: [] },
  } },
  { type: "function", function: {
    name: "bench_list", description: "List the benchmark suites (id, label, item count, categories) available for auto-benching and comparison.",
    parameters: { type: "object", properties: {}, required: [] },
  } },
  { type: "function", function: {
    name: "bench_results", description: "Stored benchmark results: suite, model, score/total, tok/s, and whether the result is a pinned baseline. Use to compare a fresh model against the champion.",
    parameters: { type: "object", properties: { suite: { type: "string", description: "optional: only results for this suite id" }, model: { type: "string", description: "optional: only results for this model" } }, required: [] },
  } },
  { type: "function", function: {
    name: "spawn_agent", description: "Delegate a self-contained subtask to a helper agent that has the same file/web/python tools (but cannot spawn further agents). It works autonomously and returns a final report. Good for research questions or exploring a codebase corner while you continue the main plan. Optionally hand the task to a DIFFERENT local model via `model` (e.g. a small fast one for research/extraction, a strong one for implementation, a different one for independent red-team critique) — this machine has one GPU, so a different model means a real reload (seconds to ~a minute); batch several spawns on the same model consecutively rather than alternating models call-by-call. Omit `model` to reuse whatever is already serving (zero swap cost).",
    parameters: { type: "object", properties: {
      task: { type: "string", description: "complete, self-contained instructions for the helper — it sees nothing else, so include exact paths/goals/deliverable" },
      model: { type: "string", description: "optional: name of a different local model to run this subtask on (see available models)" },
      max_rounds: { type: "number", description: "optional: tool-call round budget for the helper (1-20, default 10)" },
    }, required: ["task"] },
  } },
];

function installDependencies(root: string): Promise<string> {
  return new Promise((resolve) => {
    if (!fs.existsSync(path.join(root, "package.json"))) { resolve("error: package.json is required before installing dependencies"); return; }
    let output = ""; let settled = false;
    const child = spawn("npm", ["install"], { cwd: root, env: { ...process.env, CI: "1", NO_COLOR: "1" } });
    const append = (chunk: Buffer) => { if (output.length < 30_000) output += chunk.toString(); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const finish = (suffix = "") => { if (settled) return; settled = true; clearTimeout(timer); resolve((output + suffix).slice(-30_000)); };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish("\n[timed out after 5m]"); }, 300_000);
    child.on("close", (code) => finish(`\n[exit ${code}]`));
    child.on("error", (error) => finish("\nerror: " + error.message));
  });
}

// Training/bench control stays with the TOP-LEVEL agent only: helper sub-agents,
// planner/implementer phases, and orchestrator mode must never fire a training run
// (same "remove the option" principle as those restrictions themselves — the
// PLANNER/IMPLEMENTER/ORCHESTRATOR allowlists exclude these by construction).
const TRAINING_TOOLS = new Set(["list_models", "list_data_files", "list_train_runs", "train_status", "train_start", "train_stop", "bench_list", "bench_results"]);
const SUB_TOOL_DEFS = AGENT_TOOL_DEFS.filter((t) => t.function.name !== "spawn_agent" && !TRAINING_TOOLS.has(t.function.name));

function runPython(root: string, code: string): Promise<string> {
  return new Promise((resolve) => {
    const cap = 16384;
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("bash", ["-c", "ulimit -t 30 -v 2097152 -f 4096; exec python3 -"], { cwd: root, detached: true });
    } catch (e) { resolve("error: " + (e as Error).message); return; }
    child.stdin?.write(code);
    child.stdin?.end();
    const append = (d: Buffer) => { if (out.length < cap) out += d.toString(); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let done = false;
    const finish = (msg: string) => { if (done) return; done = true; clearTimeout(timer); resolve(msg.slice(0, cap)); };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      finish(out + "\n[timed out after 35s]");
    }, 35000);
    child.on("close", (code2) => finish(out + (code2 ? `\n[exit ${code2}]` : "")));
    child.on("error", (e) => finish("error: " + e.message));
  });
}

function stripTags(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n").trim();
}

export async function webFetch(url: string): Promise<string> {
  try {
    if (!/^https?:\/\//i.test(url)) return "error: only http(s) URLs";
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const type = r.headers.get("content-type") || "";
    const body = await r.text();
    if (!type.includes("html")) return body.slice(0, 12000);
    // Readability (Firefox Reader View's engine) finds the actual article and
    // strips nav/header/footer/sidebar chrome — a flat tag-strip alone left a
    // real page's ENTIRE 8k budget consumed by nav menus and table-of-contents
    // links before a single sentence of content, e.g. every Wikipedia fetch.
    // Falls back to the flat strip for non-article pages (listings, homepages)
    // where Readability can't identify a main content region.
    try {
      const { parseHTML } = await import("linkedom");
      const { Readability } = await import("@mozilla/readability");
      const { document } = parseHTML(body, { location: url });
      const article = new Readability(document).parse();
      const text = article?.textContent?.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n").trim();
      if (text) return ((article!.title ? article!.title + "\n\n" : "") + text).slice(0, 8000);
    } catch { /* fall through to flat strip */ }
    // 8k, not more: several fetches must fit the loop's 16k serving context together
    // with the system prompt and tool defs — oversized results starve later rounds.
    return stripTags(body).slice(0, 8000) || "(empty page)";
  } catch (e) {
    return "error: fetch failed — " + (e as Error).message;
  }
}

// Vision routes to Gemma via Ollama (user decision: it's the local model that can see).
// GPU is single-tenant: if our llama-server holds VRAM, park it first and restore after
// (cross-backend OOM took the whole machine out once — HANDOFF bug #1).
const VISION_MODEL = "gemma4:12b";
async function describeImage(root: string, rel: string, question?: string): Promise<string> {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) return "error: path escapes workspace";
  if (!fs.existsSync(p)) return "error: file not found: " + rel;
  if (fs.statSync(p).size > 12 * 1024 * 1024) return "error: image too large (>12MB)";
  const b64 = fs.readFileSync(p).toString("base64");
  const parked = servingModel();
  if (parked) stopServing();
  try {
    const r = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL, stream: false, keep_alive: 0,
        messages: [{ role: "user", content: question || "Describe this image in detail. Transcribe any text in it.", images: [b64] }],
        options: { temperature: 0.2, num_predict: 800 },
      }),
      signal: AbortSignal.timeout(300000),
    });
    const j = await r.json();
    return j.message?.content || "error: vision model returned nothing" + (j.error ? " (" + j.error + ")" : "");
  } catch (e) {
    return "error: vision call failed — " + (e as Error).message;
  } finally {
    if (parked) { try { await ensureServing(parked); } catch { /* next round will surface it */ } }
  }
}

// Runs `fn` against `model`, parking whatever's currently served and restoring it
// after — same park/restore shape as describeImage above, generalized for
// spawn_agent's optional model override. The caller (spawn_agent) is blocked on
// this call, so it's safe for the swap to kill/reload the single shared
// llama-server: no other request can race it mid-swap.
async function withModelServed<T>(model: string, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const parked = servingModel();
  const mi = allModels().find((m) => m.name === model);
  let baseUrl: string;
  try {
    await ensureServing(model, 16384);
    baseUrl = `http://127.0.0.1:${SERVE_PORT}`;
  } catch (e) {
    if (mi?.source === "ollama") { stopServing(); baseUrl = "http://127.0.0.1:11434"; }
    else throw e;
  }
  try {
    return await fn(baseUrl);
  } finally {
    if (parked) {
      try { await ensureServing(parked, 16384); }
      catch (e) { throw new Error(`failed to restore model "${parked}" after swap: ${(e as Error).message}`); }
    }
  }
}

// A sub-agent's raw report can run long; rather than pay a second model swap to
// digest it (round-trip cost on this box is seconds-to-a-minute each way), compress
// it with ONE non-streaming call against whichever model is already resident right
// now (the sub model, pre-restore) — free, since nothing is loading/unloading.
async function digestReport(baseUrl: string, model: string, report: string): Promise<string> {
  try {
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, stream: false, temperature: 0, max_tokens: 512,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{
          role: "user",
          content: "Compress the following sub-agent report to its essential findings, changes, and next steps in at most 300 words. Keep exact file paths and error messages verbatim. Report:\n\n" + report,
        }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    return text || report.slice(0, 2400);
  } catch {
    return report.slice(0, 2400) + "\n[...truncated — digest call failed]";
  }
}

export type AgentExecutor = Executor & { defs: ToolDef[] };

// Core-memory blocks (Letta-inspired): a handful of small, labeled, agent-editable
// files that persist across separate /code sessions on the same project — unlike the
// conversation transcript, which starts fresh every time. Fixed whitelist (not a raw
// path) so the tool can enforce a size cap `write_file` doesn't know about.
const MEMORY_BLOCKS = ["project_conventions", "known_gotchas", "current_task_state"] as const;
type MemoryBlock = typeof MEMORY_BLOCKS[number];
const MEMORY_BLOCK_CAP = 4000; // bytes, ~1000 tokens; keeps 3 blocks well under the ~1500-token target

function memoryBlockPath(root: string, block: MemoryBlock): string {
  return path.join(projectMemoryDir(root), block + ".md");
}

function memoryRead(root: string, blockArg?: string): string {
  const requested = !blockArg || blockArg === "all" ? MEMORY_BLOCKS : [blockArg as MemoryBlock];
  if (blockArg && blockArg !== "all" && !MEMORY_BLOCKS.includes(blockArg as MemoryBlock)) {
    return `error: unknown block "${blockArg}" — must be one of ${MEMORY_BLOCKS.join(", ")}, or "all"`;
  }
  const parts: string[] = [];
  for (const b of requested) {
    let content = "";
    try { content = fs.readFileSync(memoryBlockPath(root, b), "utf8").trim(); } catch { /* not written yet */ }
    parts.push(`--- ${b} ---\n` + (content || "(empty)"));
  }
  return parts.join("\n\n");
}

// FIFO-trim from the OLDEST end (top) rather than truncating the newest write or
// silently growing forever — the newest content is what the model just decided
// mattered, so it should never be the part that gets dropped.
function memoryWrite(root: string, block: string, content: string, mode: string): string {
  if (!MEMORY_BLOCKS.includes(block as MemoryBlock)) {
    return `error: unknown block "${block}" — must be one of ${MEMORY_BLOCKS.join(", ")}`;
  }
  const p = memoryBlockPath(root, block as MemoryBlock);
  let existing = "";
  if (mode === "append") { try { existing = fs.readFileSync(p, "utf8"); } catch { /* new file */ } }
  let next = mode === "append" && existing.trim() ? existing.trimEnd() + "\n\n" + content : content;
  let trimmed = false;
  while (Buffer.byteLength(next, "utf8") > MEMORY_BLOCK_CAP) {
    const lines = next.split("\n");
    if (lines.length <= 1) { next = next.slice(next.length - MEMORY_BLOCK_CAP); break; } // single huge line — hard cut, last resort
    lines.shift();
    next = lines.join("\n");
    trimmed = true;
  }
  fs.writeFileSync(p, next);
  return trimmed
    ? `wrote ${block} (${Buffer.byteLength(next, "utf8")} bytes — oldest content was trimmed to fit the ${MEMORY_BLOCK_CAP}-byte cap)`
    : `wrote ${block} (${Buffer.byteLength(next, "utf8")} bytes)`;
}

export function makeAgentExecutor(opts: {
  workspaceDir: string;
  baseUrl: string;                 // OpenAI-compatible endpoint serving the agent model
  model: string;
  think?: boolean;
  onEvent: (e: ToolLoopEvent & { agent?: string }) => void;  // sub-agent events are tagged
  depth?: number;
  approve?: ApproveFn;              // propagated to sub-agents so their writes/shell respect user approval too
  orchestratorMode?: boolean;       // true -> spawn_agent auto-records sub-agent findings (see fact-store.ts)
  sandboxShell?: boolean;           // Hive: writable workspace only, hidden home/tmp, no network
  signal?: AbortSignal;             // run-level stop, propagated into spawn_agent's inner loop so
  // Stop kills helper agents mid-flight too (not just the top-level loop)
}): AgentExecutor {
  const base = makeExecutor(opts.workspaceDir, { sandboxShell: opts.sandboxShell });
  const depth = opts.depth ?? 0;
  let subCount = 0;

  async function run(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "install_dependencies":
        return installDependencies(base.root);
      case "run_python":
        return runPython(base.root, String(args.code ?? ""));
      case "web_search":
        return webSearch(String(args.query ?? ""));
      case "web_fetch":
        return webFetch(String(args.url ?? ""));
      case "describe_image":
        return describeImage(base.root, String(args.path ?? ""), args.question ? String(args.question) : undefined);
      case "memory_read":
        return memoryRead(base.root, args.block ? String(args.block) : undefined);
      case "memory_write":
        return memoryWrite(base.root, String(args.block ?? ""), String(args.content ?? ""), String(args.mode ?? "replace"));
      case "memory_search":
        return searchMemory(base.root, String(args.query ?? ""));
      case "record_finding":
        return recordFinding(base.root, opts.baseUrl, opts.model, String(args.fact ?? ""));
      case "list_models": {
        const cur = servingModel();
        const rows = allModels().map((m) => `${m.name}  (${m.source}, ${m.gb}GB)${m.name === cur ? "  ← loaded on GPU" : ""}`);
        return rows.join("\n") || "(no models found)";
      }
      case "list_data_files": {
        const rows = listDataFiles().map((f) => `${f.name}  (${f.kind}, ${(f.chars / 1e6).toFixed(1)}MB)`);
        return rows.join("\n") || "(no data files)";
      }
      case "list_train_runs": {
        const rows = listTrainRuns().map((r) => `${r.name}: ${r.status}, step ${r.lastStep}${r.finalLoss != null ? ", loss " + r.finalLoss : ""}`);
        return rows.slice(0, 40).join("\n") || "(no training runs yet)";
      }
      case "train_status": {
        const s = trainStatus(String(args.name ?? ""));
        const rows = (s.rows as Record<string, unknown>[]).filter((r) => r && typeof r === "object");
        const steps = rows.filter((r) => r.event === "step");
        const tail = [...steps.slice(-5), ...rows.slice(-3).filter((r) => r.event !== "step")];
        return JSON.stringify({ running: s.running, recent: tail }, null, 1).slice(0, 3000);
      }
      case "train_start": {
        if (depth >= 1) return "error: only the top-level agent may start training";
        const name = String(args.name ?? "").trim();
        const bse = String(args.base ?? "").trim();
        if (!name || !bse) return "error: name and base are required";
        if (!TRAIN_BASES.includes(bse)) return "error: unknown base — must be one of: " + TRAIN_BASES.join(", ");
        const o = {
          name, base: bse,
          steps: Math.max(1, Number(args.steps) || 0),
          lr: Number(args.lr) || 5e-5,
          mode: (["raw", "sft", "hqq"].includes(String(args.mode)) ? String(args.mode) : "hqq") as "raw" | "sft" | "hqq",
          dataFile: args.data_file ? String(args.data_file) : undefined,
          text: args.text ? String(args.text) : undefined,
          valFrac: args.val_frac != null ? Number(args.val_frac) : undefined,
          block: args.block != null ? Number(args.block) : undefined,
          autoBench: Array.isArray(args.auto_bench) ? (args.auto_bench as unknown[]).map(String) : undefined,
          specialistRole: ["coordinator_planner", "coder_repairer", "verifier"].includes(String(args.specialist_role)) ? String(args.specialist_role) as "coordinator_planner" | "coder_repairer" | "verifier" : undefined,
          datasetManifest: args.dataset_manifest ? String(args.dataset_manifest) : undefined,
          runtimeBaseModel: args.runtime_base_model ? String(args.runtime_base_model) : undefined,
          targetLoss: 0, // the EMA gate is bs=1-flawed on this box (HANDOFF 2026-07-04); val-aware patience is the stop condition
        };
        if ((o.mode === "sft" || o.mode === "hqq") && !o.dataFile) return "error: sft/hqq mode needs data_file (see list_data_files)";
        if (o.mode === "raw" && !o.text) return "error: raw mode needs text";
        // One GPU: training unloads the chat model, which would kill THIS session
        // mid-reply. Defer the actual start until no run is live (i.e. right after
        // this reply lands), then fire it. 15-minute patience, then give up.
        const t0 = Date.now();
        const timer = setInterval(async () => {
          if (runsAreLive()) {
            if (Date.now() - t0 > 15 * 60e3) clearInterval(timer);
            return;
          }
          clearInterval(timer);
          try { await startTrain(o); } catch { /* outcome visible on /train; nothing left to notify */ }
        }, 5000);
        timer.unref?.();
        return `training run "${name}" is scheduled — it starts as soon as this reply finishes (the chat model unloads then; local chat is unavailable until training completes). Progress: /train page, or train_status/list_train_runs in a later session. Tell the user this now and end your turn.`;
      }
      case "train_stop": {
        if (depth >= 1) return "error: only the top-level agent may stop training";
        const r = stopTrain();
        return r.ok ? `stopped training run "${r.stopped}" (merge/GGUF/bench pipeline skipped)` : "error: " + (r.note || "nothing is training");
      }
      case "bench_list": {
        const rows = listSuites().map((s) => `${s.id}: ${s.label} (${s.count} items)`);
        return rows.join("\n") || "(no suites)";
      }
      case "bench_results": {
        const wantSuite = args.suite ? String(args.suite) : null;
        const wantModel = args.model ? String(args.model) : null;
        const rows = (listBench() as Record<string, unknown>[])
          .filter((r) => (!wantSuite || r.suite === wantSuite) && (!wantModel || r.model === wantModel))
          .map((r) => `${r.suite} / ${r.model}: ${r.score}/${r.total}${r.tokSec ? " · " + r.tokSec + " tok/s" : ""}${r.pinned ? " · pinned" + (r.stale ? " (STALE)" : "") : ""}`);
        return rows.slice(-60).join("\n") || "(no bench results" + (wantSuite || wantModel ? " matching that filter" : "") + ")";
      }
      case "spawn_agent": {
        if (depth >= 1) return "error: helper agents cannot spawn further agents";
        const task = String(args.task ?? "").trim();
        if (!task) return "error: empty task";
        const reqModel = args.model ? String(args.model) : undefined;
        const maxRounds = Math.max(1, Math.min(20, Number(args.max_rounds) || 10));
        const agentId = "helper-" + (++subCount);
        const tagged = (e: ToolLoopEvent) => opts.onEvent({ ...e, agent: agentId });
        const messages: ToolLoopMsg[] = [
          { role: "system", content: managedPrompt("helper-agent") },
          { role: "user", content: task },
        ];
        const runSub = async (baseUrl: string, model: string): Promise<string> => {
          const sub = makeAgentExecutor({ ...opts, baseUrl, model, depth: depth + 1, onEvent: tagged });
          const out = await runToolLoop({
            baseUrl, model, messages, tools: SUB_TOOL_DEFS,
            exec: sub, onEvent: tagged,
            maxRounds, maxTokens: 2048, think: opts.think, approve: opts.approve,
            signal: opts.signal,
          });
          const last = out[out.length - 1];
          const report = (last?.role === "assistant" && typeof last.content === "string" && last.content.trim()) || "(helper produced no report)";
          const digested = report.length > 2400 ? await digestReport(baseUrl, model, report) : report;
          // Automatic (primary) hook: growth control happens even if the coordinator
          // never remembers to call record_finding itself — same "restriction/automation
          // beats relying on the model remembering" lesson as the tool-palette fix.
          // Reuses whichever model is already resident (baseUrl/model here, pre-restore)
          // — zero additional swap cost, same design decision digestReport already made.
          if (opts.orchestratorMode) {
            try { await recordFinding(base.root, baseUrl, model, digested); } catch { /* best-effort */ }
          }
          return `[${agentId} report]\n` + digested;
        };
        try {
          if (!reqModel || reqModel === opts.model) return await runSub(opts.baseUrl, opts.model);
          tagged({ k: "model_swap", v: { from: servingModel(), to: reqModel } });
          return await withModelServed(reqModel, (baseUrl) => runSub(baseUrl, reqModel));
        } catch (e) {
          // A user Stop must unwind the WHOLE run, not get reported to the model
          // as a recoverable helper failure it might retry.
          if ((e as Error).name === "AbortError" || opts.signal?.aborted) throw e;
          return "error: helper agent failed — " + (e as Error).message;
        }
      }
      default:
        return base.run(name, args);
    }
  }

  return {
    root: base.root,
    // Inherit the base executor's approval rules (write_file/edit_file/run_shell/git)
    // rather than re-declaring them here — a second hand-copied map is exactly the
    // kind of drift the ORCHESTRATOR_TOOLS comment below warns about for tool lists.
    // Research/python/vision/memory/spawn_agent are sandboxed or read-only — auto-run.
    // Training mutations are approval-gated: they commandeer the single GPU for
    // hours (train_start) or kill an hours-long run (train_stop).
    approve: { ...base.approve, install_dependencies: true, train_start: true, train_stop: true },
    run,
    defs: depth >= 1 ? SUB_TOOL_DEFS : AGENT_TOOL_DEFS,
  };
}

// Orchestrator mode's system prompt tells the model to delegate everything via spawn_agent
// rather than do direct work — tested live and the model ignored it entirely (0 spawn_agent
// calls, 16 direct grep calls in an 18-round session). Prompting alone doesn't work
// (AG2/CrewAI precedent, see docs/orchestration-frameworks-research.md): the fix is removing
// the option, not asking nicer. Keep list/read/write for the coordinator's own note-keeping
// (_orchestrator/*.md per its system prompt) but cut every tool that lets it do the actual
// task directly — grep, run_shell, edit_file, web_*, run_python, describe_image all funnel
// through spawn_agent instead.
//
// Exported (not inlined in route.ts) so the regression-eval guard in graders.ts builds this
// restriction the identical way the live route does — two independent copies of the allow-set
// could silently drift apart and the guard would end up testing the wrong thing.
export const ORCHESTRATOR_TOOLS = new Set(["spawn_agent", "list_files", "read_file", "write_file", "memory_read", "memory_write", "memory_search", "record_finding"]);

export function makeOrchestratorExecutor(fullExec: AgentExecutor): AgentExecutor {
  return {
    root: fullExec.root,
    approve: fullExec.approve,
    defs: fullExec.defs.filter((t) => ORCHESTRATOR_TOOLS.has(t.function.name)),
    run: (name: string, args: Record<string, unknown>) =>
      ORCHESTRATOR_TOOLS.has(name) ? fullExec.run(name, args)
        : Promise.resolve(`error: "${name}" isn't available in orchestrator mode — delegate this via spawn_agent instead.`),
  };
}

// Same lesson as ORCHESTRATOR_TOOLS above, applied to a plan/implement split: a model
// asked nicely to "just plan, don't code yet" or "stop researching and implement" will
// drift back into the wrong mode under its own momentum (this is exactly what happened
// live — gemma4:12b, told repeatedly to implement, spent its whole remaining budget
// re-researching techniques it had already researched hours earlier). Removing the
// option is the fix, not a firmer prompt.
//
// Planner: can look around (including research) but cannot touch code — forces the
// plan to come out as a text reply, never a premature/half-formed edit.
export const PLANNER_TOOLS = new Set(["list_files", "read_file", "read_file_outline", "grep", "web_search", "web_fetch", "memory_read", "memory_write", "memory_search"]);
export function makePlannerExecutor(fullExec: AgentExecutor): AgentExecutor {
  return {
    root: fullExec.root,
    approve: fullExec.approve,
    defs: fullExec.defs.filter((t) => PLANNER_TOOLS.has(t.function.name)),
    run: (name: string, args: Record<string, unknown>) =>
      PLANNER_TOOLS.has(name) ? fullExec.run(name, args)
        : Promise.resolve(`error: "${name}" isn't available while planning — finish and state your plan as a text reply instead of acting on it.`),
  };
}

// Implementer: can read/write/run but has NO research tools and cannot spawn_agent —
// removes the exact escape hatch that let gemma4:12b loop back into research instead
// of coding. If it's unsure of a detail, it has to make a reasonable call and keep
// going, the same way a human implementer works from a design doc without re-opening
// the research phase over every small uncertainty.
export const IMPLEMENTER_TOOLS = new Set(["list_files", "read_file", "read_file_outline", "grep", "write_file", "edit_file", "run_shell", "install_dependencies", "memory_read", "memory_write"]);
export function makeImplementerExecutor(fullExec: AgentExecutor): AgentExecutor {
  return {
    root: fullExec.root,
    approve: fullExec.approve,
    defs: fullExec.defs.filter((t) => IMPLEMENTER_TOOLS.has(t.function.name)),
    run: (name: string, args: Record<string, unknown>) =>
      IMPLEMENTER_TOOLS.has(name) ? fullExec.run(name, args)
        : Promise.resolve(`error: "${name}" isn't available while implementing — you already have the plan, act on it directly instead of researching further.`),
  };
}
