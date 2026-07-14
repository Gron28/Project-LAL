import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { makeAgentExecutor } from "../agent-tools";
import { newId, readSettings, servingModel, webSearch } from "../lab";
import { requestApproval, resolveApproval, startRun, stopRun, type EmitFn } from "../runs";
import { dependencyOutputHasCriticalRisk, runToolLoop, type ToolLoopEvent, type ToolLoopMsg } from "../toolloop";
import { workspaceSandboxCommand } from "../tools";
import { webFetch } from "../agent-tools";
import {
  HIVE_CONTRACT_VERSION, emptyStageResult, validateRoutingDecision, validateTaskEnvelope, validateWorkflowSpec,
  type ArtifactRef, type BudgetName, type EvidenceRecord, type HiveFailureCode, type ModelProfile, type RoleProfile, type RoutingDecision, type SpecialistHandoff, type StageResult, type TaskEnvelope, type WorkflowNode, type WorkflowSpec,
} from "./contracts";
import { ROLE_PROFILES, workflowTemplate } from "./presets";
import { ensureEligibleModel, prepareModelProfile, recordRoleOutcome } from "./model-registry";
import {
  appendHiveEvent, beginSideEffect, createApproval, createWorkflow, deleteWorkflow, finishSideEffect, getEvidence, getLatestHiveToolResult, getLatestHiveToolResults, getRoleOverrides, getWorkflow, getWorkflowNodes, listWorkflows, putArtifact, putEvidence,
  resetFailedNodes, resetInterruptedNodes, resolveStoredApproval, updateNode, updateWorkflow, workflowSnapshot, type WorkflowNodeRecord,
} from "./store";

// User-editable overrides (web/src/app/api/hive/roles) layered on top of the
// hardcoded ROLE_PROFILES defaults — every stage that reads a role's prompt or
// model preference goes through these instead of ROLE_PROFILES directly.
function effectiveRole(roleId: string): RoleProfile {
  const base = ROLE_PROFILES[roleId];
  const override = getRoleOverrides()[roleId];
  return override?.prompt ? { ...base, prompt: override.prompt } : base;
}
function rolePreferredModel(roleId: string): string | undefined {
  return getRoleOverrides()[roleId]?.preferredModel;
}

type StartOptions = { kind: "research" | "coding"; budget?: BudgetName; envelope: TaskEnvelope; preferredModel?: string; autoApprove?: boolean; spec?: WorkflowSpec; parentWorkflowId?: string; working?: Record<string, unknown> };
type StageConfidence = { avg: number; min: number; low: number; n: number };
type NodeExecution = { result: StageResult; usage?: { prompt: number; completion: number; context: number }; toolCalls?: number; model?: ModelProfile; swapMs?: number; adapterMs?: number; confidence?: StageConfidence };
type StageTrace = (kind: "reasoning" | "output", text: string, meta?: { p?: number; alts?: [string, number][] }) => void;
type LiveHive = { workflowId: string; executionRunId: string };
type HiveGlobal = typeof globalThis & { __hive_live?: Map<string, LiveHive>; __hive_gpu_tail?: Promise<void>; __hive_recovered?: boolean; __hive_pause_requested?: Set<string> };
const hg = globalThis as HiveGlobal;
if (!hg.__hive_live) hg.__hive_live = new Map();
if (!hg.__hive_pause_requested) hg.__hive_pause_requested = new Set();
const live = hg.__hive_live;

const TERMINAL_NODE = new Set(["succeeded", "failed", "skipped", "cancelled"]);
const COMPLETE_DEP = new Set(["succeeded", "skipped"]);
const STAGE_RESULT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["version", "status", "summary", "findings", "artifacts", "evidence", "uncertainties", "errors"],
  properties: {
    version: { const: HIVE_CONTRACT_VERSION }, status: { enum: ["succeeded", "failed", "needs_followup", "blocked"] }, summary: { type: "string" },
    findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text"], properties: { id: { type: "string" }, text: { type: "string" }, evidenceIds: { type: "array", items: { type: "string" } }, confidence: { type: "number", minimum: 0, maximum: 1 } } } },
    artifacts: { type: "array", maxItems: 0 },
    evidence: { type: "array", maxItems: 0 },
    uncertainties: { type: "array", items: { type: "string" } }, errors: { type: "array", items: { type: "string" } },
  },
};

function isStageResult(v: unknown): v is StageResult {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<StageResult>;
  return r.version === HIVE_CONTRACT_VERSION && ["succeeded", "failed", "needs_followup", "blocked"].includes(String(r.status)) && typeof r.summary === "string"
    && Array.isArray(r.findings) && r.findings.every((f) => !!f && typeof f.id === "string" && typeof f.text === "string" && (f.evidenceIds === undefined || (Array.isArray(f.evidenceIds) && f.evidenceIds.every((id) => typeof id === "string"))))
    && Array.isArray(r.artifacts) && Array.isArray(r.evidence)
    && Array.isArray(r.uncertainties) && r.uncertainties.every((item) => typeof item === "string")
    && Array.isArray(r.errors) && r.errors.every((item) => typeof item === "string");
}

