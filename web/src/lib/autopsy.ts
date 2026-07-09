// Run autopsy: deterministic, rule-based diagnosis of a run's event ledger.
// This is the evolution loop's diagnostic organ — "which model failed, doing what,
// how often" — computed from data every run already writes (lib/runs.ts ndjson).
// Deliberately NO model calls here: a diagnosis you might retrain against must not
// be another model's opinion (Goodhart risk), just counted facts.
import fs from "node:fs";
import path from "node:path";
import { getRun, type RunMeta } from "./runs";

const RUNS_DIR = path.join(process.cwd(), ".data", "runs");

export type Finding = { code: string; count: number; detail: string };
export type RunDiagnosis = {
  runId: string;
  verdict: "clean" | "flawed" | "failed";
  findings: Finding[];
  stats: {
    durationSec: number;
    rounds: number;
    toolCalls: number;
    toolFailures: number;
    textChars: number;
    thinkChars: number;
    nudges: number;
    maxGapSec: number;       // longest silence between consecutive events (dead air)
    tokPerSec: number | null; // mean decode speed across usage events
    avgConf: number | null;   // mean token confidence (chat runs; agent runs once llama.cpp allows)
    minConf: number | null;
  };
};

type Ev = { seq?: number; ts?: number; k?: string; v?: unknown };

// Classify a failed tool_result's output into a stable failure code. These codes
// are the vocabulary the report card (and any future retraining pipeline) keys on.
function failureCode(output: string): string {
  if (output === "denied by user") return "denied_by_user";
  if (output.includes("truncated or malformed")) return "args_truncated";
  if (output.startsWith("error: invalid tool arguments")) return "invalid_args";
  if (output.startsWith("error: unknown tool")) return "unknown_tool";
  if (output.includes("research budget")) return "research_ceiling";
  return "tool_error";
}

export function diagnoseRun(id: string): RunDiagnosis | null {
  const meta = getRun(id);
  if (!meta) return null;
  let raw = "";
  try { raw = fs.readFileSync(path.join(RUNS_DIR, id + ".ndjson"), "utf8"); } catch { /* no ledger — diagnose from meta alone */ }

  const findings = new Map<string, Finding>();
  const add = (code: string, detail: string, n = 1) => {
    const f = findings.get(code);
    if (f) { f.count += n; }
    else findings.set(code, { code, count: n, detail });
  };

  const stats = {
    durationSec: Math.max(0, Math.round((meta.updatedAt - meta.startedAt) / 1000)),
    rounds: 0, toolCalls: 0, toolFailures: 0, textChars: 0, thinkChars: 0,
    nudges: 0, maxGapSec: 0, tokPerSec: null as number | null, avgConf: null as number | null, minConf: null as number | null,
  };

  let lastTs = 0;
  let anyOkTool = false;
  let tokSum = 0, tokN = 0, confSum = 0, confN = 0, confMin = 1;
  // Detect the "same call failing over and over" loop (gemma's pathless write_file,
  // 2026-07-09): consecutive identical (tool, failure code) failures.
  let streakKey = "", streak = 0, worstStreak = 0, worstStreakKey = "";

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: Ev;
    try { e = JSON.parse(line) as Ev; } catch { continue; }
    const ts = typeof e.ts === "number" ? e.ts : 0;
    if (lastTs && ts > lastTs) stats.maxGapSec = Math.max(stats.maxGapSec, Math.round((ts - lastTs) / 1000));
    if (ts) lastTs = ts;
    const v = e.v as Record<string, unknown> | string | number | undefined;

    switch (e.k) {
      case "round": stats.rounds++; break;
      case "text": stats.textChars += String((v as string) ?? "").length; break;
      case "think": stats.thinkChars += String((v as string) ?? "").length; break;
      case "tool_result": {
        stats.toolCalls++;
        const r = v as { name?: string; ok?: boolean; output?: string };
        if (r?.ok === false) {
          stats.toolFailures++;
          const code = failureCode(String(r.output ?? ""));
          add(code, `${r.name}: ${String(r.output ?? "").slice(0, 120)}`);
          const key = `${r.name}|${code}`;
          streak = key === streakKey ? streak + 1 : 1;
          streakKey = key;
          if (streak > worstStreak) { worstStreak = streak; worstStreakKey = key; }
        } else {
          anyOkTool = true;
          streak = 0; streakKey = "";
        }
        break;
      }
      case "stall_nudge": stats.nudges++; add("stalled_reading", "read-only rounds until nudged to write"); break;
      case "research_depth_nudge": stats.nudges++; add("shallow_research", "answered before the mode's research floor"); break;
      case "forced_verify": stats.nudges++; break; // routine guard, not a defect by itself
      case "think_recovered": add("buried_tool_calls", "emitted tool calls as reasoning text instead of structured calls", Number((v as { count?: number })?.count ?? 1)); break;
      case "max_rounds": add("ran_out_of_rounds", `hit the ${String(v)}-round cap without finishing`); break;
      case "context_limit": add("context_exhausted", "context budget exhausted before the next model call"); break;
      case "truncated": add("output_truncated", "final answer cut by the token cap"); break;
      case "usage": {
        const u = v as { tokPerSec?: number | null; conf?: { avg?: number; min?: number } | null };
        if (typeof u?.tokPerSec === "number") { tokSum += u.tokPerSec; tokN++; }
        if (u?.conf && typeof u.conf.avg === "number") {
          confSum += u.conf.avg; confN++;
          if (typeof u.conf.min === "number" && u.conf.min < confMin) confMin = u.conf.min;
        }
        break;
      }
    }
  }

  if (worstStreak >= 3) add("repeated_failure_loop", `${worstStreakKey.replace("|", " failing with ")} ×${worstStreak} in a row — the model did not correct from the error`);
  if (stats.textChars === 0 && !anyOkTool && meta.status !== "running") add("no_output", "run produced no reply text and no successful tool call");
  if (meta.status === "error") add("run_error", meta.error || "run ended in error");
  if (meta.status === "interrupted") add("interrupted", meta.error || "app restarted mid-run");
  if (tokN) stats.tokPerSec = Math.round((tokSum / tokN) * 10) / 10;
  if (confN) { stats.avgConf = Math.round((confSum / confN) * 1000) / 1000; stats.minConf = Math.round(confMin * 1000) / 1000; }

  const fatal = ["no_output", "run_error", "repeated_failure_loop", "context_exhausted", "interrupted"];
  const codes = [...findings.keys()];
  const verdict: RunDiagnosis["verdict"] =
    codes.some((c) => fatal.includes(c)) ? "failed" : codes.length ? "flawed" : "clean";

  return { runId: id, verdict, findings: [...findings.values()].sort((a, b) => b.count - a.count), stats };
}

