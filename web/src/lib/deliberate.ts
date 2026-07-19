// "Ultimate research" mode: a cycle-boxed, multi-perspective deliberative research
// engine. Structurally different from a single runToolLoop call — it's an explicit
// server-side state machine that makes MANY tool-loop calls across phases, not a
// single model improvising the whole process (a small model asked to orchestrate
// itself this elaborately would drift, per the same lesson as ORCHESTRATOR_PROMPT).
//
// Phases: scope the relevant perspectives -> each perspective (+ one neutral) does
// its own deep research -> the perspectives cross-examine each other's findings,
// explicitly framed as truth-seeking rather than "winning" -> gap-driven follow-up
// research -> repeat the debate/follow-up cycle until convergence or
// DEBATE_ROUND_HARD_CAP cycles are used up -> a neutral synthesis, plus a separate
// retrospective on whether the process itself was sound. No wall-clock deadline
// (2026-07-10: it let one slow research role eat the entire budget and silently
// skip every later phase, including the debate loop itself) — completion, not a
// time limit, is the goal; cycle count is the only budget. One model throughout
// (user's call, 2026-07-07): no swap cost between phases, at the price of
// persona-driven rather than architecture-driven diversity between roles.
import fs from "node:fs";
import path from "node:path";
import { runToolLoop, type ToolLoopMsg } from "./toolloop";
import type { Executor, ToolDef } from "./tools";
import { ensureServing } from "./lab";
import type { ApproveFn } from "./toolloop";
import { runRetention } from "./retention";
import type { DeliberateEvent, Role } from "@project-lal/protocol";

export type { DeliberateEvent, Role } from "@project-lal/protocol";

export type Sampling = { temperature?: number; topP?: number; topK?: number; repeatPenalty?: number };

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
  return `You are about to run a deep, multi-perspective research process on this question:\n\n"${query}"\n\nFirst, scope the research itself: identify exactly ${MAX_ROLES} distinct, genuinely relevant perspectives/roles that should each investigate this question independently — real, defensible viewpoints that would each reach a different, useful angle on it, not strawmen.\n\nCritical: each role must independently attempt to answer the WHOLE question, not just one slice of it. WRONG — task-splitting, not perspective diversity (e.g. for "what car should I buy?": a "Budget" role, a "Safety" role, and a "Fuel Economy" role, each covering one factor instead of proposing a full answer). RIGHT — each role proposes a full answer through a different lens (e.g. a "Domain Expert", a "Skeptical Reviewer", and a "Practical User", each independently recommending a car and why). Roles will later read and critique EACH OTHER's full findings on this SAME question — if two roles investigated disjoint slices instead of the same question from different angles, they'll have nothing to agree or disagree about.\n\nFor each, state its name, its lens (what it weighs most, and why that's relevant to THIS specific question), and a possible bias it should watch for in itself.\n\nThis is about the QUESTION, not any codebase or project — you do not need list_files/read_file/grep for this, there is nothing on disk to look at yet. Reason from what you already know about the topic and go straight to your answer.\n\nEnd your reply with exactly one fenced json block listing them, nothing after it:\n\`\`\`json\n[{"name": "...", "lens": "...", "bias": "..."}]\n\`\`\`\n(exactly ${MAX_ROLES} items.)`;
}

function researchPrompt(role: Role, query: string): string {
  const persona = role === NEUTRAL_ROLE
    ? "You are researching with no persona or advocacy — the neutral, best-available-evidence view."
    : `You are researching as: ${role.name}. Your lens: ${role.lens}. Watch for this bias in yourself: ${role.bias || "none stated"}.`;
  return `${persona}\n\nResearch this question thoroughly from that lens: "${query}"\n\nThis is a genuine deep-research pass: decompose into distinct sub-questions from your perspective, use web_search + web_fetch on real sources (a snippet is never enough to answer from), and follow up on gaps rather than stopping at your first pass.\n\nCritical: your search queries must reflect YOUR specific lens, not just restate the question — other roles are researching this exact same question right now, and if your queries look like theirs, your findings will too, and there will be nothing real left to debate later. WRONG: a generic query anyone would run (e.g. "best plants for a shaded balcony"). RIGHT: a query only YOUR lens would prioritize (e.g. if your lens is space-efficiency, "vertical gardening techniques small balcony"; if your lens is local climate, "[location] frost dates microclimate"). Never repeat a query you've already run — if you can't think of a new angle from your lens, you're done researching, not stuck.\n\nThis phase is deliberately open — verification and pruning happen later, in the debate and synthesis, so your job now is to surface real candidates, not to pre-filter them. Include at least one unconventional-but-testable hypothesis from your lens: a real, checkable claim a lazier pass would skip for being unusual, contrarian, or off the beaten path — not a strawman, and not the mainstream view restated. If a lead is genuinely low-confidence, don't drop it — label it "speculative" and note what would need to be true for it to hold up; a flagged guess is useful signal, a silently discarded one is not. If the question touches something controversial, stigmatized, or sensitive but is asked in good faith about a legitimate purpose (research, safety, history, understanding), research it straight — refusing or deflecting a benign question is itself a failure mode here, not caution. If, separately, the question would — if answered operationally — materially help cause serious harm, don't just refuse and stop: transform it, giving the high-level analysis, history, prevention, and ethical dimensions instead of operational specifics, and keep engaging with whatever legitimate part of the question remains.\n\nWrite your findings as your final reply: your conclusion, the evidence for it, your unconventional-but-testable hypothesis, any speculative leads (clearly labeled), and — if you have a persona — where you think your own lens might be coloring the answer.`;
}