async function streamedStageCompletion(baseUrl: string, body: Record<string, unknown>, signal: AbortSignal, trace?: StageTrace): Promise<Record<string, unknown>> {
  // Stage calls carry NO tools, so llama-server's "logprobs is not supported with
  // tools + stream" restriction does not apply here — this is the same tier-1
  // certainty capture /chat ships, now feeding the Hive's live brain-wave view.
  // Some backends still reject logprobs (or its combination with response_format):
  // fall back to a plain request instead of failing the stage.
  const attempt = (withConf: boolean) => fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true }, ...(withConf ? { logprobs: true, top_logprobs: 4 } : {}) }), signal });
  let response = await attempt(true);
  if (!response.ok) response = await attempt(false);
  if (!response.ok || !response.body) throw new Error(`model backend ${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = "", content = "", reasoning = "", usage: Record<string, unknown> = {};
  let confSum = 0, confN = 0, confMin = 1, confLow = 0;
  type LogprobEntry = { token?: string; logprob?: number; top_logprobs?: { token: string; logprob: number }[] };
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd: number;
    while ((lineEnd = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, lineEnd).trim(); buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") continue;
      try {
        const chunk = JSON.parse(raw) as { choices?: { delta?: { content?: string; reasoning_content?: string; thinking?: string }; logprobs?: { content?: LogprobEntry[] } }[]; usage?: Record<string, unknown> };
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const thought = delta?.reasoning_content ?? delta?.thinking ?? "";
        const text = delta?.content ?? "";
        // Per-token certainty (same math as the /chat route and toolloop): p is
        // the model's probability for this delta's token; alts are the tokens it
        // almost chose, attached only when the pick was genuinely uncertain.
        let p: number | undefined;
        let alts: [string, number][] | undefined;
        const lpArr = choice?.logprobs?.content;
        if (Array.isArray(lpArr) && lpArr.length) {
          let sum = 0;
          for (const entry of lpArr) {
            const pe = Math.exp(entry.logprob ?? 0);
            sum += pe; confSum += pe; confN++;
            if (pe < confMin) confMin = pe;
            if (pe < 0.5) confLow++;
          }
          p = Math.round((sum / lpArr.length) * 1000) / 1000;
          if (p < 0.6 && lpArr[0]?.top_logprobs?.length) {
            alts = lpArr[0].top_logprobs
              .filter((t) => t.token !== lpArr[0].token)
              .slice(0, 3)
              .map((t) => [t.token, Math.round(Math.exp(t.logprob) * 1000) / 1000]);
          }
        }
        if (thought) { reasoning += thought; trace?.("reasoning", thought, p !== undefined ? { p } : undefined); }
        if (text) { content += text; trace?.("output", text, p !== undefined ? { p, ...(alts ? { alts } : {}) } : undefined); }
        if (chunk.usage) usage = chunk.usage;
      } catch { /* ignore malformed SSE frame; the complete stream still has later frames */ }
    }
  }
  return {
    choices: [{ message: { content, reasoning_content: reasoning } }], usage,
    ...(confN ? { confidence: { avg: Math.round((confSum / confN) * 1000) / 1000, min: Math.round(confMin * 1000) / 1000, low: confLow, n: confN } } : {}),
  };
}

// Some local backends wrap an otherwise complete JSON response with a trailing
// quote/fence despite response_format. Recover only the first balanced object;
// the normal StageResult validator still rejects missing or unsafe fields.
function parseStageJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0; let quote = false; let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quote = false; continue; }
    if (char === '"') { quote = true; continue; }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

// Close an output that was cut mid-JSON by the token cap: try progressively
// earlier cut points, strip dangling fragments (`"key":`, unterminated strings,
// trailing commas), append the missing closers, and parse. Bounded attempts.
function completeTruncatedJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const closersFor = (slice: string): string | null => {
    const stack: string[] = [];
    let quote = false, escaped = false;
    for (const ch of slice) {
      if (quote) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quote = false; continue; }
      if (ch === '"') quote = true;
      else if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") stack.pop();
    }
    return quote ? null : stack.reverse().join("");
  };
  let attempts = 0;
  for (let i = text.length - 1; i > start && attempts < 60; i--) {
    if (!/["}\]0-9a-z]/i.test(text[i])) continue;
    attempts++;
    const candidate = text.slice(start, i + 1)
      .replace(/,?\s*"(?:[^"\\]|\\.)*$/, "")
      .replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "")
      .replace(/,\s*$/, "");
    const closers = closersFor(candidate);
    if (closers === null) continue;
    try { return JSON.parse(candidate + closers); } catch { /* try an earlier cut */ }
  }
  return null;
}

// Salvage over rigidity: local models regularly emit a NEARLY valid StageResult —
// extra invented fields, missing empty arrays, or output truncated by the token
// cap. Downstream stages only consume status/summary/findings/uncertainties;
// artifacts, evidence, and verification are owned by deterministic boundaries and
// force-cleared regardless. Failing a whole stage over shape trivia threw away
// a perfectly good plan (hive-mrfxf4t866pf plan node, 2026-07-11).
function coerceStageResult(v: unknown, rawText: string): StageResult | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const status = ["succeeded", "failed", "needs_followup", "blocked"].includes(String(r.status)) ? String(r.status) as StageResult["status"] : "needs_followup";
  const summary = typeof r.summary === "string" && r.summary.trim() ? r.summary : rawText.replace(/\s+/g, " ").trim().slice(0, 800);
  if (!summary) return null;
  const findings = Array.isArray(r.findings)
    ? r.findings.filter((f): f is Record<string, unknown> => !!f && typeof f === "object").map((f, i) => ({
        id: typeof f.id === "string" ? f.id : `finding-${i + 1}`,
        text: typeof f.text === "string" ? f.text : JSON.stringify(f).slice(0, 500),
        ...(Array.isArray(f.evidenceIds) && f.evidenceIds.every((x) => typeof x === "string") ? { evidenceIds: f.evidenceIds as string[] } : {}),
        ...(typeof f.confidence === "number" ? { confidence: f.confidence } : {}),
      }))
    : [];
  const strings = (x: unknown) => Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 1_000)) : [];
  return { version: HIVE_CONTRACT_VERSION, status, summary, findings, artifacts: [], evidence: [], uncertainties: strings(r.uncertainties), errors: strings(r.errors) };
}

function emitRouting(workflowId: string, emit: EmitFn, spec: WorkflowSpec, decision: RoutingDecision): void {
  if (!validateRoutingDecision(decision, spec)) throw new Error("internal coordinator produced an invalid routing decision");
  appendHiveEvent(workflowId, { kind: "routing_decision", payload: decision });
  emit({ k: "workflow_routing", workflowId, v: decision });
}

function dependencyHandoff(envelope: TaskEnvelope, node: WorkflowNode, records: WorkflowNodeRecord[], evidence: EvidenceRecord[]): SpecialistHandoff {
  // This is the always-on sidecar compressor.  Full node records remain durable
  // in SQLite/artifacts, while the next tiny specialist receives only a bounded,
  // independently useful digest.  That lets a long Hive keep accumulating history
  // without repeatedly paying to re-feed it all to each model.
  // Digest limits halved 2026-07-11: an ~8k-token cold stage prompt cost ~30s
  // of pure prompt processing per stage at local speeds AND sat squarely in the
  // GPU-wedge window (see gpu watchdog incident). Later stages only need the
  // shape of earlier results, not their prose in full.
  const deps = records.filter((r) => r.result && (node.dependsOn.includes(r.nodeId) || r.status === "succeeded")).slice(-8).map((r) => ({
    nodeId: r.nodeId, role: r.role, status: r.result!.status, summary: r.result!.summary.slice(0, 700),
    findings: r.result!.findings.slice(0, 5).map((finding) => ({ ...finding, text: finding.text.slice(0, 350) })),
    artifacts: r.result!.artifacts.slice(0, 4).map(({ hash, label, mediaType, size }) => ({ hash, label, mediaType, size })),
    uncertainties: r.result!.uncertainties.slice(0, 5).map((item) => item.slice(0, 250)),
    verification: r.result!.verification ? { passed: r.result!.verification.passed, score: r.result!.verification.score, checks: r.result!.verification.checks.slice(0, 5).map((check) => ({ ...check, detail: check.detail.slice(0, 200) })) } : undefined,
    failureCodes: r.result!.failureCodes || [],
  }));
  const exactFailures = records
    .flatMap((record) => record.result?.verification?.checks.filter((check) => !check.passed).map((check) => ({ code: check.code, detail: check.detail.slice(0, 2_500) })) || [])
    .slice(-8);
  return {
    version: HIVE_CONTRACT_VERSION,
    target: { nodeId: node.id, role: node.role, label: node.label },
    task: { objective: envelope.objective, constraints: envelope.constraints, requiredOutput: envelope.requiredOutput, definitionOfDone: envelope.definitionOfDone, workspace: envelope.workspace },
    ownedPackage: node.label,
    dependencies: deps,
    evidence: evidence.slice(-10).map(({ id, url, title, claim, stance }) => ({ id, url, title, claim, stance })),
    exactFailures,
    operatorGuidance: [], conversation: [], priorMission: null,
  };
}

function guidedDependencyContext(workflowId: string, envelope: TaskEnvelope, node: WorkflowNode, records: WorkflowNodeRecord[], evidence: EvidenceRecord[]): string {
  const base = dependencyHandoff(envelope, node, records, evidence);
  const working = getWorkflow(workflowId)?.working || {};
  const messages = Array.isArray(working.operatorMessages) ? working.operatorMessages.slice(-12) : [];
  const conversation = Array.isArray(working.conversation) ? working.conversation.slice(-24).map((turn) => {
    const item = turn as { role?: unknown; text?: unknown };
    return { role: typeof item.role === "string" ? item.role : "user", text: typeof item.text === "string" ? item.text.slice(0, 800) : "" };
  }) : [];
  return JSON.stringify({ ...base, conversation, operatorGuidance: messages, priorMission: working.parentContext ?? null });
}

type MissionTurn = { role: "user" | "assistant"; content: string };

function missionTranscript(workflowId: string): MissionTurn[] {
  const raw = getWorkflow(workflowId)?.working.missionTranscript;
  if (!Array.isArray(raw)) {
    // Seed older workflows that predate missionTranscript from their durable
    // completed-node records, so a repair never starts as a blank chat.
    return getWorkflowNodes(workflowId).filter((node) => node.result && node.status === "succeeded").slice(-8).flatMap((node): MissionTurn[] => [
      { role: "user", content: `Previously completed stage ${node.label} (${node.nodeId}). Continue from its workspace changes and evidence; do not redo it.` },
      { role: "assistant", content: node.result!.summary.slice(0, 4_000) || "Stage completed; inspect its recorded files and artifacts." },
    ]);
  }
  return raw
    .filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === "object")
    .filter((turn) => (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string")
    .map((turn): MissionTurn => ({ role: turn.role as MissionTurn["role"], content: String(turn.content).slice(0, 4_000) }))
    .slice(-16);
}

function appendMissionTranscript(workflowId: string, user: string, assistant: string) {
  const workflow = getWorkflow(workflowId);
  if (!workflow) return;
  const previous = missionTranscript(workflowId);
  const next: MissionTurn[] = [
    ...previous,
    { role: "user" as const, content: user.slice(0, 4_000) },
    { role: "assistant" as const, content: assistant.slice(0, 4_000) },
  ].slice(-16);
  updateWorkflow(workflowId, { working: { ...workflow.working, missionTranscript: next } });
}

async function directModelStage(profile: ModelProfile, roleId: string, promptContext: string, signal: AbortSignal, trace?: StageTrace, maxTokens = 1_600): Promise<NodeExecution> {
  const role = effectiveRole(roleId);
  if (!role) throw new Error(`unknown role: ${roleId}`);
  if (role.coordinator && role.permittedTools.length) throw new Error("coordinator roles cannot have worker tools");
  const before = servingModel();
  const swapStarted = Date.now();
  const prepared = await prepareModelProfile(profile, Math.min(profile.contextCeiling, readSettings().options.num_ctx));
  const baseUrl = prepared.baseUrl;
  const swapMs = before && before !== profile.model ? Date.now() - swapStarted : 0;
  const adapterMs = profile.specialist ? prepared.loadMs : 0;
  const body: Record<string, unknown> = {
    model: profile.model, temperature: 0, max_tokens: maxTokens,
    messages: [
      { role: "system", content: `${role.prompt}

You are executing ONLY the ${roleId} stage, not the overall user task. Produce the bounded artifact this stage owns; do not search, implement, verify final completion, or decide that the user's requested outcome is impossible. A later deterministic stage owns evidence fetching, tools, tests, and final success/failure.

Return one JSON object matching the supplied StageResult schema. Do not add markdown fences. Use status "succeeded" when you produced this stage's artifact. Use "needs_followup" only to name a concrete missing input for a later stage. Never use "failed" or "blocked" for an ordinary task uncertainty: those values are reserved for a runtime failure, which you cannot determine from this role.` },
      { role: "user", content: promptContext },
    ],
    response_format: { type: "json_schema", json_schema: { name: "stage_result", strict: true, schema: STAGE_RESULT_SCHEMA } },
  };
  if (prepared.lora) body.lora = prepared.lora;
  // Specialist adapters are SFT'd on no-think-format targets (empty think block).
  // Running them with thinking enabled is a train/serve format mismatch — the
  // think-displacement failure the victory track already paid for. Prompted
  // (non-specialist) roles keep the model's default thinking behaviour.
  if (profile.specialist) body.chat_template_kwargs = { enable_thinking: false };
  let payload = await streamedStageCompletion(baseUrl, body, signal, trace);
  let message = (payload.choices as { message?: { content?: string; reasoning_content?: string; thinking?: string } }[] | undefined)?.[0]?.message;
  let content = String(message?.content ?? "");
  const emitTrace = () => {
    const reasoning = String(message?.reasoning_content ?? message?.thinking ?? "");
    if (reasoning) trace?.("reasoning", reasoning.slice(0, 16_000));
    if (content) trace?.("output", content.slice(0, 16_000));
  };
  // Streaming has already emitted deltas live. This preserves compatibility with
  // a backend that returns a buffered body despite the stream flag.
  if (!content && !String(message?.reasoning_content ?? message?.thinking ?? "")) emitTrace();
  const salvage = (text: string): StageResult | null => {
    const direct = parseStageJson(text);
    if (isStageResult(direct)) return direct;
    return coerceStageResult(direct ?? completeTruncatedJson(text), text);
  };
  let parsed = salvage(content);
  // One bounded repair attempt for backends that ignore response_format.
  if (!parsed) {
    payload = await streamedStageCompletion(baseUrl, { model: profile.model, temperature: 0, max_tokens: maxTokens, ...(prepared.lora ? { lora: prepared.lora } : {}), ...(profile.specialist ? { chat_template_kwargs: { enable_thinking: false } } : {}), messages: [
        { role: "system", content: "Repair the candidate into exactly one valid StageResult JSON object. No prose or markdown." },
        { role: "user", content: JSON.stringify({ schema: STAGE_RESULT_SCHEMA, candidate: content.slice(0, 12_000) }) },
      ] }, signal, trace);
    message = (payload.choices as { message?: { content?: string; reasoning_content?: string; thinking?: string } }[] | undefined)?.[0]?.message;
    content = String(message?.content ?? "");
    emitTrace();
    parsed = salvage(content);
  }
  if (!parsed) throw new Error("model returned invalid StageResult after one repair attempt");
  // A small model will sometimes answer the user's final question from an intake
  // or planning stage, then mark the entire workflow failed (for example, "the
  // documentation was not found") before the search node is even reached.  That
  // is not a runtime failure. Preserve its uncertainty as data for later stages,
  // but never let an intermediate model self-cancel the graph.
  if (parsed.status === "failed" || parsed.status === "blocked") {
    const reason = [...parsed.errors, parsed.summary].filter(Boolean).join(" — ").slice(0, 2_000);
    parsed.status = "needs_followup";
    parsed.errors = [];
    if (reason && !parsed.uncertainties.includes(reason)) parsed.uncertainties.push(reason);
  }
  // A model can reference canonical evidence IDs in findings, but it cannot mint
  // evidence or artifact records. Only deterministic fetch/write boundaries own
  // hashes, retrieval timestamps, and filesystem paths.
  parsed.artifacts = [];
  parsed.evidence = [];
  parsed.verification = undefined;
  const usage = payload.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  const confidence = payload.confidence as StageConfidence | undefined;
  return { result: parsed, model: profile, swapMs, adapterMs, usage: { prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0, context: usage?.total_tokens ?? 0 }, ...(confidence ? { confidence } : {}) };
}

function parseSearchUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s)\]}>,]+/g)].map((m) => m[0].replace(/[.,;]+$/, "")).filter((url, i, all) => all.indexOf(url) === i);
}

async function researchSearch(workflowId: string, node: WorkflowNode, envelope: TaskEnvelope, deps: WorkflowNodeRecord[], budgetCalls: number): Promise<NodeExecution> {
  const source = deps.find((record) => node.dependsOn.includes(record.nodeId))?.result;
  const generated = (source?.findings || []).map((finding) => finding.text.trim()).filter((query) => query.length >= 4 && query.length <= 240);
  const fallback = envelope.objective.split(/[.;]\s+/).map((part) => part.trim()).filter(Boolean).map((part) => part.slice(0, 180));
  const queries = (generated.length ? generated : fallback).filter((query, index, all) => all.indexOf(query) === index).slice(0, Math.max(1, budgetCalls));
  const findings: StageResult["findings"] = [];
  for (const [i, query] of queries.entries()) {
    const output = /^https?:\/\//i.test(query) ? `Direct source URL\n${query}` : await webSearch(query.slice(0, 500));
    findings.push({ id: `search-${i + 1}`, text: `Query: ${query}\n${output}` });
  }
  const artifact = putArtifact(JSON.stringify({ queries, findings }, null, 2), "application/json", { workflowId, nodeId: node.id, label: "search-results.json" });
  return { result: { ...emptyStageResult(`${queries.length} deterministic searches completed; snippets are discovery only, not evidence.`), findings, artifacts: [artifact] }, toolCalls: queries.length };
}

async function researchFetch(workflowId: string, node: WorkflowNode, deps: WorkflowNodeRecord[], limit: number): Promise<NodeExecution> {
  // Resolve the search-results dependency through the graph, not a hardcoded id:
  // coding-v2 names its search node "research_search", and the hardcoded "search"
  // lookup made every coding-run fetch stage silently retrieve zero sources.
  const search = deps.find((d) => node.dependsOn.includes(d.nodeId) && d.result)?.result ?? deps.find((d) => d.nodeId === "search")?.result;
  const urls = parseSearchUrls((search?.findings || []).map((f) => f.text).join("\n")).slice(0, limit);
  const evidence: EvidenceRecord[] = [];
  const artifacts: ArtifactRef[] = [];
  for (const [i, url] of urls.entries()) {
    const content = await webFetch(url);
    if (!content || content.startsWith("error:")) continue;
    const artifact = putArtifact(content, "text/plain", { workflowId, nodeId: node.id, label: `source-${i + 1}.txt` });
    const ev: EvidenceRecord = {
      id: `ev-${crypto.randomUUID()}`, url, retrievedAt: Date.now(), sourceHash: artifact.hash,
      excerpt: content.slice(0, 1_800), stance: "context", title: content.split("\n", 1)[0]?.slice(0, 200),
    };
    putEvidence(workflowId, node.id, ev); evidence.push(ev); artifacts.push(artifact);
  }
  return { result: { ...emptyStageResult(`Fetched ${evidence.length} full sources; ${urls.length - evidence.length} fetches failed.`), evidence, artifacts, findings: evidence.map((e) => ({ id: `source-${e.id}`, text: `${e.title || e.url}: ${e.excerpt.slice(0, 500)}`, evidenceIds: [e.id] })), uncertainties: evidence.length < 2 ? ["Source diversity is insufficient."] : [] }, toolCalls: urls.length };
}

function evidenceLedger(workflowId: string): NodeExecution {
  const evidence = getEvidence(workflowId);
  const result = { ...emptyStageResult(`${evidence.length} source-linked evidence records in the ledger.`), evidence, findings: evidence.map((e) => ({ id: `ledger-${e.id}`, text: e.claim || e.excerpt.slice(0, 500), evidenceIds: [e.id] })) };
  result.verification = { passed: evidence.length > 0, score: evidence.length ? 1 : 0, checks: [{ code: "full_source_evidence", passed: evidence.length > 0, detail: evidence.length ? `${evidence.length} fetched sources` : "No fetched sources; search snippets cannot pass." }] };
  if (!evidence.length) result.status = "needs_followup";
  return { result };
}

function citationVerify(workflowId: string, deps: WorkflowNodeRecord[]): NodeExecution {
  const evidence = new Map(getEvidence(workflowId).map((e) => [e.id, e]));
  const synthesis = deps.find((d) => d.nodeId === "synthesis")?.result;
  const important = synthesis?.findings || [];
  const checks = important.map((finding) => {
    const ids = finding.evidenceIds || [];
    const valid = ids.length > 0 && ids.every((id) => evidence.has(id));
    return { code: `claim:${finding.id}`, passed: valid, detail: valid ? `Supported by ${ids.join(", ")}` : "Missing or unknown evidence record" };
  });
  const passedCount = checks.filter((c) => c.passed).length;
  const score = important.length ? passedCount / important.length : 0;
  const passed = important.length > 0 && score === 1;
  return { result: { ...emptyStageResult(passed ? "All synthesized claims reference fetched source evidence." : "Citation verification failed; unsupported claims remain."), status: passed ? "succeeded" : "failed", findings: important, evidence: [...evidence.values()], verification: { passed, score, checks: checks.length ? checks : [{ code: "claims_present", passed: false, detail: "Synthesis produced no verifiable findings." }] }, errors: passed ? [] : ["Important claims lack valid evidence IDs."] } };
}

function repoMap(workflowId: string, node: WorkflowNode, workspace: string, objective: string): NodeExecution {
  const root = path.resolve(workspace);
  // A coding mission may intentionally target a greenfield directory.  Creating
  // the declared workspace is a deterministic, idempotent preparation step—not
  // model-authored implementation—and lets the normal map → plan → tools flow
  // build a project from nothing.  Existing files are never replaced here.
  const createdWorkspace = !fs.existsSync(root);
  if (createdWorkspace) fs.mkdirSync(root, { recursive: true });
  if (!fs.statSync(root).isDirectory()) throw new Error(`workspace is not a directory: ${root}`);
  const files: string[] = [];
  const skip = new Set(["node_modules", ".git", ".next", "dist", "build", ".data", ".venv"]);
  const walk = (dir: string) => {
    if (files.length >= 2_000) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs); else files.push(path.relative(root, abs));
      if (files.length >= 2_000) break;
    }
  };
  walk(root);
  const manifests = files.filter((f) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Makefile)$/.test(f));
  const terms = [...new Set(objective.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [])]
    .filter((term) => !new Set(["this", "that", "with", "from", "must", "should", "before", "after", "their", "hive"]).has(term));
  const relevance = (file: string) => {
    const lower = file.toLowerCase();
    const pathHits = terms.reduce((score, term) => score + (lower.includes(term) ? 12 : 0), 0);
    const hiveBonus = /(^|\/)hive(\/|$)|hive/.test(lower) && /hive|conversation|continuation|workflow|agent/.test(objective.toLowerCase()) ? 20 : 0;
    const sourceBonus = /^(src|lib)\//.test(file) ? 3 : 0;
    const manifestBonus = /(^|\/)(README[^/]*|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|[^/]*test[^/]*)$/i.test(file) ? 6 : 0;
    return pathHits + hiveBonus + sourceBonus + manifestBonus;
  };
  const priority = files
    .filter((file) => /(^|\/)(README[^/]*|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|[^/]*test[^/]*)$/i.test(file) || /^(src|lib)\//.test(file))
    .sort((a, b) => relevance(b) - relevance(a) || a.localeCompare(b))
    .slice(0, 12);
  const excerpts = priority.map((file) => {
    try { return { file, content: fs.readFileSync(path.join(root, file), "utf8").slice(0, 2_500) }; }
    catch { return { file, content: "[unreadable or binary]" }; }
  });
  const artifact = putArtifact(JSON.stringify({ root, files, manifests, excerpts, truncated: files.length >= 2_000 }, null, 2), "application/json", { workflowId, nodeId: node.id, label: "repository-map.json" });
  return { result: { ...emptyStageResult(`${createdWorkspace ? "Initialized an empty workspace, then " : ""}mapped ${files.length} files and inspected ${excerpts.length} high-signal files. Manifests: ${manifests.join(", ") || "none"}.`), artifacts: [artifact], findings: excerpts.map((entry, i) => ({ id: `repo-${i}`, text: `${entry.file}\n${entry.content}` })) } };
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ ok: boolean; output: string; command: string }> {
  return new Promise((resolve) => {
    const sandbox = workspaceSandboxCommand(cwd, command, args);
    // `next build` treats a server-inherited NODE_ENV=development as an invalid
    // production-build environment and its worker can exit without a useful
    // diagnostic. Let each project command select its own expected environment.
    const env = { ...sandbox.env, NODE_ENV: undefined } as unknown as NodeJS.ProcessEnv;
    const child = spawn(sandbox.command, sandbox.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let settled = false;
    const finish = (ok: boolean, suffix = "") => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve({ ok, output: (output + suffix).slice(-30_000), command: [command, ...args].join(" ") }); };
    const append = (chunk: Buffer) => { if (output.length < 40_000) output += chunk.toString(); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.on("error", (e) => finish(false, `\n${e.message}`)); child.on("close", (code) => finish(code === 0, `\n[exit ${code}]`));
    const abort = () => { try { child.kill("SIGKILL"); } catch {} finish(false, "\n[cancelled]"); };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(false, "\n[timed out]"); }, timeoutMs);
  });
}