// ---- per-model report card ----
// "Measure what works": every terminal run on disk, grouped by model. This is the
// scoreboard the evolution loop reads to decide which specialist needs retraining.
export type ModelReport = {
  model: string;
  runs: number;
  clean: number;
  flawed: number;
  failed: number;
  toolCalls: number;
  toolFailures: number;
  avgTokPerSec: number | null;
  avgConf: number | null;
  topFailures: { code: string; count: number }[];
};

export function modelReport(): ModelReport[] {
  let files: string[] = [];
  try { files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  const byModel = new Map<string, ModelReport & { tokSum: number; tokN: number; confSum: number; confN: number; failCodes: Map<string, number> }>();
  for (const f of files) {
    let meta: RunMeta;
    try { meta = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), "utf8")); } catch { continue; }
    if (meta.status === "running") continue;
    const d = diagnoseRun(meta.id);
    if (!d) continue;
    let m = byModel.get(meta.model);
    if (!m) {
      m = { model: meta.model, runs: 0, clean: 0, flawed: 0, failed: 0, toolCalls: 0, toolFailures: 0, avgTokPerSec: null, avgConf: null, topFailures: [], tokSum: 0, tokN: 0, confSum: 0, confN: 0, failCodes: new Map() };
      byModel.set(meta.model, m);
    }
    m.runs++;
    m[d.verdict]++;
    m.toolCalls += d.stats.toolCalls;
    m.toolFailures += d.stats.toolFailures;
    if (d.stats.tokPerSec != null) { m.tokSum += d.stats.tokPerSec; m.tokN++; }
    if (d.stats.avgConf != null) { m.confSum += d.stats.avgConf; m.confN++; }
    for (const fd of d.findings) m.failCodes.set(fd.code, (m.failCodes.get(fd.code) ?? 0) + fd.count);
  }
  return [...byModel.values()].map((m) => ({
    model: m.model, runs: m.runs, clean: m.clean, flawed: m.flawed, failed: m.failed,
    toolCalls: m.toolCalls, toolFailures: m.toolFailures,
    avgTokPerSec: m.tokN ? Math.round((m.tokSum / m.tokN) * 10) / 10 : null,
    avgConf: m.confN ? Math.round((m.confSum / m.confN) * 1000) / 1000 : null,
    topFailures: [...m.failCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code, count]) => ({ code, count })),
  })).sort((a, b) => b.runs - a.runs);
}
