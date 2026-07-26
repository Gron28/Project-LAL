/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Code-mode workflow presets, ported from the Local AI Lab web app's
 * `MODES` table (`web/src/app/api/agent/loop/route.ts`) so `/mode` in this CLI
 * matches the same policy defaults/ceilings for a task shape. A preset sets a
 * baseline; `/effort` can still adjust reasoning strength on top of it (see
 * Config.applyCodeModePreset()).
 */
export type CodeModeName =
  | 'default'
  | 'quick-edit'
  | 'planning'
  | 'deep-research'
  | 'orchestrator';

export const CODE_MODE_NAMES: readonly CodeModeName[] = [
  'default',
  'quick-edit',
  'planning',
  'deep-research',
  'orchestrator',
];

export interface CodeModePreset {
  label: string;
  /** Session turn ceiling — maps to Config.setMaxSessionTurns(). */
  maxRounds: number;
  /** Per-response output token ceiling — maps to samplingParams.max_tokens. */
  maxTokens: number;
  /** Optional explicit context override. Omitted presets retain the verified
   * runtime handshake instead of shrinking an adaptive 64K/128K model. */
  ctx?: number;
  /** Whether reasoning/thinking should be enabled for this preset. */
  think: boolean;
  /** Sampling temperature — maps to samplingParams.temperature. */
  temperature: number;
  /** Appended to the system prompt for the duration of the mode. */
  addendum: string;
  /** Suggested model id for this preset, if any (informational only; the CLI
   * does not force-switch models). */
  defaultModel?: string;
}

// Shared instruction fragment: any planning output should be small,
// self-contained, delegable chunks — not prose a single implementer reads
// end-to-end. A plan good enough for one big implement call is NOT
// automatically usable by a sub-agent, which only sees the text of its own
// step.
const CHUNKED_PLAN_INSTRUCTION = `Structure the plan as a numbered list of small, self-contained steps. EVERY step must use exactly this format (all four fields, every time):

N. <short title>
   Goal: <what this step accomplishes>
   Files: <exact file path(s) this step creates or touches>
   Depends on: <step number(s) this needs first, or "none">
   Done when: <a concrete, checkable condition — not "it works", something a different agent could verify without asking you>

Write each step so a DIFFERENT agent could execute it correctly having seen ONLY that step's text — never assume the executor also read the rest of the plan or an earlier step's reasoning. Prefer more, smaller steps over fewer, large ones: if a step would require touching many files or several distinct behaviors, split it further.`;

const ORCHESTRATOR_PROMPT = `MODE: orchestrator — you are a COORDINATOR, not the worker. Direct work you may do yourself: read files, list directories, and maintain your own notes files. Everything else — research, drafting a plan, critiquing it, implementing, testing — is delegated to sub-agents.

HARD CONSTRAINTS:
- Sub-agents see NOTHING but the task text you give them. Every task must be self-contained: the goal, exact input file paths, what to produce, where to write it, and an instruction to report back concisely.
- Keep durable state in files, not in your head: a plan file, a findings file, and a log file (append the stage and outcome after every stage — re-read these files when unsure instead of relying on memory of earlier turns).
- Never paste a sub-agent's raw report further downstream — pass the artifact file path plus a short digest you write yourself.

DEFAULT PIPELINE (adapt the shape to the task and say when you deviate):
1. RESEARCH — split into independent questions, one delegated task per question. Append findings to the findings file.
2. PLAN — read the findings file, write a plan as a numbered list of small, self-contained steps (exact goal, exact files, dependencies, concrete definition of done).
3. RED-TEAM — attack the plan for missing cases, wrong assumptions, failure modes. Write a critique file.
4. REPLAN — revise the plan against the critique.
5. ITERATE — implement the plan step by step; after each step, verify it before moving on. If a step fails twice in a row, stop and report rather than looping silently.
6. PRESENT — your final reply: what was built, how it was verified, decisions made along the way, and any open risks.

PROGRESS RULE: after each stage completes, send one short line naming the stage, its outcome, and what's next.`;

export const CODE_MODE_PRESETS: Record<CodeModeName, CodeModePreset> = {
  default: {
    label: 'default',
    maxRounds: 24,
    maxTokens: 8192,
    think: true,
    temperature: 0,
    addendum: '',
  },
  'quick-edit': {
    label: 'quick-edit',
    maxRounds: 8,
    maxTokens: 8192,
    think: false,
    temperature: 0,
    addendum:
      "MODE: quick-edit — make the smallest correct change. Read only what the edit requires. Prefer a small exact search/replace edit over rewriting a whole file. Verify the change, then stop. Do not spawn sub-agents or use web search/fetch in this mode — it's for fast, isolated edits only.",
  },
  planning: {
    label: 'planning',
    maxRounds: 16,
    maxTokens: 8192,
    think: true,
    temperature: 0,
    addendum:
      'MODE: planning — explore the codebase read-only; do NOT modify any files or run mutating shell commands. Your final reply must be a complete implementation plan, plus risks and how to verify the change once implemented. ' +
      CHUNKED_PLAN_INSTRUCTION,
  },
  'deep-research': {
    label: 'deep-research',
    maxRounds: 64,
    maxTokens: 8192,
    think: true,
    temperature: 0.3,
    addendum:
      "MODE: deep-research — this is a genuine deep-research pass, not a quick lookup, and should take real time and many steps. Use web_search for internet queries and web_fetch for source URLs; tool_search discovers tools and must never receive a web query. Start by decomposing the question into as many distinct sub-questions and angles as it warrants (typically 8-15 for a substantial question) — write them out before searching. Research each one thoroughly — a snippet alone is never enough to answer from, open the real source. As you read, generate NEW follow-up sub-questions from gaps, contradictions, or unexpected findings instead of stopping after your first pass. Track sources as you go. Do not synthesize your final answer until you've covered the breadth you identified — a shallow 1-2 search pass is a WRONG answer in this mode, not merely an incomplete one. Your final reply cites sources and synthesizes the findings into an answer, noting any disagreements or gaps in what you found.",
  },
  orchestrator: {
    label: 'orchestrator',
    maxRounds: 120,
    maxTokens: 8192,
    think: true,
    temperature: 0.2,
    addendum: ORCHESTRATOR_PROMPT,
  },
};