async function deterministicChecks(workflowId: string, node: WorkflowNode, workspace: string, signal: AbortSignal): Promise<NodeExecution> {
  const checks: { command: string; ok: boolean; output: string }[] = [];
  const packagePath = path.join(workspace, "package.json");
  if (fs.existsSync(packagePath)) {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts || {};
    const names = ["test", "typecheck", "lint", "build"].filter((name) => scripts[name] && !/no test specified/i.test(scripts[name]));
    for (const name of names) checks.push(await runProcess("npm", ["run", name], workspace, 180_000, signal));
    const latestInstall = getLatestHiveToolResult(workflowId, "install_dependencies");
    if (latestInstall) {
      const payload = latestInstall.payload as { output?: unknown };
      const output = String(payload.output ?? "");
      const unsafe = dependencyOutputHasCriticalRisk(output);
      checks.push({
        command: "dependency security gate",
        ok: !unsafe,
        output: unsafe
          ? `Latest dependency installation reported a critical or explicitly vulnerable package. Update package.json to supported compatible versions and run install_dependencies again.\n${output.slice(-4_000)}`
          : `Latest dependency installation passed the critical-vulnerability gate.\n${output.slice(-2_000)}`,
      });
    }
  } else if (fs.existsSync(path.join(workspace, "pyproject.toml")) || fs.existsSync(path.join(workspace, "pytest.ini"))) {
    checks.push(await runProcess("python3", ["-m", "pytest", "-q"], workspace, 180_000, signal));
  } else if (fs.existsSync(path.join(workspace, "Cargo.toml"))) checks.push(await runProcess("cargo", ["test", "--quiet"], workspace, 180_000, signal));
  const artifact = putArtifact(JSON.stringify(checks, null, 2), "application/json", { workflowId, nodeId: node.id, label: "deterministic-checks.json" });
  const passed = checks.length > 0 && checks.every((c) => c.ok);
  const summary = passed
    ? `${checks.length} deterministic checks passed.`
    : checks.length
      ? `${checks.filter((c) => !c.ok).length} deterministic checks failed.`
      : "No deterministic check command could be discovered.";
  const result: StageResult = {
    ...emptyStageResult(summary),
    status: passed ? "succeeded" : "needs_followup",
    artifacts: [artifact],
    findings: checks.map((c, i) => ({ id: `check-${i}`, text: `${c.command}: ${c.ok ? "PASS" : "FAIL"}\n${c.output.slice(-2_000)}` })),
    verification: {
      passed,
      score: passed ? 1 : 0,
      checks: checks.length
        ? checks.map((c) => ({ code: c.command, passed: c.ok, detail: c.output.slice(-1_000) }))
        : [{ code: "checks_discovered", passed: false, detail: "No supported project manifest/check command found." }],
    },
    errors: passed ? [] : ["Deterministic verification did not pass."],
  };
  return { result, toolCalls: checks.length };
}

function verifierResult(summary: string, envelope: TaskEnvelope): NonNullable<StageResult["verification"]> {
  const parsed = parseStageJson(summary) as { passed?: unknown; checks?: unknown } | null;
  if (!parsed || typeof parsed.passed !== "boolean" || !Array.isArray(parsed.checks)) {
    return { passed: false, score: 0, checks: [{ code: "verifier_schema", passed: false, detail: "Verifier did not return the required JSON verdict." }] };
  }
  const rawChecks = parsed.checks.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  const checks = envelope.definitionOfDone.map((requirement, index) => {
    const raw = rawChecks.find((item) => Number(item.requirement) === index + 1 || item.code === `requirement-${index + 1}`) || rawChecks[index];
    return {
      code: `requirement-${index + 1}`,
      passed: raw?.passed === true,
      detail: typeof raw?.detail === "string" ? raw.detail.slice(0, 2_000) : `No evidence supplied for: ${requirement}`,
    };
  });
  const passed = parsed.passed && checks.length === envelope.definitionOfDone.length && checks.every((check) => check.passed);
  return { passed, score: checks.length ? checks.filter((check) => check.passed).length / checks.length : 0, checks };
}

function workspaceFileSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const ignored = new Set([".git", "node_modules", ".next", ".npm", "dist", "build", "coverage", "__pycache__", ".pytest_cache", "target"]);
  const walk = (directory: string) => {
    if (out.size >= 2_000) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.name.startsWith(".next-")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(absolute); if (stat.size > 1024 * 1024) continue;
        out.set(path.relative(root, absolute), crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"));
      } catch { /* file may be replaced while the snapshot is walking */ }
    }
  };
  walk(root);
  return out;
}

function workspaceChanges(before: Map<string, string>, after: Map<string, string>) {
  const added = [...after.keys()].filter((file) => !before.has(file));
  const deleted = [...before.keys()].filter((file) => !after.has(file));
  const modified = [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file));
  return { added, modified, deleted };
}

function latestDependencyRisk(workflowId: string): { output: string; packages: { name: string; version: string }[] } | null {
  const installHistory = getLatestHiveToolResults(workflowId, "install_dependencies", 20);
  const latestInstall = installHistory.at(-1);
  if (!latestInstall) return null;
  const output = String((latestInstall.payload as { output?: unknown }).output ?? "");
  if (!dependencyOutputHasCriticalRisk(output)) return null;
  const historicalOutput = installHistory.map((event) => String((event.payload as { output?: unknown }).output ?? "")).join("\n");
  const packages = [...historicalOutput.matchAll(/deprecated\s+(@?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)@([^:\s]+):[^\n]*security vulnerability/gi)]
    .map((match) => ({ name: match[1], version: match[2] }));
  return { output: output.slice(-4_000), packages };
}

