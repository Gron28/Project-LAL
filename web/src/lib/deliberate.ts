// "Ultimate research" mode: a time-boxed, multi-perspective deliberative research
// engine. Structurally different from a single runToolLoop call — it's an explicit
// server-side state machine that makes MANY tool-loop calls across phases, not a
// single model improvising the whole process (a small model asked to orchestrate
// itself this elaborately would drift, per the same lesson as ORCHESTRATOR_PROMPT).
//
// Phases: scope the relevant perspectives -> each perspective (+ one neutral) does
// its own deep research -> the perspectives cross-examine each other's findings,
// explicitly framed as truth-seeking rather than "winning" -> gap-driven follow-up
// research -> repeat the debate/follow-up cycle until convergence or the time
// budget runs out -> a neutral synthesis, plus a separate retrospective on whether
// the process itself was sound. One model throughout (user's call, 2026-07-07): no
// swap cost between phases, at the price of persona-driven rather than architecture-
// driven diversity between roles.
import fs from "node:fs";
import path from "node:path";
import { runToolLoop, type ToolLoopEvent, type ToolLoopMsg } from "./toolloop";
import type { Executor, ToolDef } from "./tools";
import { ensureServing } from "./lab";
import type { ApproveFn } from "./toolloop";

export type Sampling = { temperature?: number; topP?: number; topK?: number; repeatPenalty?: number };

export type Role = { name: string; lens: string; bias?: string };

export type DeliberateEvent =
  | { k: "phase"; v: { name: string } }
  | { k: "roles"; v: { roles: Role[] } }
  | { k: "role_progress"; v: { role: string; stage: string } }
  | { k: "debate_turn"; v: { round: number; role: string; text: string } }
  | { k: "convergence"; v: { round: number; verdict: "converged" | "continue" | "unresolved" } }
  | { k: "artifact"; v: { path: string } }
  | { k: "text"; v: string }
  | { k: "inner"; v: { phase: string; role?: string; event: ToolLoopEvent } }
  | { k: "error"; v: string }
  | { k: "done"; v: { dir: string } };

const MAX_ROLES = 3;
const DEBATE_ROUND_HARD_CAP = 6;
const NEUTRAL_ROLE: Role = { name: "Neutral", lens: "no persona or advocacy — the best-available-evidence view" };

function extractJsonBlock(text: string): unknown | null {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!matches.length) return null;
  try { return JSON.parse(matches[matches.length - 1][1]); } catch { return null; }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "role";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n...[truncated — see the full artifact file for more]" : s;
}

function scopingPrompt(query: string): string {
  return `You are about to run a deep, multi-perspective research process on this question:\n\n"${query}"\n\nFirst, scope the research itself: identify exactly ${MAX_ROLES} distinct, genuinely relevant perspectives/roles that should each investigate this question independently — real, defensible viewpoints that would each reach a different, useful angle on it, not strawmen. For each, state its name, its lens (what it weighs most, and why that's relevant to THIS specific question), and a possible bias it should watch for in itself.\n\nThis is about the QUESTION, not any codebase or project — you do not need list_files/read_file/grep for this, there is nothing on disk to look at yet. Reason from what you already know about the topic and go straight to your answer.\n\nEnd your reply with exactly one fenced json block listing them, nothing after it:\n\`\`\`json\n[{"name": "...", "lens": "...", "bias": "..."}]\n\`\`\`\n(exactly ${MAX_ROLES} items.)`;
}

function researchPrompt(role: Role, query: string): string {
  const persona = role === NEUTRAL_ROLE
    ? "You are researching with no persona or advocacy — the neutral, best-available-evidence view."
    : `You are researching as: ${role.name}. Your lens: ${role.lens}. Watch for this bias in yourself: ${role.bias || "none stated"}.`;
  return `${persona}\n\nResearch this question thoroughly from that lens: "${query}"\n\nThis is a genuine deep-research pass: decompose into distinct sub-questions from your perspective, use web_search + web_fetch on real sources (a snippet is never enough to answer from), and follow up on gaps rather than stopping at your first pass. Write your findings as your final reply: your conclusion, the evidence for it, and — if you have a persona — where you think your own lens might be coloring the answer.`;
}

function debateTurnPrompt(role: Role, query: string, findingsDigest: string, priorRoundDigest?: string): string {
  return `You are ${role.name} (lens: ${role.lens}) in a structured research debate on: "${query}"\n\nEveryone in this debate wants the truth, not to win — concede points that don't survive scrutiny, and only flag genuine disagreement backed by real evidence, not disagreement for its own sake.\n\nCurrent findings from every perspective:\n${findingsDigest}\n${priorRoundDigest ? "\nPrevious debate round:\n" + priorRoundDigest : ""}\n\nFrom YOUR perspective specifically: what do you agree with, what do you dispute and why (cite the actual evidence, not just intuition), and what's still genuinely unresolved? Keep it focused — a few hundred words, no tool calls needed unless you must confirm one specific fact.`;
}