function debateTurnPrompt(role: Role, query: string, findingsDigest: string, priorRoundDigest?: string): string {
  return `You are ${role.name} (lens: ${role.lens}) in a structured research debate on: "${query}"\n\nEveryone in this debate wants the truth, not to win — concede points that don't survive scrutiny, and only flag genuine disagreement backed by real evidence, not disagreement for its own sake.\n\nCurrent findings from every perspective:\n${findingsDigest}\n${priorRoundDigest ? "\nPrevious debate round:\n" + priorRoundDigest : ""}\n\nBefore you challenge any other perspective's claim, steelman it first — state its strongest form in one sentence, as its own author would recognize it, so you're arguing with the real position rather than a weakened version of it. Then challenge it: every challenge must cite a specific piece of evidence from the research findings above (a source, a fact, a named finding) — never bare intuition or "that seems unlikely". If you can't point to what in the findings actually contradicts a claim, it isn't a challenge yet, it's a hunch — hunches belong in your own findings as speculative leads, not as attacks on someone else's.\n\nFrom YOUR perspective specifically: what do you agree with, what do you steelman-then-dispute and why (cite the actual evidence), and what's still genuinely unresolved? Keep it focused — a few hundred words, no tool calls needed unless you must confirm one specific fact.`;
}

function convergencePrompt(query: string, roundDigest: string): string {
  return `You are a neutral moderator reviewing one round of a structured research debate on: "${query}"\n\nThis round's transcript:\n${roundDigest}\n\nActing as judge, not participant: rank the hypotheses actually still on the table this round. For each live one, weigh novelty (how far it is from the obvious/mainstream answer) and feasibility (how checkable or actionable it is) as two SEPARATE judgments — a hypothesis can be highly novel and low-feasibility, or the reverse, and conflating the two is exactly the failure this check exists to catch. Before you call this "converged", ask: did the group actually resolve the disagreement, or did the least novel, most convenient position win by default while a genuinely live, differently-supported alternative got dropped without anyone actually refuting it with evidence? If so, that alternative should stay alive — don't let apparent consensus erase it.\n\nHas the group converged on a shared conclusion (even if nuanced), or is there a real disagreement more research could help close, or a real disagreement that's actually a values/tradeoff difference no amount of research will close?\n\nEnd your reply with exactly one line, one of:\nCONVERGENCE: converged\nCONVERGENCE: continue\nCONVERGENCE: unresolved`;
}

function followUpPrompt(role: Role, query: string, gapsDigest: string): string {
  return `You are ${role.name} continuing your research on: "${query}"\n\nThe debate surfaced this specific gap or disagreement relevant to your findings:\n${gapsDigest}\n\nDo TARGETED follow-up research on just this point (a few web_search/web_fetch calls, not a full redo), then state: did this change your position, and why or why not?`;
}

function synthesisPrompt(query: string, fullDigest: string): string {
  return `You are the neutral synthesizer concluding a structured multi-perspective research process on: "${query}"\n\nFull process record:\n${fullDigest}\n\nThis is the strict verification stage — everything upstream was allowed to be open and exploratory; this step is not. Rank every hypothesis still standing by how well-supported it is. For each one still live, give it an evidence status (observed / inferred / speculative), its strongest objection, and — where it matters — the minimum test that would discriminate it from the alternatives; anything actually contradicted by the evidence gets eliminated here, not carried forward out of politeness. Score novelty and feasibility separately for the live hypotheses (a novel-but-infeasible idea and a feasible-but-obvious one are different findings, not the same one at different strengths) — do not average them into a single number. Even once you name a best-supported conclusion, keep the strongest surviving alternative visible in your answer rather than letting it quietly disappear.\n\nWrite the final answer: the best-supported conclusion, explicitly noting any genuine unresolved disagreement and why (evidence gap vs. values/tradeoff difference).\n\nEnd your reply with exactly one line, in exactly this format, and nothing after it:\nCONFIDENCE: <0-100> — <one-line rationale>`;
}

function retrospectivePrompt(query: string, fullDigest: string): string {
  return `Step back from the conclusion itself. Looking at HOW this research process ran on: "${query}"\n\nProcess record:\n${fullDigest}\n\nReflect honestly: was the initial choice of perspectives sound, or should a different lens have been included? Did the debate rounds surface real signal or just talk past each other? Does the final confidence level actually match the quality of evidence found? This is a critique of the PROCESS, not a restatement of the conclusion.`;
}