async function workerTools(workflowId: string, executionRunId: string, node: WorkflowNode, profile: ModelProfile, envelope: TaskEnvelope, context: string, emit: EmitFn, signal: AbortSignal, autoApprove: boolean, mode: "mutation" | "verification" = "mutation"): Promise<NodeExecution> {
  const workspace = path.resolve(envelope.workspace || process.cwd());
  const filesBefore = mode === "mutation" ? workspaceFileSnapshot(workspace) : new Map<string, string>();
  const before = servingModel(); const swapStarted = Date.now();
  const prepared = await prepareModelProfile(profile, Math.min(profile.contextCeiling, readSettings().options.num_ctx));
  const baseUrl = prepared.baseUrl; const swapMs = before && before !== profile.model ? Date.now() - swapStarted : 0; const adapterMs = profile.specialist ? prepared.loadMs : 0;
  const approve = async (call: { id: string; name: string; args: Record<string, unknown> }) => {
    if (autoApprove) return true;
    createApproval(call.id, workflowId, node.id, "tool", call);
    updateWorkflow(workflowId, { status: "awaiting_approval" }); updateNode(workflowId, node.id, { status: "awaiting_approval" });
    const allowed = await requestApproval(executionRunId, emit, call);
    resolveStoredApproval(call.id, allowed); updateWorkflow(workflowId, { status: "running" }); updateNode(workflowId, node.id, { status: "running" });
    return allowed;
  };
  const role = effectiveRole(node.role);
  const dependencyRisk = mode === "mutation" ? latestDependencyRisk(workflowId) : null;
  let dependencyRiskOutstanding = !!dependencyRisk;
  let dependencyManifestRemediated = false;
  // Specialists run no-think to match their SFT format (see executeStage note).
  const full = makeAgentExecutor({ workspaceDir: workspace, baseUrl, model: profile.model, think: !profile.specialist, onEvent: () => {}, approve, sandboxShell: true, signal });
  const permitted = new Set(role.permittedTools);
  const defs = full.defs.filter((d) => permitted.has(d.function.name));
  let toolCalls = 0, promptTokens = 0, completionTokens = 0, contextTokens = 0;
  let eventSequence = 0, mutations = 0, lastMutationSequence = -1, lastCheckSequence = -1;
  let lastFailedCheckOutput = "";
  const pendingMutationPaths = new Map<string, string>();
  const successfulMutationPaths = new Set<string>();
  const events = (event: ToolLoopEvent) => {
    eventSequence++;
    if (event.k === "tool_request" && ["write_file", "edit_file"].includes(event.v.name) && typeof event.v.args.path === "string") {
      pendingMutationPaths.set(event.v.id, path.relative(workspace, path.resolve(workspace, event.v.args.path)));
    }
    if (event.k === "tool_result") {
      toolCalls++;
      if (event.v.ok && ["write_file", "edit_file"].includes(event.v.name)) {
        mutations++;
        lastMutationSequence = eventSequence;
        const mutatedPath = pendingMutationPaths.get(event.v.id);
        if (mutatedPath) successfulMutationPaths.add(mutatedPath);
      }
      if (event.v.name === "run_shell") {
        if (event.v.ok && /\[exit 0\]\s*$/.test(event.v.output)) lastCheckSequence = eventSequence;
        else if (!event.v.ok) lastFailedCheckOutput = event.v.output.slice(-4_000);
      }
    }
    // prompt is tracked as the PEAK context footprint, not a per-round sum: each
    // round re-sends the whole (mostly KV-cached) transcript, and summing that
    // charged a 20-round loop ~80k "inference tokens" for one node — a whole
    // standard budget burned by accounting, not by compute (observed 2026-07-10,
    // "inference-token budget exceeded (80000)"). Completion tokens still sum.
    if (event.k === "usage") { promptTokens = Math.max(promptTokens, event.v.promptTokens); completionTokens += event.v.completionTokens; contextTokens = Math.max(contextTokens, event.v.totalTokens); }
    appendHiveEvent(workflowId, { kind: `worker_${event.k}`, nodeId: node.id, role: node.role, modelVersion: profile.versionHash, payload: "v" in event ? event.v : null });
    emit({ ...event, workflowId, nodeId: node.id, role: node.role, modelVersion: profile.versionHash } as unknown as Parameters<EmitFn>[0]);
  };
  const dependencySafetyInstruction = dependencyRisk
    ? ` BLOCKING DEPENDENCY GATE: the latest install reported a critical or explicitly vulnerable dependency${dependencyRisk.packages.length ? ` (${dependencyRisk.packages.map((item) => `${item.name}@${item.version}`).join(", ")})` : ""}. Your first successful mutation MUST update package.json away from every named vulnerable version to supported compatible versions. Then call install_dependencies. Unrelated source edits remain locked until a clean installation clears this gate.`
    : "";
  const stageInstruction = mode === "mutation"
    ? `You own only this package: ${node.label} (${node.id}). Your NEXT response MUST be one native tool call, never prose: inspect the task-named source file with read_file, or call list_files with path "." if no file is named. Then implement the scoped change with write_file or edit_file and run a mechanical check AFTER your final write/edit. If read_file reports ENOENT, that conclusively means the file is absent: NEVER read that same path again; create the required file immediately with write_file. Preserve the repository's actual source-root prefixes: for example, when an existing Next.js project uses app/, place page components under app/components/ unless a configured import alias proves otherwise. HARD LIMIT: every write_file content must stay under 6000 characters; split UI work into focused component files instead of generating one giant page. Work only in the provided workspace and keep going until this package is implemented and mechanically verified, then stop for the next specialist. Treat every constraint as binding: never import or install a package unless the task explicitly permits it. When dependencies are permitted and package.json is ready, call install_dependencies; never run npm install through run_shell because the shell is intentionally network-isolated. For greenfield Node work, choose one module system (ESM or CommonJS) and keep package.json, source, and tests consistent. Use exact failure output to make the smallest repair—do not rewrite a project from scratch after a test failure.${dependencySafetyInstruction}`
    : `You are an independent read-only acceptance reviewer. Inspect the actual files and existing check output. Do not write or edit anything. Finish with exactly one JSON object: {"passed":boolean,"checks":[{"requirement":1,"passed":boolean,"detail":"observable file/test evidence"}]}. Include one check, in order, for every definition-of-done requirement. Missing or assumed evidence fails.`;
  const messages: ToolLoopMsg[] = [
    { role: "system", content: `${role.prompt}\n${stageInstruction}` },
    ...missionTranscript(workflowId),
    { role: "user", content: context },
  ];
  // Only externally visible one-shot operations get exactly-once ledger replay.
  // write_file/edit_file/run_shell were originally ledgered too, but replay is
  // keyed on (node, tool, args) alone — so inside a live repair loop, re-running
  // `npm run test` after an edit returned the CACHED pre-edit output, and an
  // identical retried edit was silently replayed. That severed the observe→act
  // loop: the model could never see the effect of its own fix and repeated one
  // wrong edit for 12 straight rounds (hive-mrfnhyj2lkeo, 2026-07-10). Workspace
  // writes and shell checks are safe and NECESSARY to re-execute for freshness.
  const mutatingTools = new Set(["git", "memory_write", "train_start", "train_stop"]);
  const durableExec = {
    ...full,
    run: async (name: string, args: Record<string, unknown>) => {
      if (dependencyRiskOutstanding && (name === "write_file" || name === "edit_file")) {
        const target = typeof args.path === "string" ? path.resolve(workspace, args.path) : "";
        if (target !== path.join(workspace, "package.json")) {
          return "error: dependency security gate is active. Edit package.json away from the recorded vulnerable version and run install_dependencies before changing unrelated files.";
        }
        const output = await full.run(name, args);
        if (output.startsWith("error:")) return output;
        let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
        try { manifest = JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf8")); }
        catch { return `${output}\nerror: package.json is not valid JSON; fix the manifest before installation.`; }
        const allDependencies = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
        const stillVulnerable = dependencyRisk?.packages.filter((item) => String(allDependencies[item.name] || "").includes(item.version)) || [];
        if (stillVulnerable.length) {
          return `error: dependency security gate remains active because package.json still declares ${stillVulnerable.map((item) => `${item.name}@${allDependencies[item.name]}`).join(", ")}. Update those exact entries to supported compatible versions.`;
        }
        dependencyManifestRemediated = true;
        return output;
      }
      if (dependencyRiskOutstanding && name === "install_dependencies") {
        if (!dependencyManifestRemediated) return "error: dependency security gate requires a successful package.json version update before reinstalling.";
        const output = await full.run(name, args);
        const unsafe = dependencyOutputHasCriticalRisk(output);
        if (!unsafe && !output.startsWith("error:") && /\[exit 0\]\s*$/.test(output)) dependencyRiskOutstanding = false;
        return output;
      }
      if (!mutatingTools.has(name)) return full.run(name, args);
      const sideEffect = beginSideEffect(workflowId, node.id, name, args);
      if (sideEffect.action === "replay") {
        appendHiveEvent(workflowId, { kind: "side_effect_replayed", nodeId: node.id, role: node.role, payload: { tool: name, fingerprint: sideEffect.fingerprint } });
        return sideEffect.output || "(completed previously; empty output)";
      }
      if (sideEffect.action === "uncertain") {
        appendHiveEvent(workflowId, { kind: "side_effect_uncertain", nodeId: node.id, role: node.role, payload: { tool: name, fingerprint: sideEffect.fingerprint } });
        return `error: this exact ${name} side effect was in flight during an interruption. It was not repeated. Inspect the workspace and use a manual override or a different corrective call.`;
      }
      try {
        const output = await full.run(name, args);
        const succeeded = !/^error:/i.test(output);
        finishSideEffect(workflowId, node.id, sideEffect.fingerprint, output, succeeded);
        return output;
      } catch (e) {
        finishSideEffect(workflowId, node.id, sideEffect.fingerprint, (e as Error).message, false);
        throw e;
      }
    },
  };
  // A greenfield mobile app routinely needs several source files plus at least
  // one check-and-repair cycle. Fourteen rounds cut off a live run immediately
  // after its fourth successful file write, before any check could run. The
  // duplicate-failure and stall breakers now bound pathological loops, so 28
  // focused rounds leaves enough room for a complete build without permitting
  // deterministic ruts to consume the whole budget.
  // Full mobile UI pages routinely exceed 3k output tokens when emitted through
  // a native write_file call. Starting mutation stages at 6k prevents a partial
  // argument from poisoning the next tool round with a backend 500.
  // Native llama.cpp Mistral and Ollama Qwen need enough headroom for inspection
  // plus a bounded tool argument. Gemma is kept at 3k because it can spend several
  // silent minutes filling a 6k cap; Qwen's faster decode was observed exhausting
  // 3k after reads/checks immediately before the required edit.
  const mutationMaxTokens = profile.provider === "ollama" && /gemma/i.test(profile.model) ? 3_000 : 6_000;
  // Qwen's thinking channel can emit XML-looking pseudo tool calls as private
  // reasoning instead of native tool_calls. Tool stages need executable calls,
  // so use the model's supported no-think template just as we do for SFT
  // specialists.
  const disableToolThinking = profile.specialist || /qwen/i.test(profile.model);
  const final = await runToolLoop({ baseUrl, model: profile.model, messages, tools: defs, exec: durableExec, onEvent: events, approve, requireMutation: mode === "mutation", initialForceMutation: !!dependencyRisk, maxRounds: mode === "mutation" ? 28 : 8, maxTokens: mode === "mutation" ? mutationMaxTokens : 3_000, ctx: Math.min(profile.contextCeiling, readSettings().options.num_ctx), ...(prepared.lora ? { lora: prepared.lora } : {}), ...(disableToolThinking ? { think: false } : {}), signal });
  const summary = [...final].reverse().find((m) => m.role === "assistant" && m.content)?.content || "Worker completed without a text report.";
  if (mode === "mutation" && mutations === 0) throw new Error("missing_mutation: implementation stage completed without a successful write_file or edit_file call");
  if (mode === "mutation" && lastCheckSequence <= lastMutationSequence) {
    throw new Error(`verification_failure: implementation stage did not run a fresh passing mechanical check after its final mutation${lastFailedCheckOutput ? `\nLast failed check output:\n${lastFailedCheckOutput}` : ""}`);
  }
  if (mode === "verification") {
    const verification = verifierResult(summary, envelope);
    return {
      result: {
        ...emptyStageResult(verification.passed ? "Independent requirement review passed." : "Independent requirement review found missing or unsupported completion evidence."),
        status: verification.passed ? "succeeded" : "needs_followup", verification,
        failureCodes: verification.passed ? [] : [verification.checks[0]?.code === "verifier_schema" ? "schema_failure" : "incomplete_requirement_coverage"],
        errors: verification.passed ? [] : verification.checks.filter((check) => !check.passed).map((check) => check.detail),
      },
      model: profile, swapMs, adapterMs, toolCalls, usage: { prompt: promptTokens, completion: completionTokens, context: contextTokens },
    };
  }
  const allChanges = workspaceChanges(filesBefore, workspaceFileSnapshot(workspace));
  // Mutation proof is tied to the files a successful write/edit actually
  // targeted. Dependency installs, lockfile updates and build output cannot make
  // an identical source rewrite look like successful implementation work.
  const changes = {
    added: allChanges.added.filter((file) => successfulMutationPaths.has(file)),
    modified: allChanges.modified.filter((file) => successfulMutationPaths.has(file)),
    deleted: allChanges.deleted.filter((file) => successfulMutationPaths.has(file)),
  };
  const changedPaths = [...changes.added, ...changes.modified, ...changes.deleted];
  if (!changedPaths.length) throw new Error("missing_mutation: write/edit tools ran but produced no observable net workspace change");
  const mutationArtifact = putArtifact(JSON.stringify(changes, null, 2), "application/json", { workflowId, nodeId: node.id, label: `${node.id}-workspace-changes.json` });
  return { result: { ...emptyStageResult(summary.slice(0, 12_000)), artifacts: [mutationArtifact], findings: [{ id: "mutation-proof", text: `${mutations} successful mutation call(s) changed ${changedPaths.length} file(s): ${changedPaths.slice(0, 30).join(", ")}. A mechanical check ran after the final mutation.` }] }, model: profile, swapMs, adapterMs, toolCalls, usage: { prompt: promptTokens, completion: completionTokens, context: contextTokens } };
}

// The repair specialist used to receive only the generic 300-char dependency
// digest of the failing check — not the actual error. It then guessed at fixes
// (inserting a function body where the bug was a duplicate declaration to
// DELETE). Ground the repair in the verbatim failing output plus tactics for
// the observed failure modes: wrong-direction edits and identical-edit ruts.
function repairBriefing(records: WorkflowNodeRecord[]): string {
  const checks = [...records].reverse().find((r) => r.action === "deterministic_checks" && r.result?.verification && !r.result.verification.passed)?.result;
  const failing = (checks?.findings || []).map((f) => f.text.slice(0, 2_500)).join("\n---\n") || "(no failing check output was captured; run the project's test command first)";
  const hints: string[] = [];
  if (/next lint[\s\S]*Invalid project directory[^\n]*\/lint/i.test(failing)) {
    hints.push("Next.js no longer supports the `next lint` subcommand in this installed version. Fix the package.json lint script to invoke the declared ESLint CLI (for example `eslint .`); do not downgrade Next.js, delete .next, or change NODE_ENV.");
  }
  if (/defined multiple times|duplicate identifier/i.test(failing)) {
    hints.push("A duplicate identifier must be removed or one import must be aliased (especially when a component and a type share a name); rewriting unrelated type exports cannot resolve the duplicate binding.");
  }
  const diagnosticHints = hints.length ? `\n\nDeterministic diagnostics:\n- ${hints.join("\n- ")}` : "";
  return `\n\nREPAIR BRIEFING — the exact failing check output below is ground truth. Reproduce it first, then make the smallest fix that changes it.\n${failing}${diagnosticHints}\n\nRepair tactics, in order: (1) run the failing command yourself to confirm the error is still current; (2) read the file named in the error before editing it; (3) remember the defect was written by a previous specialist — DELETING wrong or duplicated code (for example a stray helper function pasted into a test file) is often the correct fix, not adding more code; (4) after every edit re-run the failing command; (5) if the same edit_file has not fixed it after two tries, stop editing and rewrite that entire file cleanly with write_file. Do not change dependency versions unless the failure explicitly identifies a version incompatibility.`;
}

function requirementAudit(envelope: TaskEnvelope, deps: WorkflowNodeRecord[]): NodeExecution {
  const repair = deps.find((d) => d.nodeId === "repair");
  const mechanical = repair?.status === "succeeded" && repair.result?.verification ? repair.result.verification : deps.find((d) => d.nodeId === "checks")?.result?.verification;
  const review = deps.find((d) => d.nodeId === "final_review")?.result?.verification || deps.find((d) => d.nodeId === "acceptance_review")?.result?.verification;
  const auditChecks = envelope.definitionOfDone.map((item, i) => {
    const reviewed = review?.checks.find((check) => check.code === `requirement-${i + 1}`) || review?.checks[i];
    const passed = !!mechanical?.passed && reviewed?.passed === true;
    return {
      code: `requirement-${i + 1}`, passed,
      detail: !mechanical?.passed
        ? `Mechanical checks do not pass; cannot claim: ${item}`
        : reviewed?.detail || `Independent reviewer supplied no observable evidence for: ${item}`,
    };
  });
  const passed = !!mechanical?.passed && !!review?.passed && auditChecks.length === envelope.definitionOfDone.length && auditChecks.every((check) => check.passed);
  return { result: { ...emptyStageResult(passed ? "Mechanical checks and independent requirement evidence agree." : "Final audit rejects completion until checks and every requirement review pass."), status: passed ? "succeeded" : "needs_followup", verification: { passed, score: auditChecks.length ? auditChecks.filter((check) => check.passed).length / auditChecks.length : 0, checks: auditChecks }, failureCodes: passed ? [] : [!mechanical?.passed ? "verification_failure" : "incomplete_requirement_coverage"], errors: passed ? [] : ["False-completion guard: deterministic checks and independent requirement evidence do not both pass."] } };
}

function finalReport(workflowId: string, deps: WorkflowNodeRecord[]): NodeExecution {
  const audit = deps.find((d) => d.nodeId === "final_audit")?.result || deps.find((d) => d.nodeId === "audit")?.result;
  const review = deps.find((d) => d.nodeId === "final_review")?.result;
  const verified = !!audit?.verification?.passed;
  const findings = [...(audit?.findings || []), ...(review?.findings || [])];
  const summary = verified ? `Verified completion. ${audit?.summary || ""}` : "Unresolved failure: implementation cannot be reported complete because final mechanical and requirement verification did not pass.";
  const artifact = putArtifact(summary + "\n\n" + findings.map((f) => `- ${f.text}`).join("\n"), "text/markdown", { workflowId, nodeId: "report", label: "final-report.md" });
  return { result: { ...emptyStageResult(summary), status: verified ? "succeeded" : "failed", findings, artifacts: [artifact], verification: { passed: verified, score: verified ? 1 : 0, checks: [{ code: "verified_completion", passed: verified, detail: summary }] }, failureCodes: verified ? [] : ["verification_failure"], errors: verified ? [] : [summary] } };
}

async function executeNode(workflowId: string, executionRunId: string, node: WorkflowNode, spec: WorkflowSpec, envelope: TaskEnvelope, emit: EmitFn, signal: AbortSignal, preferredModel: string | undefined, autoApprove: boolean, retryError?: string): Promise<NodeExecution> {
  const records = getWorkflowNodes(workflowId);
  const evidence = getEvidence(workflowId);
  const context = guidedDependencyContext(workflowId, envelope, node, records, evidence);
  if (node.action === "research_search") return researchSearch(workflowId, node, envelope, records, Math.min(spec.budget.researchCalls, 8));
  if (node.action === "research_fetch") return researchFetch(workflowId, node, records, spec.budget.researchCalls);
  if (node.action === "evidence_ledger") return evidenceLedger(workflowId);
  if (node.action === "citation_verify") return citationVerify(workflowId, records);
  if (node.action === "repo_map") return repoMap(workflowId, node, envelope.workspace || process.cwd(), envelope.objective);
  if (node.action === "deterministic_checks") return deterministicChecks(workflowId, node, envelope.workspace || process.cwd(), signal);
  if (node.action === "requirement_audit") return requirementAudit(envelope, records);
  if (node.action === "final_report") return finalReport(workflowId, records);
  if (node.action === "research_followup") {
    const gaps = records.find((r) => r.nodeId === "gaps")?.result;
    if (!gaps?.uncertainties.length && gaps?.status !== "needs_followup") return { result: emptyStageResult("No targeted follow-up was required.") };
    return researchSearch(workflowId, node, { ...envelope, objective: gaps.uncertainties.join(" ") || envelope.objective }, records, Math.min(3, spec.budget.researchCalls));
  }
  const role = effectiveRole(node.role);
  if (!role) throw new Error(`role profile not found: ${node.role}`);
  // servingModel() only knows llama-server; when the mission is riding an
  // ollama model (gemma), fall back to the last node's profile id so the
  // warm-model routing bonus can actually see it and avoid a needless swap.
  const lastUsedModel = [...records].reverse().find((r) => r.modelProfileId)?.modelProfileId;
  const profile = await ensureEligibleModel(role.modelRequirements, preferredModel || rolePreferredModel(node.role), signal, node.role, servingModel() || lastUsedModel || undefined);
  if (node.action === "worker_tools" || node.action === "repair" || node.action === "verifier_tools") {
    const retryBriefing = retryError ? `\n\nRETRY CONTEXT — the previous attempt failed exactly as follows:\n${retryError}\nDo not repeat the failed action. Use this evidence to choose a different next tool call.` : "";
    const workerContext = (node.action === "repair" ? context + repairBriefing(records) : context) + retryBriefing;
    const result = await workerTools(workflowId, executionRunId, node, profile, envelope, workerContext, emit, signal, autoApprove, node.action === "verifier_tools" ? "verification" : "mutation");
    if (node.action === "repair") {
      const checked = await deterministicChecks(workflowId, node, envelope.workspace || process.cwd(), signal);
      result.result.verification = checked.result.verification; result.result.findings.push(...checked.result.findings); result.result.artifacts.push(...checked.result.artifacts);
      result.result.status = checked.result.verification?.passed ? "succeeded" : "failed";
    }
    return result;
  }
  return directModelStage(profile, node.role, context, signal, (kind, text, meta) => {
    // Durable ledger keeps the plain text (compact, replayable); the live SSE
    // event additionally carries per-token certainty for the brain-wave view.
    appendHiveEvent(workflowId, { kind: `stage_${kind}`, nodeId: node.id, role: node.role, modelVersion: profile.versionHash, payload: text });
    emit({ k: "stage_trace", workflowId, nodeId: node.id, role: node.role, modelVersion: profile.versionHash, v: { kind, text, ...(meta?.p !== undefined ? { p: meta.p } : {}), ...(meta?.alts ? { alts: meta.alts } : {}) } } as unknown as Parameters<EmitFn>[0]);
  // 3000, up from 1600: a planner emitting rich findings hit the cap mid-JSON and
  // failed the whole stage on truncation (hive-mrfxf4t866pf, 2026-07-11).
  }, 3_000);
}

// The coding template's five-stage research prelude cost ~450 wall-clock seconds
// (four ~100-150s model stages at local tok/s) before a single line of code, on a
// stdlib-only greenfield task that needed zero web evidence — and the deep run
// then died on wall-time with every implementation node still pending
// (hive-mrfqcnnwxe5s, 2026-07-10). Only pay for research when the task actually
// references the outside world; the objective text is the signal.
const CODING_RESEARCH_NODES = new Set(["research_strategy", "research_queries", "research_search", "research_read", "evidence", "research_judge"]);
const EXTERNAL_EVIDENCE_RE = /\b(https?:\/\/|research|web.search|look up|latest|up.to.date|official documentation|third.party|external (?:api|service)|npm (?:package|module)|pip install|sdk|changelog|release notes|current version)\b/i;
function needsExternalEvidence(envelope: TaskEnvelope): boolean {
  return EXTERNAL_EVIDENCE_RE.test([envelope.objective, envelope.requiredOutput, ...envelope.constraints, ...envelope.definitionOfDone].join(" "));
}

function shouldSkipOptional(node: WorkflowNode, records: WorkflowNodeRecord[], spec: WorkflowSpec, envelope: TaskEnvelope): boolean {
  if (!node.optional) return false;
  if (spec.kind === "coding" && CODING_RESEARCH_NODES.has(node.id)) return !needsExternalEvidence(envelope);
  if (node.id === "followup") {
    if (spec.budget.name === "normal") return true;
    const gaps = records.find((r) => r.nodeId === "gaps")?.result;
    return gaps?.status !== "needs_followup" && !gaps?.uncertainties.length;
  }
  if (node.id === "repair") return !!records.find((r) => r.nodeId === "audit")?.result?.verification?.passed;
  return false;
}

function classifyFailure(error: string, node: WorkflowNode, execution?: NodeExecution): HiveFailureCode {
  const text = `${error} ${execution?.result.errors.join(" ") || ""}`.toLowerCase();
  if (/missing_mutation|without a successful write|no tool calls/.test(text)) return "missing_mutation";
  if (/invalid.*tool|tool.*argument|malformed.*call/.test(text)) return "malformed_tool_call";
  if (/invalid stageresult|schema|json/.test(text)) return "schema_failure";
  if (/context budget|context.*exhaust|handoff/.test(text)) return "context_loss";
  if (/token budget|swap budget|budget exceeded/.test(text)) return "budget_exhaustion";
  if (/backend|fetch failed|econn|socket|gpu|device|timed out|timeout/.test(text)) return "infrastructure_failure";
  if (node.id === "plan" || node.id === "plan_judge") return "failed_decomposition";
  if (node.id === "repair") return "incorrect_repair";
  if (["acceptance_review", "audit", "final_review", "final_audit"].includes(node.id)) return "incomplete_requirement_coverage";
  return "verification_failure";
}

function persistStageDocument(workflowId: string, node: WorkflowNode, execution: NodeExecution): void {
  if (!["model", "worker_tools", "repair", "verifier_tools"].includes(node.action)) return;
  const result = execution.result;
  const markdown = [
    `# ${node.label}`,
    `Role: ${node.role}  `,
    `Status: ${result.status}`,
    "",
    result.summary,
    ...(result.findings.length ? ["", "## Findings", ...result.findings.map((finding) => `- ${finding.text}`)] : []),
    ...(result.uncertainties.length ? ["", "## Uncertainties", ...result.uncertainties.map((item) => `- ${item}`)] : []),
    ...(result.verification ? ["", "## Verification", ...result.verification.checks.map((check) => `- ${check.passed ? "PASS" : "FAIL"} — ${check.code}: ${check.detail}`)] : []),
  ].join("\n");
  const artifact = putArtifact(markdown, "text/markdown", { workflowId, nodeId: node.id, label: `${node.id}.md` });
  if (!result.artifacts.some((item) => item.hash === artifact.hash)) result.artifacts.push(artifact);
}

async function executeWorkflow(workflowId: string, executionRunId: string, emit: EmitFn, signal: AbortSignal, options: { preferredModel?: string; autoApprove: boolean }): Promise<void> {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("workflow disappeared");
  const { spec, envelope, budget } = workflow;
  let retriesUsed = 0, inferenceTokens = 0, swaps = 0;
  updateWorkflow(workflowId, { status: "running", startedAt: workflow.startedAt || Date.now(), executionRunId });
  appendHiveEvent(workflowId, { kind: "workflow_started", payload: { executionRunId, budget } });
  emit({ k: "workflow_started", workflowId, v: { workflowId, executionRunId, spec: spec.id, budget } });

  while (!signal.aborted) {
    // Deliberately NO run-level wall clock: local missions are slow by design and
    // "wall-time budget exceeded" killed runs with every implementation node still
    // pending (2026-07-10). Effort is bounded by cycles/retries/token backstop.
    if (inferenceTokens > budget.inferenceTokens) throw new Error(`inference-token budget exceeded (${budget.inferenceTokens})`);
    const records = getWorkflowNodes(workflowId);
    const pending = records.filter((r) => !TERMINAL_NODE.has(r.status));
    if (!pending.length) break;
    const ready = spec.nodes.filter((node) => {
      const record = records.find((r) => r.nodeId === node.id)!;
      return !TERMINAL_NODE.has(record.status) && node.dependsOn.every((dep) => COMPLETE_DEP.has(records.find((r) => r.nodeId === dep)?.status || "pending"));
    });
    if (!ready.length) {
      const failedDeps = records.filter((r) => r.status === "failed");
      throw new Error(failedDeps.length ? `blocked by failed node(s): ${failedDeps.map((r) => r.nodeId).join(", ")}` : "workflow graph is deadlocked");
    }
    const node = ready[0];
    const record = records.find((r) => r.nodeId === node.id)!;
    if (shouldSkipOptional(node, records, spec, envelope)) {
      updateNode(workflowId, node.id, { status: "skipped", finishedAt: Date.now(), result: emptyStageResult("Optional node was deterministically skipped.") });
      appendHiveEvent(workflowId, { kind: "node_skipped", nodeId: node.id, role: node.role, payload: { reason: "not required by upstream result or budget" } });
      continue;
    }
    const decision: RoutingDecision = { version: HIVE_CONTRACT_VERSION, action: "dispatch", targetNodeId: node.id, reason: "dependencies satisfied", uncertainty: 0 };
    emitRouting(workflowId, emit, spec, decision);
    const started = Date.now();
    const retryError = record.error || undefined;
    const handoff = JSON.parse(guidedDependencyContext(workflowId, envelope, node, records, getEvidence(workflowId))) as SpecialistHandoff;
    // The receiving specialist gets the bounded dependency digest in its prompt;
    // persist the same handoff as a first-class event so the UI can show exactly
    // what crossed the agent boundary, not just each isolated thought trace.
    appendHiveEvent(workflowId, { kind: "agent_handoff", nodeId: node.id, role: node.role, payload: { ...handoff, from: handoff.dependencies.map((dependency) => ({ nodeId: dependency.nodeId, summary: dependency.summary, status: dependency.status, uncertainties: dependency.uncertainties })), to: handoff.target } });
    updateNode(workflowId, node.id, { status: "running", attempt: record.attempt + 1, startedAt: started, error: "" });
    appendHiveEvent(workflowId, { kind: "node_started", nodeId: node.id, role: node.role, payload: { attempt: record.attempt + 1, inputs: node.dependsOn } });
    emit({ k: "workflow_node", workflowId, nodeId: node.id, role: node.role, v: { status: "running", attempt: record.attempt + 1 } });
    // Kept outside the try so the catch can persist real token/tool counts for a
    // node that executed but failed its gate — those showed as 0 before, hiding
    // exactly the runs an autopsy most needs to see.
    let execution: NodeExecution | undefined;
    try {
      // Per-node timeout is hang protection only (a wedged backend, a stuck
      // model load) — not an effort limit. This controller covers model probing,
      // loading, inference, and tool work alike; stop/pause stay real paths.
      const timeout = Math.max(1, node.timeoutMs ?? 30 * 60_000);
      const timeoutController = new AbortController();
      const abort = () => timeoutController.abort(); signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => timeoutController.abort(), timeout);
      try { execution = await executeNode(workflowId, executionRunId, node, spec, envelope, emit, timeoutController.signal, options.preferredModel, options.autoApprove, retryError); }
      finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
      persistStageDocument(workflowId, node, execution);
      // Preserve a real conversational spine across DAG stages. Dependency
      // artifacts remain available separately, while the next specialist also
      // receives the prior request/result turns in normal chat-role order.
      appendMissionTranscript(
        workflowId,
        `Stage ${node.label} (${node.id}) was asked to: ${handoff.ownedPackage}. ${handoff.task.objective}`,
        execution.result.summary || "Stage completed without a prose summary; inspect its recorded artifacts and checks.",
      );
      inferenceTokens += (execution.usage?.prompt ?? 0) + (execution.usage?.completion ?? 0);
      if (execution.swapMs) swaps++;
      if (swaps > budget.modelSwaps) throw new Error(`model-swap budget exceeded (${budget.modelSwaps})`);
      const gateFailed = node.verificationGate && !execution.result.verification?.passed;
      const hardFailure = execution.result.status === "failed" || execution.result.status === "blocked" || gateFailed;
      const allowRepairPath = ["checks", "acceptance_review", "audit", "final_review", "final_audit"].includes(node.id);
      if (hardFailure && !allowRepairPath) throw new Error(execution.result.errors.join("; ") || `verification gate failed for ${node.id}`);
      const finished = Date.now();
      updateNode(workflowId, node.id, {
        status: "succeeded", finishedAt: finished, durationMs: finished - started, result: execution.result,
        modelProfileId: execution.model?.id, modelVersion: execution.model?.versionHash, promptTokens: execution.usage?.prompt ?? 0,
        completionTokens: execution.usage?.completion ?? 0, contextTokens: execution.usage?.context ?? 0, swapMs: execution.swapMs ?? 0, adapterMs: execution.adapterMs ?? 0, toolCalls: execution.toolCalls ?? 0,
      });
      // Only outcome signals with deterministic evidence train the lightweight
      // router. Intermediate planning prose is intentionally not treated as a
      // quality label, preventing a verbose but wrong model from self-promoting.
      if (execution.model && execution.result.verification) {
        recordRoleOutcome(execution.model.id, node.role, execution.result.verification.score ?? (execution.result.verification.passed ? 1 : 0));
      }
      for (const ev of execution.result.evidence) putEvidence(workflowId, node.id, ev);
      appendHiveEvent(workflowId, { kind: "node_finished", nodeId: node.id, role: node.role, modelVersion: execution.model?.versionHash, payload: { status: execution.result.status, durationMs: finished - started, artifacts: execution.result.artifacts.map((a) => a.hash), verification: execution.result.verification, usage: execution.usage, swapMs: execution.swapMs ?? 0, adapterMs: execution.adapterMs ?? 0, adapterId: execution.model?.specialist?.id, ...(execution.confidence ? { confidence: execution.confidence } : {}) } });
      emit({ k: "workflow_node", workflowId, nodeId: node.id, role: node.role, modelVersion: execution.model?.versionHash, v: { status: "succeeded", result: execution.result, durationMs: finished - started } });
    } catch (e) {
      const error = signal.aborted ? "cancelled" : (e as Error).message;
      const failureCode = classifyFailure(error, node, execution);
      if (execution && !execution.result.failureCodes?.includes(failureCode)) execution.result.failureCodes = [...(execution.result.failureCodes || []), failureCode];
      const attempt = record.attempt + 1;
      const canRetry = !signal.aborted && attempt < node.retry.maxAttempts && retriesUsed < budget.retries;
      appendHiveEvent(workflowId, { kind: "node_failed", nodeId: node.id, role: node.role, payload: { error, failureCode, attempt, retrying: canRetry } });
      if (canRetry) {
        retriesUsed++;
        updateNode(workflowId, node.id, { status: "pending", attempt, error });
        emitRouting(workflowId, emit, spec, { version: HIVE_CONTRACT_VERSION, action: "retry", targetNodeId: node.id, reason: error.slice(0, 500), uncertainty: .2 });
        // Infrastructure failures need recovery TIME, not a hot retry: a 250ms
        // backoff re-ran a judge straight into a wedged GPU twice in 37s and
        // killed the mission — while the kernel log showed the amdgpu reset
        // completing seconds later (hive-mrfz9ls8m429, 2026-07-11). Escalate
        // the wait for backend-shaped errors so drivers/servers can come back.
        const infraFailure = /fetch failed|model backend 5\d\d|could not start the model|ECONN|socket|terminated/i.test(error);
        await new Promise((resolve) => setTimeout(resolve, infraFailure ? Math.min(60_000, 20_000 * attempt) : node.retry.backoffMs));
        continue;
      }
      updateNode(workflowId, node.id, {
        status: signal.aborted ? "cancelled" : "failed", attempt, finishedAt: Date.now(), durationMs: Date.now() - started, error,
        ...(execution ? { result: execution.result, promptTokens: execution.usage?.prompt ?? 0, completionTokens: execution.usage?.completion ?? 0, contextTokens: execution.usage?.context ?? 0, swapMs: execution.swapMs ?? 0, adapterMs: execution.adapterMs ?? 0, toolCalls: execution.toolCalls ?? 0, modelProfileId: execution.model?.id, modelVersion: execution.model?.versionHash } : {}),
      });
      throw e;
    }
  }
  if (signal.aborted) throw new Error("cancelled");
  const finalNodes = getWorkflowNodes(workflowId);
  const failed = finalNodes.filter((n) => n.status === "failed");
  if (failed.length) throw new Error(`workflow failed at: ${failed.map((n) => n.nodeId).join(", ")}`);
  updateWorkflow(workflowId, { status: "succeeded", finishedAt: Date.now(), error: "" });
  emitRouting(workflowId, emit, spec, { version: HIVE_CONTRACT_VERSION, action: "finish", reason: "all required nodes and verification gates completed", uncertainty: 0 });
  appendHiveEvent(workflowId, { kind: "workflow_finished", payload: { inferenceTokens, swaps, retriesUsed } });
  emit({ k: "workflow_finished", workflowId, v: { status: "succeeded", inferenceTokens, swaps, retriesUsed } });
}