function convergencePrompt(query: string, roundDigest: string): string {
  return `You are a neutral moderator reviewing one round of a structured research debate on: "${query}"\n\nThis round's transcript:\n${roundDigest}\n\nHas the group converged on a shared conclusion (even if nuanced), or is there a real disagreement more research could help close, or a real disagreement that's actually a values/tradeoff difference no amount of research will close?\n\nEnd your reply with exactly one line, one of:\nCONVERGENCE: converged\nCONVERGENCE: continue\nCONVERGENCE: unresolved`;
}

function followUpPrompt(role: Role, query: string, gapsDigest: string): string {
  return `You are ${role.name} continuing your research on: "${query}"\n\nThe debate surfaced this specific gap or disagreement relevant to your findings:\n${gapsDigest}\n\nDo TARGETED follow-up research on just this point (a few web_search/web_fetch calls, not a full redo), then state: did this change your position, and why or why not?`;
}

function synthesisPrompt(query: string, fullDigest: string): string {
  return `You are the neutral synthesizer concluding a structured multi-perspective research process on: "${query}"\n\nFull process record:\n${fullDigest}\n\nWrite the final answer: the best-supported conclusion, explicitly noting any genuine unresolved disagreement and why (evidence gap vs. values/tradeoff difference), and how much confidence this conclusion deserves.`;
}

function retrospectivePrompt(query: string, fullDigest: string): string {
  return `Step back from the conclusion itself. Looking at HOW this research process ran on: "${query}"\n\nProcess record:\n${fullDigest}\n\nReflect honestly: was the initial choice of perspectives sound, or should a different lens have been included? Did the debate rounds surface real signal or just talk past each other? Does the final confidence level actually match the quality of evidence found? This is a critique of the PROCESS, not a restatement of the conclusion.`;
}

async function askOnce(opts: {
  baseUrl: string; model: string; exec: Executor; tools: ToolDef[];
  prompt: string; maxRounds: number; minResearchCalls?: number;
  phase: string; role?: string; sampling: Sampling; approve?: ApproveFn;
  onEvent: (e: DeliberateEvent) => void;
}): Promise<string> {
  // A deliberation is many minutes and many calls deep by design — one transient
  // failure (a real one killed a whole session 2026-07-07: llama-server dropped the
  // connection partway through a research role's tool loop, "fetch failed", and the
  // entire multi-phase run aborted with nothing salvaged) must not cost the whole
  // process. Retries re-assert the model is actually serving before trying again,
  // since the failure mode observed was the server no longer being there at all.
  const ASK_RETRIES = 2;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= ASK_RETRIES; attempt++) {
    try {
      const messages: ToolLoopMsg[] = [{ role: "user", content: opts.prompt }];
      const final = await runToolLoop({
        baseUrl: opts.baseUrl, model: opts.model, messages, tools: opts.tools, exec: opts.exec,
        maxRounds: opts.maxRounds, maxTokens: 4096, think: true,
        temperature: opts.sampling.temperature ?? 0.3, topP: opts.sampling.topP, topK: opts.sampling.topK, repeatPenalty: opts.sampling.repeatPenalty,
        minResearchCalls: opts.minResearchCalls, approve: opts.approve,
        onEvent: (e) => opts.onEvent({ k: "inner", v: { phase: opts.phase, role: opts.role, event: e } }),
      });
      const last = final[final.length - 1];
      return typeof last?.content === "string" ? last.content : "";
    } catch (e) {
      lastErr = e as Error;
      if (attempt === ASK_RETRIES) break;
      await new Promise((r) => setTimeout(r, 3000));
      try { await ensureServing(opts.model, 16384); } catch { /* fall through, next attempt will surface it */ }
    }
  }
  throw lastErr ?? new Error("askOnce failed with no captured error");
}

