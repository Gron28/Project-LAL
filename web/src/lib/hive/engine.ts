import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { makeAgentExecutor } from "../agent-tools";
import { ensureServing, newId, readSettings, SERVE_PORT, servingModel, stopServing, webSearch } from "../lab";
import { requestApproval, resolveApproval, startRun, stopRun, type EmitFn } from "../runs";
import { runToolLoop, type ToolLoopEvent, type ToolLoopMsg } from "../toolloop";
import { webFetch } from "../agent-tools";
import {
  HIVE_CONTRACT_VERSION, emptyStageResult, validateRoutingDecision, validateTaskEnvelope, validateWorkflowSpec,
  type ArtifactRef, type EvidenceRecord, type ModelProfile, type RoleProfile, type RoutingDecision, type StageResult, type TaskEnvelope, type WorkflowNode, type WorkflowSpec,
} from "./contracts";
import { ROLE_PROFILES, workflowTemplate } from "./presets";
import { ensureEligibleModel } from "./model-registry";
import {
  appendHiveEvent, beginSideEffect, createApproval, createWorkflow, deleteWorkflow, finishSideEffect, getEvidence, getRoleOverrides, getWorkflow, getWorkflowNodes, listWorkflows, putArtifact, putEvidence,
  resetInterruptedNodes, resolveStoredApproval, updateNode, updateWorkflow, workflowSnapshot, type WorkflowNodeRecord,
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

type StartOptions = { kind: "research" | "coding"; budget?: "quick" | "standard" | "deep"; envelope: TaskEnvelope; preferredModel?: string; autoApprove?: boolean; spec?: WorkflowSpec; parentWorkflowId?: string };
type NodeExecution = { result: StageResult; usage?: { prompt: number; completion: number; context: number }; toolCalls?: number; model?: ModelProfile; swapMs?: number };
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

function emitRouting(workflowId: string, emit: EmitFn, spec: WorkflowSpec, decision: RoutingDecision): void {
  if (!validateRoutingDecision(decision, spec)) throw new Error("internal coordinator produced an invalid routing decision");
  appendHiveEvent(workflowId, { kind: "routing_decision", payload: decision });
  emit({ k: "workflow_routing", workflowId, v: decision });
}

function modelBaseUrl(profile: ModelProfile): Promise<string> {
  if (profile.provider === "ollama" && /gemma/i.test(profile.model)) { stopServing(); return Promise.resolve("http://127.0.0.1:11434"); }
  return ensureServing(profile.model, Math.min(profile.contextCeiling, readSettings().options.num_ctx)).then(() => `http://127.0.0.1:${SERVE_PORT}`);
}

function dependencyContext(envelope: TaskEnvelope, node: WorkflowNode, records: WorkflowNodeRecord[], evidence: EvidenceRecord[]): string {
  const deps = records.filter((r) => r.result && (node.dependsOn.includes(r.nodeId) || r.status === "succeeded")).slice(-12).map((r) => ({
    node: r.nodeId, status: r.result!.status, summary: r.result!.summary.slice(0, 4_000), findings: r.result!.findings.slice(0, 20),
    artifacts: r.result!.artifacts.slice(0, 8), uncertainties: r.result!.uncertainties.slice(0, 12), verification: r.result!.verification,
  }));
  return JSON.stringify({ task: envelope, dependencyResults: deps, evidence: evidence.slice(-48) });
}

function guidedDependencyContext(workflowId: string, envelope: TaskEnvelope, node: WorkflowNode, records: WorkflowNodeRecord[], evidence: EvidenceRecord[]): string {
  const base = JSON.parse(dependencyContext(envelope, node, records, evidence)) as Record<string, unknown>;
  const working = getWorkflow(workflowId)?.working || {};
  const messages = Array.isArray(working.operatorMessages) ? working.operatorMessages.slice(-12) : [];
  return JSON.stringify({ ...base, operatorGuidance: messages });
}

async function directModelStage(profile: ModelProfile, roleId: string, promptContext: string, signal: AbortSignal): Promise<NodeExecution> {
  const role = effectiveRole(roleId);
  if (!role) throw new Error(`unknown role: ${roleId}`);
  if (role.coordinator && role.permittedTools.length) throw new Error("coordinator roles cannot have worker tools");
  const before = servingModel();
  const swapStarted = Date.now();
  const baseUrl = await modelBaseUrl(profile);
  const swapMs = before && before !== profile.model ? Date.now() - swapStarted : 0;
  const body = {
    model: profile.model, temperature: 0, max_tokens: 1_600,
    messages: [
      { role: "system", content: `${role.prompt}\nReturn one JSON object matching the supplied StageResult schema. Do not add markdown fences.` },
      { role: "user", content: promptContext },
    ],
    response_format: { type: "json_schema", json_schema: { name: "stage_result", strict: true, schema: STAGE_RESULT_SCHEMA } },
  };
  let response = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error(`model backend ${response.status}`);
  let payload = await response.json() as Record<string, unknown>;
  let content = String(((payload.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content) ?? "");
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { parsed = null; }
  // One bounded repair attempt for backends that ignore response_format.
  if (!isStageResult(parsed)) {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ model: profile.model, temperature: 0, max_tokens: 1_600, messages: [
        { role: "system", content: "Repair the candidate into exactly one valid StageResult JSON object. No prose or markdown." },
        { role: "user", content: JSON.stringify({ schema: STAGE_RESULT_SCHEMA, candidate: content.slice(0, 12_000) }) },
      ] }),
    });
    if (!response.ok) throw new Error(`structured-output repair failed: ${response.status}`);
    payload = await response.json() as Record<string, unknown>;
    content = String(((payload.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content) ?? "");
    try { parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, "")); } catch { parsed = null; }
  }
  if (!isStageResult(parsed)) throw new Error("model returned invalid StageResult after one repair attempt");
  // A model can reference canonical evidence IDs in findings, but it cannot mint
  // evidence or artifact records. Only deterministic fetch/write boundaries own
  // hashes, retrieval timestamps, and filesystem paths.
  parsed.artifacts = [];
  parsed.evidence = [];
  parsed.verification = undefined;
  const usage = payload.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  return { result: parsed, model: profile, swapMs, usage: { prompt: usage?.prompt_tokens ?? 0, completion: usage?.completion_tokens ?? 0, context: usage?.total_tokens ?? 0 } };
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
  const search = deps.find((d) => d.nodeId === "search")?.result;
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