function enqueueWorkflow(workflowId: string, options: { preferredModel?: string; autoApprove: boolean }): string {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("workflow not found");
  const meta = startRun({ kind: "hive", conversationId: workflowId, project: workflow.envelope.workspace, model: options.preferredModel || "auto", mode: workflow.kind }, async (emit, signal) => {
    const previous = hg.__hive_gpu_tail ?? Promise.resolve();
    let release!: () => void;
    hg.__hive_gpu_tail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    if (signal.aborted) { live.delete(workflowId); release(); return; }
    try { await executeWorkflow(workflowId, meta.id, emit, signal, options); }
    catch (e) {
      const paused = hg.__hive_pause_requested!.delete(workflowId);
      const cancelled = !paused && (signal.aborted || (e as Error).message === "cancelled");
      updateWorkflow(workflowId, { status: paused ? "paused" : cancelled ? "cancelled" : "failed", finishedAt: Date.now(), error: paused ? "paused by user" : (e as Error).message });
      appendHiveEvent(workflowId, { kind: paused ? "workflow_paused" : cancelled ? "workflow_cancelled" : "workflow_failed", payload: { error: (e as Error).message } });
      throw e;
    } finally { live.delete(workflowId); release(); }
  });
  live.set(workflowId, { workflowId, executionRunId: meta.id });
  updateWorkflow(workflowId, { status: "queued", executionRunId: meta.id });
  return meta.id;
}