async function askOnce(opts: {
  baseUrl: string; model: string; exec: Executor; tools: ToolDef[];
  prompt: string; maxRounds: number; minResearchCalls?: number; ctx: number;
  phase: string; role?: string; sampling: Sampling; approve?: ApproveFn;
  signal?: AbortSignal;
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
        maxRounds: opts.maxRounds, maxTokens: 4096, think: true, ctx: opts.ctx,
        temperature: opts.sampling.temperature ?? 0.3, topP: opts.sampling.topP, topK: opts.sampling.topK, repeatPenalty: opts.sampling.repeatPenalty,
        minResearchCalls: opts.minResearchCalls, approve: opts.approve,
        signal: opts.signal,
        onEvent: (e) => opts.onEvent({ k: "inner", v: { phase: opts.phase, role: opts.role, event: e } }),
      });
      const last = final[final.length - 1];
      return typeof last?.content === "string" ? last.content : "";
    } catch (e) {
      // A user Stop is not a transient failure — retrying it would resurrect the
      // very run the user just killed.
      if ((e as Error).name === "AbortError" || opts.signal?.aborted) throw e;
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
  project: string;
  baseUrl: string;
  model: string;
  ctx: number;
  exec: Executor;
  tools: ToolDef[];
  sampling?: Sampling;
  approve?: ApproveFn;
  signal?: AbortSignal;
  onEvent: (e: DeliberateEvent) => void;
}): Promise<string> {
  const { onEvent } = opts;
  const sampling = opts.sampling ?? {};
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(opts.project, "_deliberation", stamp);
  fs.mkdirSync(dir, { recursive: true });

  const write = (name: string, content: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    onEvent({ k: "artifact", v: { path: p } });
  };

  const ask = (prompt: string, phase: string, role: string | undefined, maxRounds: number, minResearchCalls?: number) =>
    askOnce({ baseUrl: opts.baseUrl, model: opts.model, exec: opts.exec, tools: opts.tools, prompt, maxRounds, minResearchCalls, ctx: opts.ctx, phase, role, sampling, approve: opts.approve, signal: opts.signal, onEvent });

  // Phase 0: scope the perspectives themselves, before researching the actual question.
  // No minResearchCalls here — the scoping prompt explicitly tells the model it needs
  // no tools for this, and a stray minResearchCalls floor (copied from the research-
  // phase call below, where it belongs) forced 9 pointless web_search rounds here,
  // discarding a clean direct answer and burning >10% of the run's whole time budget
  // before real research even started (observed 2026-07-10, run deliberate-mrf4e4tla8lj).
  onEvent({ k: "phase", v: { name: "scoping" } });
  const scopingText = await ask(scopingPrompt(opts.query), "scoping", undefined, 10);
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

  // Phase 1: each role + one neutral pass do their own full deep research. No time
  // budget gating this (or anything below) — cycles (DEBATE_ROUND_HARD_CAP) and
  // convergence are the only stop conditions now. A wall-clock deadline here used to
  // let one slow role (17 tool calls, 6+ minutes, observed 2026-07-10) eat the whole
  // remaining budget and silently skip every later role AND the entire debate loop —
  // completion, not a time limit, is the goal; let it take however long it takes.
  const findings: Record<string, string> = {};
  const allRoles = [...roles, NEUTRAL_ROLE];
  for (const role of allRoles) {
    onEvent({ k: "role_progress", v: { role: role.name, stage: "researching" } });
    const text = await ask(researchPrompt(role, opts.query), "research", role.name, 20, 8);
    findings[role.name] = text;
    write(`research_${slugify(role.name)}.md`, text);
  }

  const digestAll = () => allRoles.map((r) => `### ${r.name}\n${truncate(findings[r.name] || "", 1200)}`).join("\n\n");

  // Phase 2+3: cross-examine, then gap-driven follow-up, repeated until convergence
  // or DEBATE_ROUND_HARD_CAP cycles are used up — cycles are the only budget now,
  // not wall-clock time (see the note on Phase 1 above).
  let round = 0;
  const debateLog: string[] = [];
  while (round < DEBATE_ROUND_HARD_CAP) {
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
    if (verdict !== "continue") break;

    onEvent({ k: "phase", v: { name: `follow-up research ${round}` } });
    for (const role of allRoles) {
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

  // Retention (open-inquiry-protocol.md Section 6, blocking): right after this run's
  // own artifacts are done writing, evict old sibling runs under the same project's
  // _deliberation/ dir. Never lets a retention failure fail the deliberation itself —
  // this is disk hygiene, not part of the research result.
  try { runRetention(path.dirname(dir)); } catch { /* best-effort, never fails the run */ }

  onEvent({ k: "done", v: { dir } });
  return dir;
}