function repoMap(workflowId: string, node: WorkflowNode, workspace: string): NodeExecution {
  const root = path.resolve(workspace);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`workspace is not a directory: ${root}`);
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
  const priority = files.filter((file) => /(^|\/)(README[^/]*|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|[^/]*test[^/]*)$/i.test(file) || /^(src|lib)\//.test(file)).slice(0, 10);
  const excerpts = priority.map((file) => {
    try { return { file, content: fs.readFileSync(path.join(root, file), "utf8").slice(0, 6_000) }; }
    catch { return { file, content: "[unreadable or binary]" }; }
  });
  const artifact = putArtifact(JSON.stringify({ root, files, manifests, excerpts, truncated: files.length >= 2_000 }, null, 2), "application/json", { workflowId, nodeId: node.id, label: "repository-map.json" });
  return { result: { ...emptyStageResult(`Mapped ${files.length} files and inspected ${excerpts.length} high-signal files. Manifests: ${manifests.join(", ") || "none"}.`), artifacts: [artifact], findings: excerpts.map((entry, i) => ({ id: `repo-${i}`, text: `${entry.file}\n${entry.content}` })) } };
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal): Promise<{ ok: boolean; output: string; command: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
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
    const names = ["test", "typecheck", "lint"].filter((name) => scripts[name] && !/no test specified/i.test(scripts[name]));
    for (const name of names.slice(0, 3)) checks.push(await runProcess("npm", ["run", name], workspace, 180_000, signal));
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

async function workerTools(workflowId: string, executionRunId: string, node: WorkflowNode, profile: ModelProfile, envelope: TaskEnvelope, context: string, emit: EmitFn, signal: AbortSignal, autoApprove: boolean): Promise<NodeExecution> {
  const workspace = path.resolve(envelope.workspace || process.cwd());
  const before = servingModel(); const swapStarted = Date.now();
  const baseUrl = await modelBaseUrl(profile); const swapMs = before && before !== profile.model ? Date.now() - swapStarted : 0;
  const approve = async (call: { id: string; name: string; args: Record<string, unknown> }) => {
    if (autoApprove) return true;
    createApproval(call.id, workflowId, node.id, "tool", call);
    updateWorkflow(workflowId, { status: "awaiting_approval" }); updateNode(workflowId, node.id, { status: "awaiting_approval" });
    const allowed = await requestApproval(executionRunId, emit, call);
    resolveStoredApproval(call.id, allowed); updateWorkflow(workflowId, { status: "running" }); updateNode(workflowId, node.id, { status: "running" });
    return allowed;
  };
  const role = effectiveRole(node.role);
  const full = makeAgentExecutor({ workspaceDir: workspace, baseUrl, model: profile.model, think: true, onEvent: () => {}, approve, signal });
  const permitted = new Set(role.permittedTools);
  const defs = full.defs.filter((d) => permitted.has(d.function.name));
  let toolCalls = 0, promptTokens = 0, completionTokens = 0, contextTokens = 0;
  const events = (event: ToolLoopEvent) => {
    if (event.k === "tool_result") toolCalls++;
    if (event.k === "usage") { promptTokens += event.v.promptTokens; completionTokens += event.v.completionTokens; contextTokens = Math.max(contextTokens, event.v.totalTokens); }
    appendHiveEvent(workflowId, { kind: `worker_${event.k}`, nodeId: node.id, role: node.role, modelVersion: profile.versionHash, payload: "v" in event ? event.v : null });
    emit({ ...event, workflowId, nodeId: node.id, role: node.role, modelVersion: profile.versionHash } as unknown as Parameters<EmitFn>[0]);
  };
  const messages: ToolLoopMsg[] = [
    { role: "system", content: `${role.prompt}\nWork only in the provided workspace. Keep going until the task is implemented and mechanically verified.` },
    { role: "user", content: context },
  ];
  const mutatingTools = new Set(["write_file", "edit_file", "run_shell", "git", "memory_write", "train_start", "train_stop"]);
  const durableExec = {
    ...full,
    run: async (name: string, args: Record<string, unknown>) => {
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
  const final = await runToolLoop({ baseUrl, model: profile.model, messages, tools: defs, exec: durableExec, onEvent: events, approve, requireMutation: true, maxRounds: 20, maxTokens: 1_500, ctx: Math.min(profile.contextCeiling, readSettings().options.num_ctx), signal });
  const summary = [...final].reverse().find((m) => m.role === "assistant" && m.content)?.content || "Worker completed without a text report.";
  return { result: { ...emptyStageResult(summary.slice(0, 12_000)) }, model: profile, swapMs, toolCalls, usage: { prompt: promptTokens, completion: completionTokens, context: contextTokens } };
}

function requirementAudit(envelope: TaskEnvelope, deps: WorkflowNodeRecord[]): NodeExecution {
  const checks = deps.find((d) => d.nodeId === "checks")?.result?.verification;
  const passed = !!checks?.passed;
  const auditChecks = envelope.definitionOfDone.map((item, i) => ({ code: `requirement-${i + 1}`, passed, detail: passed ? `Covered by passing deterministic checks: ${item}` : `Cannot claim completion while deterministic checks fail: ${item}` }));
  return { result: { ...emptyStageResult(passed ? "Requirements and deterministic checks agree." : "Requirement audit rejects completion until checks pass."), status: passed ? "succeeded" : "needs_followup", verification: { passed, score: passed ? 1 : 0, checks: auditChecks }, errors: passed ? [] : ["False-completion guard: deterministic checks and completion claim disagree."] } };
}

function finalReport(workflowId: string, deps: WorkflowNodeRecord[]): NodeExecution {
  const audit = deps.find((d) => d.nodeId === "audit")?.result;
  const repair = deps.find((d) => d.nodeId === "repair")?.result;
  const verified = !!audit?.verification?.passed || !!repair?.verification?.passed;
  const findings = [...(audit?.findings || []), ...(repair?.findings || [])];
  const summary = verified ? `Verified completion. ${repair?.summary || audit?.summary || ""}` : "Unresolved failure: implementation cannot be reported complete because verification did not pass.";
  const artifact = putArtifact(summary + "\n\n" + findings.map((f) => `- ${f.text}`).join("\n"), "text/markdown", { workflowId, nodeId: "report", label: "final-report.md" });
  return { result: { ...emptyStageResult(summary), status: verified ? "succeeded" : "failed", findings, artifacts: [artifact], verification: { passed: verified, score: verified ? 1 : 0, checks: [{ code: "verified_completion", passed: verified, detail: summary }] }, errors: verified ? [] : [summary] } };
}

async function executeNode(workflowId: string, executionRunId: string, node: WorkflowNode, spec: WorkflowSpec, envelope: TaskEnvelope, emit: EmitFn, signal: AbortSignal, preferredModel: string | undefined, autoApprove: boolean): Promise<NodeExecution> {
  const records = getWorkflowNodes(workflowId);
  const evidence = getEvidence(workflowId);
  const context = guidedDependencyContext(workflowId, envelope, node, records, evidence);
  if (node.action === "research_search") return researchSearch(workflowId, node, envelope, records, Math.min(spec.budget.researchCalls, 8));
  if (node.action === "research_fetch") return researchFetch(workflowId, node, records, spec.budget.researchCalls);
  if (node.action === "evidence_ledger") return evidenceLedger(workflowId);
  if (node.action === "citation_verify") return citationVerify(workflowId, records);
  if (node.action === "repo_map") return repoMap(workflowId, node, envelope.workspace || process.cwd());
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
  const profile = await ensureEligibleModel(role.modelRequirements, preferredModel || rolePreferredModel(node.role));
  if (node.action === "worker_tools" || node.action === "repair") {
    const result = await workerTools(workflowId, executionRunId, node, profile, envelope, context, emit, signal, autoApprove);
    if (node.action === "repair") {
      const checked = await deterministicChecks(workflowId, node, envelope.workspace || process.cwd(), signal);
      result.result.verification = checked.result.verification; result.result.findings.push(...checked.result.findings); result.result.artifacts.push(...checked.result.artifacts);
      result.result.status = checked.result.verification?.passed ? "succeeded" : "failed";
    }
    return result;
  }
  return directModelStage(profile, node.role, context, signal);
}

function shouldSkipOptional(node: WorkflowNode, records: WorkflowNodeRecord[], spec: WorkflowSpec): boolean {
  if (!node.optional) return false;
  if (node.id === "followup") {
    if (spec.budget.name === "quick") return true;
    const gaps = records.find((r) => r.nodeId === "gaps")?.result;
    return gaps?.status !== "needs_followup" && !gaps?.uncertainties.length;
  }
  if (node.id === "repair") return !!records.find((r) => r.nodeId === "audit")?.result?.verification?.passed;
  return false;
}

async function executeWorkflow(workflowId: string, executionRunId: string, emit: EmitFn, signal: AbortSignal, options: { preferredModel?: string; autoApprove: boolean }): Promise<void> {
  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("workflow disappeared");
  const { spec, envelope, budget } = workflow;
  const deadline = (workflow.startedAt || Date.now()) + budget.wallTimeMs;
  let retriesUsed = 0, inferenceTokens = 0, swaps = 0;
  updateWorkflow(workflowId, { status: "running", startedAt: workflow.startedAt || Date.now(), executionRunId });
  appendHiveEvent(workflowId, { kind: "workflow_started", payload: { executionRunId, budget } });
  emit({ k: "workflow_started", workflowId, v: { workflowId, executionRunId, spec: spec.id, budget } });

  while (!signal.aborted) {
    if (Date.now() > deadline) throw new Error(`wall-time budget exceeded (${budget.name})`);
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
    if (shouldSkipOptional(node, records, spec)) {
      updateNode(workflowId, node.id, { status: "skipped", finishedAt: Date.now(), result: emptyStageResult("Optional node was deterministically skipped.") });
      appendHiveEvent(workflowId, { kind: "node_skipped", nodeId: node.id, role: node.role, payload: { reason: "not required by upstream result or budget" } });
      continue;
    }
    const decision: RoutingDecision = { version: HIVE_CONTRACT_VERSION, action: "dispatch", targetNodeId: node.id, reason: "dependencies satisfied", uncertainty: 0 };
    emitRouting(workflowId, emit, spec, decision);
    const started = Date.now();
    updateNode(workflowId, node.id, { status: "running", attempt: record.attempt + 1, startedAt: started, error: "" });
    appendHiveEvent(workflowId, { kind: "node_started", nodeId: node.id, role: node.role, payload: { attempt: record.attempt + 1, inputs: node.dependsOn } });
    emit({ k: "workflow_node", workflowId, nodeId: node.id, role: node.role, v: { status: "running", attempt: record.attempt + 1 } });
    try {
      const timeout = node.timeoutMs ?? Math.min(10 * 60_000, Math.max(30_000, deadline - Date.now()));
      const timeoutController = new AbortController();
      const abort = () => timeoutController.abort(); signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => timeoutController.abort(), timeout);
      let execution: NodeExecution;
      try { execution = await executeNode(workflowId, executionRunId, node, spec, envelope, emit, timeoutController.signal, options.preferredModel, options.autoApprove); }
      finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
      inferenceTokens += (execution.usage?.prompt ?? 0) + (execution.usage?.completion ?? 0);
      if (execution.swapMs) swaps++;
      if (swaps > budget.modelSwaps) throw new Error(`model-swap budget exceeded (${budget.modelSwaps})`);
      const gateFailed = node.verificationGate && !execution.result.verification?.passed;
      const hardFailure = execution.result.status === "failed" || execution.result.status === "blocked" || gateFailed;
      const allowRepairPath = ["checks", "audit"].includes(node.id);
      if (hardFailure && !allowRepairPath) throw new Error(execution.result.errors.join("; ") || `verification gate failed for ${node.id}`);
      const finished = Date.now();
      updateNode(workflowId, node.id, {
        status: "succeeded", finishedAt: finished, durationMs: finished - started, result: execution.result,
        modelProfileId: execution.model?.id, modelVersion: execution.model?.versionHash, promptTokens: execution.usage?.prompt ?? 0,
        completionTokens: execution.usage?.completion ?? 0, contextTokens: execution.usage?.context ?? 0, swapMs: execution.swapMs ?? 0, toolCalls: execution.toolCalls ?? 0,
      });
      for (const ev of execution.result.evidence) putEvidence(workflowId, node.id, ev);
      appendHiveEvent(workflowId, { kind: "node_finished", nodeId: node.id, role: node.role, modelVersion: execution.model?.versionHash, payload: { status: execution.result.status, durationMs: finished - started, artifacts: execution.result.artifacts.map((a) => a.hash), verification: execution.result.verification, usage: execution.usage, swapMs: execution.swapMs ?? 0 } });
      emit({ k: "workflow_node", workflowId, nodeId: node.id, role: node.role, modelVersion: execution.model?.versionHash, v: { status: "succeeded", result: execution.result, durationMs: finished - started } });
    } catch (e) {
      const error = signal.aborted ? "cancelled" : (e as Error).message;
      const attempt = record.attempt + 1;
      const canRetry = !signal.aborted && attempt < node.retry.maxAttempts && retriesUsed < budget.retries;
      appendHiveEvent(workflowId, { kind: "node_failed", nodeId: node.id, role: node.role, payload: { error, attempt, retrying: canRetry } });
      if (canRetry) {
        retriesUsed++;
        updateNode(workflowId, node.id, { status: "pending", attempt, error });
        emitRouting(workflowId, emit, spec, { version: HIVE_CONTRACT_VERSION, action: "retry", targetNodeId: node.id, reason: error.slice(0, 500), uncertainty: .2 });
        await new Promise((resolve) => setTimeout(resolve, node.retry.backoffMs));
        continue;
      }
      updateNode(workflowId, node.id, { status: signal.aborted ? "cancelled" : "failed", attempt, finishedAt: Date.now(), durationMs: Date.now() - started, error });
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
  const envelopeErrors = validateTaskEnvelope(options.envelope);
  if (envelopeErrors.length) throw new Error(envelopeErrors.join("; "));
  const spec = options.spec ?? workflowTemplate(options.kind, options.budget ?? "standard");
  const specErrors = validateWorkflowSpec(spec);
  if (specErrors.length) throw new Error(specErrors.join("; "));
  if (spec.kind !== options.kind) throw new Error("workflow spec kind does not match requested kind");
  const id = `hive-${newId()}`;
  const createdAt = Date.now();
  createWorkflow({ id, kind: options.kind, templateId: spec.id, status: "queued", envelope: options.envelope, spec, budget: spec.budget, working: { controlMode: options.autoApprove ? "autopilot" : "supervised", preferredModel: options.preferredModel || "auto" }, parentWorkflowId: options.parentWorkflowId, createdAt, updatedAt: createdAt });
  appendHiveEvent(id, { kind: "workflow_created", payload: { spec: spec.id, budget: spec.budget.name, envelope: options.envelope } });
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
  updateWorkflow(id, { status: "queued", finishedAt: undefined, error: "", working: { ...workflow.working, controlMode: autoApprove ? "autopilot" : "supervised", preferredModel: preferredModel || workflow.working.preferredModel || "auto" } });
  appendHiveEvent(id, { kind: "workflow_resumed", payload: { completedNodesPreserved: true } });
  return enqueueWorkflow(id, { preferredModel, autoApprove });
}

export function replayHiveWorkflow(id: string, overrides: { budget?: "quick" | "standard" | "deep"; preferredModel?: string; autoApprove?: boolean } = {}) {
  const workflow = getWorkflow(id);
  if (!workflow) throw new Error("workflow not found");
  return startHiveWorkflow({ kind: workflow.kind, budget: overrides.budget, envelope: workflow.envelope, preferredModel: overrides.preferredModel, autoApprove: overrides.autoApprove, parentWorkflowId: id });
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
  if (action === "skip" && !node.optional) throw new Error("only predefined optional nodes can be skipped");
  updateNode(workflowId, nodeId, action === "skip"
    ? { status: "skipped", finishedAt: Date.now(), result: emptyStageResult("Manually skipped while paused.") }
    : { status: "pending", finishedAt: undefined, error: "manually queued for retry" });
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