export function startHiveWorkflow(options: StartOptions): { workflowId: string; runId: string } {
  // Persist the exact directory every coding role will see. This also covers
  // replay/continuation and programmatic callers that bypass the HTTP route.
  const envelope = options.kind === "coding"
    ? { ...options.envelope, workspace: path.resolve(options.envelope.workspace || process.cwd()) }
    : options.envelope;
  const envelopeErrors = validateTaskEnvelope(envelope);
  if (envelopeErrors.length) throw new Error(envelopeErrors.join("; "));
  const spec = options.spec ?? workflowTemplate(options.kind, options.budget ?? "normal");
  const specErrors = validateWorkflowSpec(spec);
  if (specErrors.length) throw new Error(specErrors.join("; "));
  if (spec.kind !== options.kind) throw new Error("workflow spec kind does not match requested kind");
  const id = `hive-${newId()}`;
  const createdAt = Date.now();
  createWorkflow({ id, kind: options.kind, templateId: spec.id, status: "queued", envelope, spec, budget: spec.budget, working: { ...(options.working || {}), controlMode: options.autoApprove ? "autopilot" : "supervised", preferredModel: options.preferredModel || "auto" }, parentWorkflowId: options.parentWorkflowId, createdAt, updatedAt: createdAt });
  appendHiveEvent(id, { kind: "workflow_created", payload: { spec: spec.id, budget: spec.budget.name, envelope } });
  const runId = enqueueWorkflow(id, { preferredModel: options.preferredModel, autoApprove: !!options.autoApprove });
  return { workflowId: id, runId };
}