export async function runDeliberation(opts: {
  query: string;
  minutes: number;
  project: string;
  baseUrl: string;
  model: string;
  exec: Executor;
  tools: ToolDef[];
  sampling?: Sampling;
  approve?: ApproveFn;
  onEvent: (e: DeliberateEvent) => void;
}): Promise<string> {
  const { onEvent } = opts;
  const sampling = opts.sampling ?? {};
  const deadline = Date.now() + Math.max(1, opts.minutes) * 60_000;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(opts.project, "_deliberation", stamp);
  fs.mkdirSync(dir, { recursive: true });

  const write = (name: string, content: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    onEvent({ k: "artifact", v: { path: p } });
  };

  const ask = (prompt: string, phase: string, role: string | undefined, maxRounds: number, minResearchCalls?: number) =>
    askOnce({ baseUrl: opts.baseUrl, model: opts.model, exec: opts.exec, tools: opts.tools, prompt, maxRounds, minResearchCalls, phase, role, sampling, approve: opts.approve, onEvent });

  // Phase 0: scope the perspectives themselves, before researching the actual question.
  onEvent({ k: "phase", v: { name: "scoping" } });
  const scopingText = await ask(scopingPrompt(opts.query), "scoping", undefined, 10, 3);
  write("scoping.md", scopingText);
  let roles = ((extractJsonBlock(scopingText) as Role[] | null) || [])
    .filter((r) => r && typeof r.name === "string" && typeof r.lens === "string")
    .slice(0, MAX_ROLES);
  if (!roles.length) {
    roles = [
      { name: "Domain Expert", lens: "specialist technical knowledge and established best practice" },
      { name: "Skeptical Reviewer", lens: "stress-tests claims and looks for weak or missing evidence" },
      { name: "Practical User", lens: "weighs real-world tradeoffs, cost, and usability over theory" },
    ];
  }
  write("roles.json", JSON.stringify(roles, null, 2));
  onEvent({ k: "roles", v: { roles } });

  // Phase 1: each role + one neutral pass do their own full deep research. The
  // FIRST role always runs regardless of the deadline (there must be at least one
  // finding), but a real run (2026-07-07: minutes=3 request took 384s/6.4min because
  // nothing here checked the deadline) showed this fixed-cost phase can blow the
  // time budget on its own if left unchecked — every role after the first respects
  // it, skipping with a placeholder rather than silently running long.
  const findings: Record<string, string> = {};
  const allRoles = [...roles, NEUTRAL_ROLE];
  for (let i = 0; i < allRoles.length; i++) {
    const role = allRoles[i];
    if (i > 0 && Date.now() >= deadline) {
      findings[role.name] = "(skipped — time budget was already used up by earlier roles' research)";
      write(`research_${slugify(role.name)}.md`, findings[role.name]);
      continue;
    }
    onEvent({ k: "role_progress", v: { role: role.name, stage: "researching" } });
    const text = await ask(researchPrompt(role, opts.query), "research", role.name, 20, 8);
    findings[role.name] = text;
    write(`research_${slugify(role.name)}.md`, text);
  }

  const digestAll = () => allRoles.map((r) => `### ${r.name}\n${truncate(findings[r.name] || "", 1200)}`).join("\n\n");

  // Phase 2+3: cross-examine, then gap-driven follow-up, repeated until convergence
  // or the time budget runs out (checked between rounds, not mid-generation — a live
  // call is never aborted, so the last round can run slightly past the deadline).
  let round = 0;
  const debateLog: string[] = [];
  while (Date.now() < deadline && round < DEBATE_ROUND_HARD_CAP) {
    round++;
    onEvent({ k: "phase", v: { name: `debate round ${round}` } });
    const turns: string[] = [];
    const priorDigest = debateLog.length ? truncate(debateLog[debateLog.length - 1], 1500) : undefined;
    for (const role of allRoles) {
      const turnText = await ask(debateTurnPrompt(role, opts.query, digestAll(), priorDigest), "debate", role.name, 8);
      turns.push(`### ${role.name}\n${turnText}`);
      onEvent({ k: "debate_turn", v: { round, role: role.name, text: turnText } });
    }
    const roundText = turns.join("\n\n");
    debateLog.push(roundText);
    write(`debate_round${round}.md`, roundText);

    onEvent({ k: "phase", v: { name: `convergence check ${round}` } });
    const verdictText = await ask(convergencePrompt(opts.query, truncate(roundText, 3000)), "convergence", undefined, 4);
    const m = verdictText.match(/CONVERGENCE:\s*(converged|continue|unresolved)/i);
    const verdict = (m?.[1].toLowerCase() as "converged" | "continue" | "unresolved" | undefined) || "continue";
    onEvent({ k: "convergence", v: { round, verdict } });
    if (verdict !== "continue" || Date.now() >= deadline) break;

    onEvent({ k: "phase", v: { name: `follow-up research ${round}` } });
    for (const role of allRoles) {
      if (Date.now() >= deadline) break;
      const followText = await ask(followUpPrompt(role, opts.query, truncate(roundText, 1500)), "followup", role.name, 12, 2);
      findings[role.name] = findings[role.name] + `\n\n---UPDATE (round ${round})---\n` + followText;
      write(`research_${slugify(role.name)}_round${round}.md`, followText);
    }
  }

  // Phase 4: neutral synthesis, then a separate honest critique of the process itself.
  const fullDigest = digestAll() + "\n\n" + debateLog.map((d, i) => `## Debate round ${i + 1}\n${truncate(d, 2000)}`).join("\n\n");
  onEvent({ k: "phase", v: { name: "synthesis" } });
  const synthesisText = await ask(synthesisPrompt(opts.query, truncate(fullDigest, 6000)), "synthesis", undefined, 4);
  write("synthesis.md", synthesisText);
  onEvent({ k: "text", v: synthesisText });

  onEvent({ k: "phase", v: { name: "retrospective" } });
  const retroText = await ask(retrospectivePrompt(opts.query, truncate(fullDigest, 6000)), "retrospective", undefined, 4);
  write("retrospective.md", retroText);

  onEvent({ k: "done", v: { dir } });
  return dir;
}
