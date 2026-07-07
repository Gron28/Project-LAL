// Grading strategies for the benchmark battery. substring/numeric are the original
// loose-match graders (moved here verbatim); exec/checks/tools are new — coding,
// instruction-following, and agentic-tool-use suites respectively.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { makeExecutor } from "./tools";
import { makeAgentExecutor, makeOrchestratorExecutor, ORCHESTRATOR_TOOLS } from "./agent-tools";
import { runToolLoop, type ToolLoopMsg } from "./toolloop";

export type Check =
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "not_regex"; pattern: string; flags?: string }
  | { type: "max_words"; n: number }
  | { type: "min_words"; n: number }
  | { type: "starts_with"; s: string }
  | { type: "json_valid" }
  | { type: "line_count"; n: number; op?: "eq" | "lte" | "gte" };

export type ToolScenario = {
  files?: Record<string, string>;                                  // seed workspace file tree {relpath: content}
  system?: string;                                                  // optional system prompt for the scenario
  expectedCalls?: { name: string; argsSubset?: Record<string, unknown> }[]; // in order, subset match
  finalFiles?: Record<string, string>;                              // substring match against final file contents
};

// Backward-compatible superset of the original {cat,q,a} shape. `a` is now optional
// (exec/tools suites don't need a gold string) and `grade` overrides the suite default.
export type BenchItem = {
  cat: string;
  q: string;
  a?: string[];
  grade?: "substring" | "numeric" | "exec" | "checks" | "tools" | "webgen" | "orchestrator-guard";
  tests?: string;         // exec: assert statements appended after the extracted solution
  checks?: Check[];       // checks: constraint list, all must pass
  scenario?: ToolScenario; // tools: seeded workspace + expected call sequence
  probes?: string;        // webgen: async JS body run inside the generated page (see gradeWebgen)
};

export function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function lastNumber(s: string): number | null {
  const m = s.replace(/[,$]/g, "").match(/-?\d+(?:\.\d+)?/g);
  return m && m.length ? parseFloat(m[m.length - 1]) : null;
}
export function gradeNumeric(got: string, golds: string[]): boolean {
  const g = lastNumber(got);
  if (g === null) return false;
  return golds.some((x) => { const xv = parseFloat(String(x).replace(/[,$]/g, "")); return !isNaN(xv) && Math.abs(xv - g) < 1e-6; });
}
export function gradeSubstring(got: string, golds: string[]): boolean {
  const low = got.toLowerCase();
  return golds.some((x) => low.includes(x.toLowerCase()));
}

function lastPyFence(s: string): string | null {
  const matches = [...s.matchAll(/```(?:python)?\n([\s\S]*?)```/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

export type GradeResult = { ok: boolean; detail?: string; shot?: string };

// Extract the last ```python fence, run it + the item's asserts in a fresh temp dir
// under a hard resource cap, SIGKILL the whole process group on timeout so nothing
// (infinite loops, fork bombs) survives grading.
export async function gradeExec(got: string, item: BenchItem): Promise<GradeResult> {
  const code = lastPyFence(stripThink(got));
  if (!code) return { ok: false, detail: "no python code fence found" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "labgrade-"));
  try {
    fs.writeFileSync(path.join(dir, "sol.py"), code + "\n\n" + (item.tests || ""));
    const cap = 8192;
    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      let out = "";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("bash", ["-c", "ulimit -t 10 -v 1048576 -f 1024; exec python3 sol.py"], { cwd: dir, detached: true });
      } catch (e) {
        resolve({ code: -1, out: "spawn failed: " + (e as Error).message });
        return;
      }
      const append = (d: Buffer) => { if (out.length < cap) out += d.toString(); };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      let done = false;
      const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out: out.slice(0, cap) }); };
      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch {}
        finish(-1);
      }, 12500);
      child.on("close", (code) => finish(code));
      child.on("error", () => finish(-1));
    });
    return result.code === 0 ? { ok: true } : { ok: false, detail: result.out.slice(0, 400) || `exit ${result.code}` };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