export function stopHiveWorkflow(id: string): boolean {
  const active = live.get(id);
  const workflow = getWorkflow(id);
  if (!workflow) return false;
  hg.__hive_pause_requested!.delete(id);
  updateWorkflow(id, { status: "cancelled", finishedAt: Date.now(), error: "stopped by user" });
  appendHiveEvent(id, { kind: "workflow_stop_requested", payload: {} });
  return active ? stopRun(active.executionRunId) : true;
}

// Used by the application-wide emergency brake.  Hive has durable workflow
// status in addition to the generic run registry, so aborting only the run left
// missions displayed as running until a later refresh/recovery.
export function stopAllHiveWorkflows(): string[] {
  const ids = [...live.keys()];
  for (const id of ids) stopHiveWorkflow(id);
  return ids;
}

export function pauseHiveWorkflow(id: string): boolean {
  const active = live.get(id);
  const workflow = getWorkflow(id);
  if (!workflow) return false;
  if (!active) { updateWorkflow(id, { status: "paused", error: "paused by user" }); return true; }
  hg.__hive_pause_requested!.add(id);
  updateWorkflow(id, { status: "paused", error: "paused by user" });
  appendHiveEvent(id, { kind: "workflow_pause_requested", payload: {} });
  return stopRun(active.executionRunId);
}

export function resumeHiveWorkflow(id: string, preferredModel?: string, autoApprove = false): string {
  const workflow = getWorkflow(id);
  if (!workflow) throw new Error("workflow not found");
  if (workflow.status === "succeeded") throw new Error("completed workflows cannot be resumed; replay them instead");
  if (live.has(id)) return live.get(id)!.executionRunId;
  resetInterruptedNodes(id);
  resetFailedNodes(id);
  // A resume is a fresh execution window over preserved durable nodes; startedAt
  // resets so the UI's elapsed clock reflects this window (no wall-time budget).
  updateWorkflow(id, { status: "queued", startedAt: Date.now(), finishedAt: undefined, error: "", working: { ...workflow.working, controlMode: autoApprove ? "autopilot" : "supervised", preferredModel: preferredModel || workflow.working.preferredModel || "auto" } });
  appendHiveEvent(id, { kind: "workflow_resumed", payload: { completedNodesPreserved: true } });
  return enqueueWorkflow(id, { preferredModel, autoApprove });
}

export function replayHiveWorkflow(id: string, overrides: { budget?: BudgetName; preferredModel?: string; autoApprove?: boolean } = {}) {
  const workflow = getWorkflow(id);
  if (!workflow) throw new Error("workflow not found");
  return startHiveWorkflow({ kind: workflow.kind, budget: overrides.budget, envelope: workflow.envelope, preferredModel: overrides.preferredModel, autoApprove: overrides.autoApprove, parentWorkflowId: id });
}

// A conversation turn is a new durable execution (so cancellation, replay and
// provenance remain unambiguous), but it is NOT a new mission from the user's
// point of view.  It carries a bounded digest of the prior turn plus the running
// operator transcript into every new specialist context.
export function continueHiveWorkflow(id: string, message: string, options: { budget?: BudgetName; preferredModel?: string; autoApprove?: boolean } = {}) {
  const parent = getWorkflow(id);
  if (!parent) throw new Error("workflow not found");
  const followup = message.trim().slice(0, 8_000);
  if (!followup) throw new Error("a follow-up message is required");
  if (live.has(id)) throw new Error("wait for the current turn to finish, or use guidance to steer it");
  const priorNodes = getWorkflowNodes(id).filter((node) => node.result).map((node) => ({
    node: node.nodeId, status: node.status, summary: node.result!.summary.slice(0, 1_200),
    findings: node.result!.findings.slice(0, 6).map((finding) => ({ ...finding, text: finding.text.slice(0, 400) })),
    verification: node.result!.verification ? { passed: node.result!.verification.passed, score: node.result!.verification.score } : undefined,
  }));
  const priorGuidance = Array.isArray(parent.working.operatorMessages) ? parent.working.operatorMessages.slice(-20) : [];
  const parentContext = { objective: parent.envelope.objective, requiredOutput: parent.envelope.requiredOutput, definitionOfDone: parent.envelope.definitionOfDone, status: parent.status, nodes: priorNodes, guidance: priorGuidance };
  const inheritedConversation = Array.isArray(parent.working.conversation) ? parent.working.conversation : [{ role: "user", text: parent.envelope.objective }];
  const working = {
    parentContext,
    operatorMessages: [...priorGuidance, { id: `followup-${newId()}`, ts: Date.now(), message: followup }].slice(-50),
    conversation: [...inheritedConversation, { role: "user", text: followup }].slice(-100),
  };
  const envelope: TaskEnvelope = { ...parent.envelope, objective: followup };
  const inheritedModel = typeof parent.working.preferredModel === "string" && parent.working.preferredModel !== "auto" ? parent.working.preferredModel : undefined;
  const started = startHiveWorkflow({ kind: parent.kind, budget: options.budget ?? parent.budget.name, envelope, preferredModel: options.preferredModel || inheritedModel, autoApprove: !!options.autoApprove, spec: parent.spec, parentWorkflowId: id, working });
  appendHiveEvent(started.workflowId, { kind: "workflow_continued", payload: { parentWorkflowId: id, message: followup } });
  return started;
}

export function approveHiveAction(callId: string, allow: boolean): boolean {
  const liveResolved = resolveApproval(callId, allow);
  const storedResolved = resolveStoredApproval(callId, allow);
  return liveResolved || storedResolved;
}

export function overrideHiveNode(workflowId: string, nodeId: string, action: "skip" | "retry"): void {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("workflow not found");
  if (live.has(workflowId)) throw new Error("pause the workflow before overriding a node");
  const node = workflow.spec.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error("node not found");
  const record = getWorkflowNodes(workflowId).find((candidate) => candidate.nodeId === nodeId);
  if (action === "skip" && !node.optional) throw new Error("only predefined optional nodes can be skipped");
  updateNode(workflowId, nodeId, action === "skip"
    ? { status: "skipped", finishedAt: Date.now(), result: emptyStageResult("Manually skipped while paused.") }
    : { status: "pending", attempt: 0, startedAt: undefined, finishedAt: undefined, error: record?.error || "manually queued for retry" });
  updateWorkflow(workflowId, { status: "paused", finishedAt: undefined, error: "manual override applied; resume when ready" });
  appendHiveEvent(workflowId, { kind: "manual_override", nodeId, role: node.role, payload: { action } });
}

export function steerHiveWorkflow(workflowId: string, message: string, pause = false): { ok: true; paused: boolean; appliedFrom: "next_node" | "resumed_node" } {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("workflow not found");
  if (workflow.status === "succeeded") throw new Error("completed workflows cannot be steered; replay the run instead");
  const text = message.trim().slice(0, 8_000);
  if (!text) throw new Error("guidance is required");
  const previous = Array.isArray(workflow.working.operatorMessages) ? workflow.working.operatorMessages as unknown[] : [];
  const entry = { id: `operator-${newId()}`, ts: Date.now(), message: text };
  updateWorkflow(workflowId, { working: { ...workflow.working, operatorMessages: [...previous, entry].slice(-50) } });
  appendHiveEvent(workflowId, { kind: "operator_message", payload: entry });
  if (pause) pauseHiveWorkflow(workflowId);
  return { ok: true, paused: pause, appliedFrom: pause ? "resumed_node" : "next_node" };
}

export function deleteHiveWorkflow(id: string): boolean {
  if (live.has(id)) throw new Error("stop the workflow before deleting it");
  return deleteWorkflow(id);
}

export function recoverHiveWorkflows(): string[] {
  if (hg.__hive_recovered) return [];
  hg.__hive_recovered = true;
  const recovered: string[] = [];
  for (const workflow of listWorkflows(200)) {
    if (!["running", "queued", "awaiting_approval"].includes(workflow.status) || live.has(workflow.id)) continue;
    resetInterruptedNodes(workflow.id);
    appendHiveEvent(workflow.id, { kind: "workflow_recovered", payload: { completedNodesPreserved: true, completedSideEffectsReplayedFromLedger: true, uncertainSideEffectsNotRepeated: true } });
    enqueueWorkflow(workflow.id, { autoApprove: false }); recovered.push(workflow.id);
  }
  return recovered;
}

export { workflowSnapshot };