export function gradeChecks(got: string, checks: Check[]): GradeResult {
  const failed: string[] = [];
  for (const c of checks) {
    let pass = true;
    switch (c.type) {
      case "regex": pass = new RegExp(c.pattern, c.flags).test(got); break;
      case "not_regex": pass = !new RegExp(c.pattern, c.flags).test(got); break;
      case "max_words": pass = got.trim().split(/\s+/).filter(Boolean).length <= c.n; break;
      case "min_words": pass = got.trim().split(/\s+/).filter(Boolean).length >= c.n; break;
      case "starts_with": pass = got.trim().startsWith(c.s); break;
      case "json_valid": try { JSON.parse(got.trim()); } catch { pass = false; } break;
      case "line_count": {
        const n = got.trim().split("\n").filter((l) => l.trim()).length;
        pass = c.op === "lte" ? n <= c.n : c.op === "gte" ? n >= c.n : n === c.n;
        break;
      }
    }
    if (!pass) failed.push(c.type);
  }
  return failed.length ? { ok: false, detail: "failed: " + failed.join(",") } : { ok: true };
}

// Agentic suite: seed a scratch workspace from scenario.files, run the exact
// production tool loop/executor (auto-approved for grading), grade on the expected
// call sequence plus optional final-file-state assertions.
export async function gradeTools(
  baseUrl: string, model: string, q: string, scenario: ToolScenario | undefined,
  opts: { think?: boolean; maxTokens?: number } = {}
): Promise<GradeResult> {
  if (!scenario) return { ok: false, detail: "no scenario" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "labtools-"));
  try {
    for (const [rel, content] of Object.entries(scenario.files || {})) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    const exec = makeExecutor(dir);
    const messages: ToolLoopMsg[] = [];
    if (scenario.system) messages.push({ role: "system", content: scenario.system });
    messages.push({ role: "user", content: q });
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    await runToolLoop({
      baseUrl, model, messages, exec, maxRounds: 8,
      // 1536, not 512: reasoning models (qwen3:8b) burn 300+ tokens thinking before the
      // first tool call — a 512 cap scored a stock 8B 0/8 as a pure artifact.
      think: opts.think, maxTokens: opts.maxTokens ?? 1536,
      approve: async () => true,
      onEvent: (e) => { if (e.k === "tool_request") calls.push({ name: e.v.name, args: e.v.args }); },
    });
    const expected = scenario.expectedCalls || [];
    for (let i = 0; i < expected.length; i++) {
      const exp = expected[i];
      const got = calls[i];
      if (!got || got.name !== exp.name) return { ok: false, detail: `call ${i}: expected ${exp.name}, got ${got?.name ?? "(none)"}` };
      if (exp.argsSubset) {
        for (const [k, v] of Object.entries(exp.argsSubset)) {
          if (JSON.stringify(got.args[k]) !== JSON.stringify(v)) return { ok: false, detail: `call ${i} arg ${k} mismatch` };
        }
      }
    }
    for (const [rel, expect] of Object.entries(scenario.finalFiles || {})) {
      let actual = "";
      try { actual = fs.readFileSync(path.join(dir, rel), "utf8"); } catch { return { ok: false, detail: `final file missing: ${rel}` }; }
      if (!actual.includes(expect)) return { ok: false, detail: `final file mismatch: ${rel}` };
    }
    return { ok: true };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ---- orchestrator-guard: does the model actually delegate through the production
// makeOrchestratorExecutor path, or does it silently regress to doing the work itself? ----
// Runs the SAME executor construction the live /code route uses (agent-tools.ts's
// makeAgentExecutor + makeOrchestratorExecutor) rather than the plain makeExecutor gradeTools
// uses — gradeTools structurally cannot exercise spawn_agent/orchestrator restriction at all,
// which is exactly why this suite didn't already catch the live bug (0 spawn_agent calls,
// 16 direct grep calls in an 18-round session) before it shipped. A restriction-only check
// (no forbidden tool called) isn't enough either — a model that's tool-restricted but still
// never delegates would pass that and still be broken (the CrewAI-documented failure mode one
// layer up), so this asserts BOTH zero forbidden calls AND at least one real spawn_agent call.
export async function gradeOrchestratorDelegation(
  baseUrl: string, model: string, q: string, scenario: ToolScenario | undefined,
  opts: { think?: boolean; maxTokens?: number } = {}
): Promise<GradeResult> {
  if (!scenario) return { ok: false, detail: "no scenario" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laborch-"));
  try {
    for (const [rel, content] of Object.entries(scenario.files || {})) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    const calls: string[] = []; // top-level orchestrator calls ONLY — a sub-agent spawned
    // via spawn_agent has its own full, unrestricted toolset by design (that's the whole
    // point of delegating), so its tool_request events (tagged with e.agent) must NOT be
    // counted here or a correctly-delegating orchestrator looks like a violation.
    const fullExec = makeAgentExecutor({
      workspaceDir: dir, baseUrl, model, think: opts.think,
      onEvent: (e) => { if (e.k === "tool_request" && !e.agent) calls.push(e.v.name); },
    });
    const exec = makeOrchestratorExecutor(fullExec);
    const messages: ToolLoopMsg[] = [];
    if (scenario.system) messages.push({ role: "system", content: scenario.system });
    messages.push({ role: "user", content: q });
    await runToolLoop({
      baseUrl, model, messages, exec, tools: exec.defs, maxRounds: 20,
      think: opts.think, maxTokens: opts.maxTokens ?? 1536,
      approve: async () => true,
      onEvent: () => {},
    });
    const forbidden = calls.filter((name) => !ORCHESTRATOR_TOOLS.has(name));
    if (forbidden.length) return { ok: false, detail: `called forbidden tool(s): ${forbidden.join(", ")}` };
    const spawnCount = calls.filter((name) => name === "spawn_agent").length;
    if (spawnCount === 0) return { ok: false, detail: `zero spawn_agent calls (${calls.length} total calls: ${calls.join(", ") || "none"}) — restricted but not delegating` };
    return { ok: true, detail: `${spawnCount} spawn_agent call(s), 0 forbidden` };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ---- webgen: one-shot self-contained webapp generation, graded in headless Chrome ----
// The reality-gap suite: extracts the HTML document from the reply, loads it in the
// system Chrome via puppeteer-core, gates on page/console errors, then runs the item's
// `probes` script inside the page. Probes are the body of an async function with these
// helpers in scope:
//   probe(name, pass)      record a named boolean check
//   sleep(ms)              await a delay
//   $(sel)                 document.querySelector
//   press(key)             synthetic keydown+keyup on window/document/body
//   canvasData(sel?)       toDataURL of the (first) canvas — diff two calls to detect animation
//   clickEl(el)            mousedown+mouseup+click on an element
// Item passes only if the page loads error-free AND every probe passes — "attention to
// detail" is the point of this suite. Partial credit is visible in `detail`.
// A screenshot of the end state is saved and returned as `shot` for the bench UI.
const WEBSHOTS_DIR = path.join(process.cwd(), ".data", "webshots");

function extractHtml(s: string): string | null {
  const fences = [...s.matchAll(/```(?:html)?\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (let i = fences.length - 1; i >= 0; i--) {
    if (/<html|<!doctype|<canvas|<body|<script/i.test(fences[i])) return fences[i];
  }
  const m = s.match(/<!doctype html[\s\S]*<\/html>/i) || s.match(/<html[\s\S]*<\/html>/i);
  return m ? m[0] : null;
}

const PROBE_HELPERS = `
  const __results = [];
  const probe = (name, pass) => __results.push({ name, pass: !!pass });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const KEYS = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, " ": 32, Enter: 13,
                 w: 87, a: 65, s: 83, d: 68 };
  const press = (key) => {
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, { key, code: key.length === 1 ? "Key" + key.toUpperCase() : key,
                                           keyCode: KEYS[key] || 0, which: KEYS[key] || 0, bubbles: true });
      window.dispatchEvent(ev); document.dispatchEvent(ev); document.body?.dispatchEvent(ev);
    }
  };
  const canvasData = (sel) => {
    const c = sel ? $(sel) : document.querySelector("canvas");
    try { return c ? c.toDataURL() : null; } catch { return null; }
  };
  const clickEl = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    return true;
  };
`;

export async function gradeWebgen(got: string, item: BenchItem): Promise<GradeResult> {
  const html = extractHtml(got);
  if (!html) return { ok: false, detail: "no HTML document found in reply" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "labweb-"));
  const file = path.join(dir, "app.html");
  fs.writeFileSync(file, html);
  let browser: import("puppeteer-core").Browser | null = null;
  try {
    const { launch } = await import("puppeteer-core");
    browser = await launch({ executablePath: "/usr/bin/google-chrome", headless: true,
                             args: ["--hide-scrollbars", "--mute-audio"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 120)));
    page.on("console", (msg) => { if (msg.type() === "error") errors.push("console: " + msg.text().slice(0, 120)); });
    await page.goto("file://" + file, { waitUntil: "load", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1200));   // let init + first animation frames run

    let probeResults: { name: string; pass: boolean }[] = [];
    let probeCrash: string | null = null;
    if (item.probes) {
      try {
        probeResults = await page.evaluate(
          `(async () => { ${PROBE_HELPERS} ${item.probes}\n return __results; })()`
        ) as { name: string; pass: boolean }[];
      } catch (e) {
        probeCrash = String((e as Error).message || e).slice(0, 160);
      }
    }

    fs.mkdirSync(WEBSHOTS_DIR, { recursive: true });
    const shotId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let shot: string | undefined;
    try {
      await page.screenshot({ path: path.join(WEBSHOTS_DIR, shotId + ".png") as `${string}.png` });
      shot = shotId;
    } catch {}

    const failed = probeResults.filter((p) => !p.pass).map((p) => p.name);
    const passed = probeResults.length - failed.length;
    const parts: string[] = [];
    if (errors.length) parts.push(`${errors.length} page error(s): ${errors[0]}`);
    if (probeCrash) parts.push(`probes crashed: ${probeCrash}`);
    parts.push(`probes ${passed}/${probeResults.length}${failed.length ? " (failed: " + failed.join(", ") + ")" : ""}`);
    const ok = errors.length === 0 && !probeCrash && failed.length === 0 && probeResults.length > 0;
    return { ok, detail: parts.join("; "), shot };
  } catch (e) {
    return { ok: false, detail: "browser: " + String((e as Error).message || e).slice(0, 160) };
  } finally {
    try { await browser?.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

export type GradeCtx = { baseUrl: string; model: string; think?: boolean; maxTokens?: number };
export async function gradeItem(
  got: string, item: BenchItem, suiteGrade: BenchItem["grade"], ctx: GradeCtx
): Promise<GradeResult> {
  const grade = item.grade || suiteGrade || "substring";
  switch (grade) {
    case "numeric": return { ok: gradeNumeric(got, item.a || []) };
    case "exec": return gradeExec(got, item);
    case "checks": return gradeChecks(got, item.checks || []);
    case "tools": return gradeTools(ctx.baseUrl, ctx.model, item.q, item.scenario, { think: ctx.think, maxTokens: ctx.maxTokens });
    case "orchestrator-guard": return gradeOrchestratorDelegation(ctx.baseUrl, ctx.model, item.q, item.scenario, { think: ctx.think, maxTokens: ctx.maxTokens });
    case "webgen": return gradeWebgen(got, item);
    default: return { ok: gradeSubstring(got, item.a || []) };
  }
}
