"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, Circle, Code2, FileText, FolderTree, Pause, Play, RotateCcw, Send, Settings2, ShieldCheck, Square, User, X } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SignalTrace } from "@/components/ui/signal-trace";
import { ICON_SIZE } from "@/components/ui/icon";
import FileTree from "@/components/code/file-tree";
import EditorPane from "@/components/code/editor-pane";

type Artifact = { hash: string; mediaType: string; size: number; label?: string };
type Finding = { id: string; text: string; evidenceIds?: string[]; confidence?: number };
type Verification = { passed: boolean; score?: number; checks: { code: string; passed: boolean; detail: string }[] };
type StageResult = { status: string; summary: string; findings: Finding[]; artifacts: Artifact[]; uncertainties: string[]; errors: string[]; verification?: Verification };
type Evidence = { id: string; url: string; retrievedAt: number; sourceHash: string; excerpt: string; stance: string; claim?: string; title?: string };
type Workflow = {
  id: string; kind: "research" | "coding"; status: string; templateId: string; executionRunId?: string;
  createdAt: number; updatedAt: number; startedAt?: number; finishedAt?: number; error?: string;
  working?: { controlMode?: string; verdict?: { outcome: string; reason: string; uncheckedProperties?: string[]; criteria?: { id: string; text: string; state: string; detail?: string }[] }; operatorMessages?: { id: string; ts: number; message: string }[]; conversation?: { role: string; text: string }[] };
  envelope: { objective: string; latestUserRequest?: string; requiredOutput: string; definitionOfDone: string[]; constraints: string[]; artifactRefs: Artifact[]; workspace?: string; deliverables?: { id: string; description: string; path?: string; required: boolean }[]; permissions?: string[] };
  budget: { name: string; cycles?: number; inferenceTokens?: number };
  spec: { nodes: { id: string; optional?: boolean; dependsOn?: string[] }[] };
};
type Node = {
  nodeId: string; label: string; role: string; status: string; attempt: number; modelVersion?: string;
  startedAt?: number; finishedAt?: number; durationMs?: number; promptTokens: number; completionTokens: number;
  contextTokens: number; swapMs: number; adapterMs?: number; toolCalls: number; result?: StageResult; error?: string;
};
type HiveEvent = { schemaVersion?: number; eventId?: string; seq: number; ts: number; kind: string; invocationId?: string; traceId?: string; spanId?: string; parentSpanId?: string; lifecycle?: string; nodeId?: string; role?: string; modelVersion?: string; payloadRedacted?: boolean; payload: unknown };
// Per-node live buffers built directly from the run's SSE stream — the page's
// realtime layer. The durable snapshot stays the source of truth for structure
// (nodes, results, status); these buffers are what make tokens visible the
// moment they decode instead of after the stage finishes.
type LiveCall = { name: string; ok?: boolean };
type LiveUsage = { promptTokens: number; completionTokens: number; totalTokens: number; tokPerSec: number | null; ctx: number; conf?: { avg: number; min: number; low: number } | null };
type LiveAlt = { token: string; p: number; alts: [string, number][] };
type LiveNode = { thinking: string; text: string; calls: LiveCall[]; progress: { name: string; chars: number; preview: string } | null; usage: LiveUsage | null; wave: number[]; alts: LiveAlt[]; rounds: number };
type Diagnosis = { verdict: string; findings: { code: string; nodeId?: string; detail: string; severity: string }[]; stats: { nodes: number; completed: number; retries: number; swaps: number; evidence: number } };
type Snapshot = { workflow: Workflow; nodes: Node[]; evidence: Evidence[]; events: HiveEvent[]; diagnosis?: Diagnosis };
type PendingApproval = { id: string; name: string; args: Record<string, unknown> };
type RoleProfile = { id: string; coordinator?: boolean; prompt: string; permittedTools: string[]; modelRequirements: string[]; evaluationSuite: string };
type RoleOverride = { prompt?: string; preferredModel?: string };
type ModelProfileInfo = { id: string; provider: string; model: string; capabilities: string[]; probeStatus: string; specialist?: { role: string; promotionStatus: string } };
type HiveReadiness = { examples: number; datasets: number; checkpoints: number; specialists: { candidate: number; promoted: number; rejected: number }; roleExamples: Record<string, number>; quarantined: number };
type ViewTab = "conversation" | "dashboard" | "workspace" | "plan" | "evidence" | "agents" | "audit";
type MissionProjection = {
  generatedAt: number;
  mission: { objective: string; conclusion: string; nextAction: string; blocker: string | null; elapsedMs: number; forecastMs: number; workflowStatus: string; criteria: { id: string; text: string; state: string }[] };
  graph: { criticalPathMs: number; executionWindowMs: number; concurrency: number; currentNodeId?: string; nodes: { id: string; label: string; status: string; attempt: number; durationMs: number; checkpoint?: { eventId: string } | null }[]; routes: { from: string; to: string }[]; checkpoints: { eventId: string; nodeId?: string; ts: number }[] };
  timeline: { eventId: string; seq: number; ts: number; kind: string; nodeId?: string; gapFromPreviousMs: number }[];
  agents: { nodeId: string; role: string; modelVersion: string; promptTokens: number; completionTokens: number; contextTokens: number; durationMs: number; decodeTokensPerSecond: number | null; finishReason: string }[];
  tools: { eventId: string; nodeId?: string; tool?: string; ok?: boolean; latencyMs?: number; approval?: unknown; idempotency?: unknown; resultSize?: number | null; sideEffectClass?: string }[];
  research: { sources: { evidenceId: string; eventId?: string; url: string; origin: string; sourceClass: string; authorityScore: number | null; ageMs: number }[]; independentOrigins: number; contradictions: unknown[]; unresolvedGaps: string[]; claims: unknown[]; entailmentChecks: unknown[]; marginalReturn: number };
  coding: { artifacts: Artifact[]; checks: { nodeId: string; code: string; passed: boolean; detail: string }[]; mutations: unknown[]; browserChecks: unknown[]; uncheckedBehavior: string[] };
  resources: { promptTokens: number; completionTokens: number; modelSwapMs: number; toolCalls: number; hostMetricsEndpoint: string };
  quality: { outcome: string; acceptancePassed: number; acceptanceTotal: number; firstDivergence?: string; trajectoryEfficiency: number; falseCompletionGuard: boolean; interventions: { eventId: string; kind: string; ts: number }[]; baselineWorkflowId: string | null };
  ledgerHealth: { firstSeq: number; lastSeq: number; visibleEvents: number; sequenceGap: boolean; anomalies: unknown[]; unknownEventVersions: unknown[]; snapshotAgeMs: number };
};

const TERMINAL = new Set(["succeeded", "complete", "incomplete", "blocked", "failed", "cancelled"]);
const RUN_TERMINAL = new Set(["done", "error", "stopped", "interrupted"]);
const LIVE_WORKFLOW = new Set(["queued", "running", "awaiting_approval"]);
const statusColor = (status: string) => status === "succeeded" || status === "complete" ? "var(--accent-success)" : ["failed", "cancelled", "incomplete", "blocked"].includes(status) ? "var(--accent-danger)" : status === "running" ? "var(--accent-warn)" : "var(--muted)";

function StatusIcon({ status }: { status: string }) {
  if (status === "succeeded" || status === "complete") return <Check size={ICON_SIZE.sm} />;
  if (["failed", "cancelled", "incomplete", "blocked"].includes(status)) return <X size={ICON_SIZE.sm} />;
  if (status === "running") return <SignalTrace size="sm" />;
  if (status === "paused" || status === "awaiting_approval") return <Pause size={ICON_SIZE.sm} />;
  return <Circle size={ICON_SIZE.sm} />;
}

function nodeThinking(events: HiveEvent[], nodeId: string) {
  let thinking = "", text = "";
  const calls: string[] = [];
  const handoffs: { from: string; summary: string; status: string; uncertainties: string[] }[] = [];
  for (const event of events) {
    if (event.nodeId !== nodeId) continue;
    if (event.kind === "worker_think" || event.kind === "stage_reasoning") thinking += String(event.payload ?? "");
    else if (event.kind === "worker_text" || event.kind === "stage_output") text += String(event.payload ?? "");
    else if (event.kind === "agent_handoff") {
      const payload = event.payload as { from?: { nodeId?: string; summary?: string; status?: string; uncertainties?: string[] }[] } | null;
      for (const item of payload?.from || []) handoffs.push({ from: item.nodeId || "previous stage", summary: item.summary || "No summary was produced.", status: item.status || "unknown", uncertainties: item.uncertainties || [] });
    }
    else if (event.kind === "worker_tool_request") { const payload = event.payload as { name?: string } | null; if (payload?.name) calls.push(`→ ${payload.name}`); }
    else if (event.kind === "worker_tool_result") { const payload = event.payload as { name?: string; ok?: boolean } | null; if (payload?.name) calls.push(`${payload.ok ? "✓" : "✗"} ${payload.name}`); }
  }
  return { thinking, text, calls, handoffs };
}

export default function HivePage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [roles, setRoles] = useState<Record<string, RoleProfile>>({});
  const [roleOverrides, setRoleOverrides] = useState<Record<string, RoleOverride>>({});
  const [models, setModels] = useState<ModelProfileInfo[]>([]);
  const [readiness, setReadiness] = useState<HiveReadiness>({ examples: 0, datasets: 0, checkpoints: 0, specialists: { candidate: 0, promoted: 0, rejected: 0 }, roleExamples: {}, quarantined: 0 });
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [editModel, setEditModel] = useState("");
  const [roleBusy, setRoleBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [kind, setKind] = useState<"research" | "coding">("research");
  const [budget, setBudget] = useState("normal");
  const [objective, setObjective] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [preferredModel, setPreferredModel] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ViewTab>("conversation");
  const [guidance, setGuidance] = useState("");
  const [steerBusy, setSteerBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [workspaceFile, setWorkspaceFile] = useState<string | null>(null);
  const [workspaceTick, setWorkspaceTick] = useState(0);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const didAutoSelectRef = useRef(false);

  const esRef = useRef<EventSource | null>(null);
  const attachedRunIdRef = useRef<string | null>(null);
  const reloadRef = useRef<(id: string) => void>(() => {});
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable Map identity, mutated in place by the SSE handler; liveTick is the
  // only piece of React state token deltas ever touch (via the flush clock).
  const [liveNodes] = useState(() => new Map<string, LiveNode>());
  const liveDirtyRef = useRef(false);
  const [liveTick, setLiveTick] = useState(0);

  // Token deltas arrive tens of times per second; committing them straight to
  // React state would re-render the whole page per token. Buffers mutate in the
  // ref, and this single clock flushes them to the UI at a fixed cadence.
  useEffect(() => {
    const timer = setInterval(() => { if (liveDirtyRef.current) { liveDirtyRef.current = false; setLiveTick((tick) => tick + 1); } }, 150);
    return () => clearInterval(timer);
  }, []);

  const loadList = useCallback(async () => {
    try {
      const data = await fetch("/api/hive/workflows", { cache: "no-store" }).then((response) => response.json());
      setWorkflows(data.workflows || []); setRoles(data.roles || {}); setRoleOverrides(data.roleOverrides || {}); setModels(data.models || []); if (data.readiness) setReadiness(data.readiness);
      if (typeof data.defaultWorkspace === "string") setWorkspace((current) => current || data.defaultWorkspace);
    } catch { /* model swaps can briefly interrupt the local API */ }
  }, []);

  // Snapshot refetch is a THROTTLE with a guaranteed trailing fire — never a
  // restarting debounce. The old 400ms debounce reset on every SSE message, so
  // during continuous token streaming (deltas every ~30ms) it literally never
  // fired: the page went dark for entire multi-minute stages and then updated
  // all at once. Token events now bypass this entirely (they mutate the live
  // buffers); only structural events schedule a snapshot reload.
  const scheduleReload = useCallback((id: string, immediate = false) => {
    if (immediate) {
      if (reloadTimerRef.current) { clearTimeout(reloadTimerRef.current); reloadTimerRef.current = null; }
      reloadRef.current(id);
      return;
    }
    if (reloadTimerRef.current) return;
    reloadTimerRef.current = setTimeout(() => { reloadTimerRef.current = null; reloadRef.current(id); }, 700);
  }, []);

  const loadSnapshot = useCallback(async (id: string) => {
    try {
      const detail = await fetch(`/api/hive/workflows/${id}?events=2000`, { cache: "no-store" }).then((response) => response.json());
      if (!detail.workflow) return;
      setSnapshot(detail); setAutoApprove(detail.workflow.working?.controlMode === "autopilot");
      const runId: string | undefined = detail.workflow.executionRunId;
      if (runId && LIVE_WORKFLOW.has(detail.workflow.status) && attachedRunIdRef.current !== runId) {
        esRef.current?.close(); attachedRunIdRef.current = runId;
        // Fresh attach: the stream replays this run's whole ledger from seq 0,
        // so the live buffers are rebuilt complete — no gaps, no duplicates.
        liveNodes.clear();
        const stream = new EventSource(`/api/agent/runs/${runId}/stream?after=0`); esRef.current = stream;
        const touch = (nodeId: string): LiveNode => {
          let node = liveNodes.get(nodeId);
          if (!node) { node = { thinking: "", text: "", calls: [], progress: null, usage: null, wave: [], alts: [], rounds: 0 }; liveNodes.set(nodeId, node); }
          return node;
        };
        stream.onmessage = (message) => {
          let event: { k?: string; nodeId?: string; v?: unknown };
          try { event = JSON.parse(message.data); } catch { return; }
          const k = event.k || "";
          // Token-level and tool-level events apply straight to the live buffers.
          if (event.nodeId && ["stage_trace", "think", "text", "tool_progress", "tool_request", "tool_result", "usage", "round"].includes(k)) {
            const node = touch(event.nodeId);
            if (k === "stage_trace") {
              const v = event.v as { kind?: string; text?: string; p?: number; alts?: [string, number][] };
              if (v.kind === "reasoning") node.thinking += v.text || ""; else node.text += v.text || "";
              if (typeof v.p === "number") { node.wave.push(v.p); if (node.wave.length > 1600) node.wave.splice(0, node.wave.length - 1600); }
              if (v.alts?.length && v.text?.trim()) { node.alts.push({ token: v.text, p: v.p ?? 0, alts: v.alts }); if (node.alts.length > 12) node.alts.shift(); }
            } else if (k === "think") node.thinking += String(event.v ?? "");
            else if (k === "text") node.text += String(event.v ?? "");
            else if (k === "tool_progress") { const v = event.v as { name?: string; chars?: number; preview?: string }; node.progress = { name: v.name || "tool", chars: v.chars || 0, preview: v.preview || "" }; }
            else if (k === "tool_request") { const v = event.v as { name?: string }; node.progress = null; node.calls.push({ name: v.name || "tool" }); }
            else if (k === "tool_result") { const v = event.v as { name?: string; ok?: boolean }; node.progress = null; const open = [...node.calls].reverse().find((call) => call.name === (v.name || "tool") && call.ok === undefined); if (open) open.ok = !!v.ok; if (v.ok && ["write_file", "edit_file"].includes(v.name || "")) setWorkspaceTick((tick) => tick + 1); }
            else if (k === "usage") node.usage = event.v as LiveUsage;
            else if (k === "round") node.rounds++;
            liveDirtyRef.current = true;
            return;
          }
          if (k === "approval_needed") setPendingApproval(event.v as PendingApproval);
          else if (k === "approval_result") setPendingApproval(null);
          const ended = k === "status" && typeof event.v === "string" && RUN_TERMINAL.has(event.v);
          if (ended) { stream.close(); if (esRef.current === stream) { esRef.current = null; attachedRunIdRef.current = null; } }
          scheduleReload(id, ended);
        };
      }
    } catch { /* keep the last durable snapshot visible */ }
  }, [scheduleReload, liveNodes]);

  useEffect(() => { reloadRef.current = loadSnapshot; }, [loadSnapshot]);
  useEffect(() => { const initial = setTimeout(loadList, 0); const timer = setInterval(loadList, 5_000); return () => { clearTimeout(initial); clearInterval(timer); }; }, [loadList]);
  useEffect(() => {
    if (didAutoSelectRef.current || selected || !workflows.length) return;
    didAutoSelectRef.current = true;
    const latest = workflows[0];
    setSelected(latest.id);
    setActiveTab(latest.kind === "coding" ? "workspace" : "conversation");
    setMobileSidebarOpen(false);
  }, [selected, workflows]);
  useEffect(() => {
    esRef.current?.close(); esRef.current = null; attachedRunIdRef.current = null; liveNodes.clear();
    if (!selected) { const timer = setTimeout(() => { setSnapshot(null); setPendingApproval(null); setExpandedNode(null); setWorkspaceFile(null); }, 0); return () => clearTimeout(timer); }
    const timer = setTimeout(() => { setPendingApproval(null); setExpandedNode(null); setWorkspaceFile(null); loadSnapshot(selected); }, 0);
    return () => { clearTimeout(timer); if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current); esRef.current?.close(); esRef.current = null; attachedRunIdRef.current = null; liveNodes.clear(); };
  }, [selected, loadSnapshot, liveNodes]);

  const start = async () => {
    if (!objective.trim()) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/hive/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        kind, budget, objective, ...(kind === "coding" && workspace.trim() ? { workspace: workspace.trim() } : {}),
        ...(preferredModel ? { preferredModel } : {}), autoApprove,
        definitionOfDone: [kind === "coding" ? "Implementation satisfies the request and deterministic project checks pass" : "Every important factual claim references fetched-source evidence"],
      }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "could not start workflow");
      setSelected(data.workflowId); setActiveTab(kind === "coding" ? "workspace" : "conversation"); setMobileSidebarOpen(false); setObjective(""); await loadList();
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  };

  const action = async (name: "stop" | "pause" | "resume" | "replay") => {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/hive/workflows/${selected}/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(name === "resume" || name === "replay" ? { autoApprove } : {}) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || `${name} failed`);
      if (name === "replay") setSelected(data.workflowId); else await loadSnapshot(selected); await loadList();
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  };

  const respondApproval = async (allow: boolean) => {
    if (!selected || !pendingApproval) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/hive/workflows/${selected}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: pendingApproval.id, allow }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "approval failed"); setPendingApproval(null);
    } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  };

  const steer = async (pause: boolean) => {
    if (!selected || !guidance.trim()) return;
    setSteerBusy(true); setError("");
    try {
      const response = await fetch(`/api/hive/workflows/${selected}/steer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: guidance, pause }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "guidance failed");
      setGuidance(""); await loadSnapshot(selected); await loadList();
    } catch (reason) { setError((reason as Error).message); } finally { setSteerBusy(false); }
  };

  const continueMission = async () => {
    if (!selected || !guidance.trim()) return;
    setSteerBusy(true); setError("");
    try {
      const response = await fetch(`/api/hive/workflows/${selected}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: guidance, autoApprove }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "could not continue mission");
      setGuidance(""); setSelected(data.workflowId); setActiveTab("conversation"); await loadList();
    } catch (reason) { setError((reason as Error).message); } finally { setSteerBusy(false); }
  };

  const overrideNode = async (nodeId: string, nodeAction: "retry" | "skip") => {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/hive/workflows/${selected}/override`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId, action: nodeAction }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || `${nodeAction} failed`);
    } catch (reason) { setError((reason as Error).message); setBusy(false); return; }
    await action("resume");
  };

  const deleteRun = async (id: string) => {
    if (!confirm("Delete this hive run? This can't be undone.")) return;
    try {
      const response = await fetch(`/api/hive/workflows/${id}`, { method: "DELETE" }); const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "delete failed"); if (selected === id) setSelected(""); await loadList();
    } catch (reason) { setError((reason as Error).message); }
  };

  const startEditRole = (role: RoleProfile) => { setEditingRole(role.id); setEditPrompt(role.prompt); setEditModel(roleOverrides[role.id]?.preferredModel || ""); };
  const saveRole = async (roleId: string) => {
    setRoleBusy(true); setError("");
    try {
      const response = await fetch(`/api/hive/roles/${roleId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: editPrompt, preferredModel: editModel }) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "save failed"); setEditingRole(null); await loadList();
    } catch (reason) { setError((reason as Error).message); } finally { setRoleBusy(false); }
  };
  const resetRole = async (roleId: string) => {
    if (!confirm(`Reset "${roleId}" to its default prompt and model?`)) return;
    setRoleBusy(true); setError("");
    try { const response = await fetch(`/api/hive/roles/${roleId}`, { method: "DELETE" }); if (!response.ok) throw new Error("reset failed"); setEditingRole(null); await loadList(); }
    catch (reason) { setError((reason as Error).message); } finally { setRoleBusy(false); }
  };

  const completed = snapshot?.nodes.filter((node) => ["succeeded", "skipped"].includes(node.status)).length ?? 0;
  const activeNode = snapshot?.nodes.find((node) => ["running", "awaiting_approval"].includes(node.status));
  const usedTokens = snapshot?.nodes.reduce((sum, node) => sum + node.promptTokens + node.completionTokens, 0) ?? 0;
  const elapsedMs = snapshot?.workflow.startedAt ? (snapshot.workflow.finishedAt || snapshot.workflow.updatedAt) - snapshot.workflow.startedAt : 0;
  const rolesWithData = ["coordinator_planner", "coder_repairer", "verifier"].filter((role) => (readiness.roleExamples[role] || 0) > 0).length;

  return (
    <main id="main-content" className="min-h-dvh lg:h-dvh lg:overflow-hidden bg-[var(--bg)] text-[var(--text)] px-3 py-3 pb-20 lg:pb-3">
      <h1 className="sr-only">Hive mission control</h1>
      <div className="max-w-[1700px] h-full mx-auto flex flex-col gap-2">
        <div className="shrink-0 min-h-10 px-3 py-2 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-1)] flex items-center gap-3">
          <div className="flex items-center gap-2 min-w-0"><Bot size={16} className="text-[var(--accent-ai)] shrink-0" /><div className="min-w-0"><div className="text-xs font-semibold uppercase tracking-[0.14em] truncate">Hive mission control</div><div className="text-[11px] text-[var(--muted)] truncate"><span className="sm:hidden">Role data {rolesWithData}/3 · promoted {readiness.specialists.promoted}/3</span><span className="hidden sm:inline">Live agents, files, plans, research, and verification in one workspace</span></div></div></div>
          <div className="ml-auto hidden sm:flex items-center gap-1.5 text-[8px] uppercase tracking-wide"><span className="px-2 py-1 rounded-full border border-[var(--border)] text-[var(--text-2)]">3 role contracts</span><span className="px-2 py-1 rounded-full border border-[var(--border)] text-[var(--text-2)]">Role data {rolesWithData}/3</span><span className="px-2 py-1 rounded-full border" style={{ color: readiness.specialists.promoted === 3 ? "var(--accent-success)" : "var(--accent-warn)", borderColor: readiness.specialists.promoted === 3 ? "var(--accent-success)" : "var(--accent-warn)" }}>{readiness.specialists.promoted}/3 promoted</span>{snapshot && <span className="px-2 py-1 rounded-full border" style={{ color: statusColor(snapshot.workflow.status), borderColor: statusColor(snapshot.workflow.status) }}>{snapshot.workflow.status}</span>}</div>
          <button onClick={() => setMobileSidebarOpen((open) => !open)} aria-expanded={mobileSidebarOpen} className="lg:hidden ml-auto h-10 px-3 rounded border border-[var(--border)] text-xs text-[var(--accent-ai)]">{mobileSidebarOpen ? "Close missions" : "Missions"}</button>
        </div>
        <div className="flex-1 min-h-0 grid lg:grid-cols-[310px_minmax(0,1fr)] gap-3 items-start lg:items-stretch">
        <aside className={`${mobileSidebarOpen ? "flex" : "hidden"} lg:flex flex-col gap-2 lg:min-h-0`}>
          <Panel className="flex flex-col gap-2 shrink-0">
            <div className="flex items-center justify-between gap-2"><div className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-2)]">New mission</div><ModeSwitch auto={autoApprove} onChange={setAutoApprove} /></div>
            <div className="grid grid-cols-2 gap-1">{(["research", "coding"] as const).map((value) => <button key={value} onClick={() => setKind(value)} className="h-8 rounded-[var(--r-md)] border text-[10px] uppercase tracking-wide" style={{ borderColor: kind === value ? "var(--accent-ai)" : "var(--border)", color: kind === value ? "var(--accent-ai)" : "var(--text-2)", background: kind === value ? "color-mix(in srgb, var(--accent-ai) 10%, transparent)" : "var(--surface-2)" }}>{value}</button>)}</div>
            <textarea aria-label="Mission objective" value={objective} onChange={(event) => setObjective(event.target.value)} placeholder={kind === "research" ? "What should the team investigate?" : "What should the team build or repair?"} className="w-full min-h-24 max-h-40 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-3 text-sm leading-relaxed resize-y outline-none focus:border-[var(--border-loud)]" />
            {kind === "coding" && <input aria-label="Workspace path" value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="Absolute workspace path" className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2.5 text-xs outline-none focus:border-[var(--border-loud)]" />}
            <div className="grid grid-cols-2 gap-2"><select aria-label="Mission budget" value={budget} onChange={(event) => setBudget(event.target.value)} className="min-h-10 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2 text-[11px]"><option value="normal">Normal pass · 1 repair cycle</option><option value="thorough">Thorough · 3 repair cycles</option><option value="extra">Extra thorough · 6 repair cycles</option></select><select aria-label="Preferred model" value={preferredModel} onChange={(event) => setPreferredModel(event.target.value)} className="min-h-10 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2 text-[11px]"><option value="">Models: by role</option>{models.map((model) => <option key={model.id} value={model.id}>{model.specialist ? `${model.specialist.role} · ${model.specialist.promotionStatus}` : model.model}</option>)}</select></div>
            <p className="text-[9px] text-[var(--muted)] leading-relaxed">{autoApprove ? "Autopilot runs permitted tools automatically. Verification gates remain mandatory." : "Supervised mode stops for mutating tools and accepts guidance throughout the run."}</p>
            <Button active disabled={busy || !objective.trim()} onClick={start} className="w-full justify-center font-bold text-xs disabled:opacity-40">Start {kind} mission</Button>
            {error && <p className="text-[10px] text-[var(--accent-danger)] leading-relaxed">{error}</p>}
          </Panel>

          <Panel padding="none" className="overflow-hidden lg:flex-1 lg:min-h-0">
            <div className="px-3 py-2 border-b border-[var(--border)] flex items-center text-[9px] uppercase tracking-[0.16em] text-[var(--muted)]">Runs <span className="ml-auto">{workflows.length}</span></div>
            <div className="max-h-[42vh] lg:max-h-none lg:h-[calc(100%-33px)] overflow-auto">{workflows.map((workflow) => <RunRow key={workflow.id} workflow={workflow} selected={selected === workflow.id} open={() => { setSelected(workflow.id); setActiveTab(workflow.kind === "coding" ? "workspace" : "conversation"); setMobileSidebarOpen(false); }} remove={() => deleteRun(workflow.id)} />)}{!workflows.length && <div className="p-4 text-[10px] text-[var(--muted)]">No missions yet.</div>}</div>
          </Panel>
          <button onClick={() => setActiveTab("agents")} className="h-9 flex items-center gap-2 px-3 rounded-[var(--r-md)] border border-[var(--border)] text-[10px] text-[var(--text-2)] hover:border-[var(--border-loud)]"><Settings2 size={13} /> Configure agents <span className="ml-auto text-[var(--muted)]">{Object.keys(roles).length}</span></button>
        </aside>

        <section className="min-w-0 flex flex-col gap-2 lg:min-h-0 lg:h-full">
          {snapshot ? <>
            <RunHeader snapshot={snapshot} busy={busy} action={action} />
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2"><RunStat label="Progress" value={`${completed}/${snapshot.nodes.length}`} note={activeNode ? activeNode.label : "no active agent"} /><RunStat label="Tokens" value={usedTokens.toLocaleString()} note={snapshot.workflow.budget.inferenceTokens ? `${Math.round(100 * usedTokens / snapshot.workflow.budget.inferenceTokens)}% of budget` : "recorded usage"} /><RunStat label="Elapsed" value={formatDuration(elapsedMs)} note={snapshot.workflow.budget.cycles ? `${snapshot.workflow.budget.name} · ${snapshot.workflow.budget.cycles} repair cycle${snapshot.workflow.budget.cycles === 1 ? "" : "s"} · no time cap` : snapshot.workflow.status} /><RunStat label="Evidence" value={String(snapshot.evidence.length)} note={`${snapshot.nodes.reduce((sum, node) => sum + (node.result?.artifacts.length || 0), 0)} artifacts`} /><RunStat label="Autopsy" value={snapshot.diagnosis?.verdict || "pending"} note={`${snapshot.diagnosis?.findings.length || 0} findings`} tone={snapshot.diagnosis?.verdict === "failed" ? "danger" : snapshot.diagnosis?.verdict === "clean" ? "success" : undefined} /></div>
            <TabBar active={activeTab} onChange={setActiveTab} evidence={snapshot.evidence.length} />
            {pendingApproval && <ApprovalCard approval={pendingApproval} busy={busy} onAnswer={respondApproval} />}
            {activeTab === "conversation" && <ConversationView snapshot={snapshot} liveNodes={liveNodes} liveTick={liveTick} expandedNode={expandedNode} setExpandedNode={setExpandedNode} busy={busy} overrideNode={overrideNode} guidance={guidance} setGuidance={setGuidance} steerBusy={steerBusy} steer={steer} continueMission={continueMission} />}
            {/* Conversation self-manages its own flex-1/min-h-0/overflow-auto scroll region (with
               scroll-to-latest tracking its own div) — every other tab rendered a bare Panel or a
               vh-based min-height with no scroll container of its own, so on lg: screens (where
               <main> is h-dvh + overflow-hidden) any content taller than the viewport was silently
               clipped with no way to reach it. One shared scroll wrapper here fixes all of them
               at once, and covers any tab added later without each view re-implementing the pattern. */}
            {activeTab !== "conversation" && <div className="flex-1 min-h-0 overflow-auto">
              {activeTab === "workspace" && <WorkspaceView snapshot={snapshot} liveNodes={liveNodes} liveTick={liveTick} refreshTick={workspaceTick} file={workspaceFile} setFile={setWorkspaceFile} />}
              {activeTab === "dashboard" && <DashboardView snapshot={snapshot} models={models} onChanged={() => { loadSnapshot(selected); loadList(); }} onOpenAudit={() => setActiveTab("audit")} onFork={(id) => { setSelected(id); setActiveTab("dashboard"); }} />}
              {activeTab === "plan" && <PlanView snapshot={snapshot} liveNodes={liveNodes} expandedNode={expandedNode} setExpandedNode={setExpandedNode} busy={busy} overrideNode={overrideNode} />}
              {activeTab === "evidence" && <EvidenceView evidence={snapshot.evidence} nodes={snapshot.nodes} />}
              {activeTab === "agents" && <AgentStudio roles={roles} models={models} overrides={roleOverrides} editingRole={editingRole} editPrompt={editPrompt} editModel={editModel} busy={roleBusy} setEditPrompt={setEditPrompt} setEditModel={setEditModel} startEdit={startEditRole} cancel={() => setEditingRole(null)} save={saveRole} reset={resetRole} />}
              {activeTab === "audit" && <AuditView snapshot={snapshot} />}
            </div>}
          </> : activeTab === "agents" ? <AgentStudio roles={roles} models={models} overrides={roleOverrides} editingRole={editingRole} editPrompt={editPrompt} editModel={editModel} busy={roleBusy} setEditPrompt={setEditPrompt} setEditModel={setEditModel} startEdit={startEditRole} cancel={() => setEditingRole(null)} save={saveRole} reset={resetRole} /> : <EmptyHive />}
        </section>
        </div>
      </div>
    </main>
  );
}

function ModeSwitch({ auto, onChange }: { auto: boolean; onChange: (value: boolean) => void }) {
  return <div className="inline-flex p-0.5 border border-[var(--border)] rounded-[var(--r-md)] bg-[var(--surface-2)]"><button onClick={() => onChange(false)} className="px-2 py-1 rounded-[6px] text-[9px]" style={{ background: !auto ? "var(--accent-ai)" : "transparent", color: !auto ? "var(--bg)" : "var(--muted)" }}>Supervised</button><button onClick={() => onChange(true)} className="px-2 py-1 rounded-[6px] text-[9px]" style={{ background: auto ? "var(--accent-warn)" : "transparent", color: auto ? "var(--bg)" : "var(--muted)" }}>Autopilot</button></div>;
}

function RunRow({ workflow, selected, open, remove }: { workflow: Workflow; selected: boolean; open: () => void; remove: () => void }) {
  return <div className="flex items-start border-b border-[var(--border-soft)] last:border-0" style={{ background: selected ? "var(--surface-3)" : undefined }}><button onClick={open} className="flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-[var(--surface-2)]"><div className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor(workflow.status) }} /><span className="text-[11px] truncate">{workflow.envelope.objective}</span></div><div className="mt-1 pl-3.5 text-[8px] text-[var(--muted)]">{workflow.kind} · {workflow.budget.name} · {relativeTime(workflow.updatedAt)}</div></button><button onClick={remove} title="Delete run" className="p-2.5 text-[var(--muted)] hover:text-[var(--accent-danger)]"><X size={12} /></button></div>;
}

function RunHeader({ snapshot, busy, action }: { snapshot: Snapshot; busy: boolean; action: (name: "stop" | "pause" | "resume" | "replay") => void }) {
  return <Panel padding="sm" className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1 px-1"><div className="text-xs font-semibold truncate">{snapshot.workflow.envelope.objective}</div><div className="text-[8px] text-[var(--muted)] mt-0.5">{snapshot.workflow.kind} · {snapshot.workflow.budget.name} · {snapshot.workflow.working?.controlMode || "supervised"}</div></div><a href={`/api/hive/workflows/${snapshot.workflow.id}/dashboard`} target="_blank" rel="noreferrer" className="h-8 px-2 inline-flex items-center rounded border border-[var(--border)] text-[9px] text-[var(--text-2)]">Live data</a><a href={`/api/hive/workflows/${snapshot.workflow.id}/report?redacted=1`} target="_blank" rel="noreferrer" className="h-8 px-2 inline-flex items-center rounded border border-[var(--border)] text-[9px] text-[var(--text-2)]">Export report</a><span className="text-[9px] uppercase tracking-wide px-2 py-1 rounded-full border" style={{ color: statusColor(snapshot.workflow.status), borderColor: statusColor(snapshot.workflow.status) }}>{snapshot.workflow.status}</span>{["running", "queued", "awaiting_approval"].includes(snapshot.workflow.status) && <button title="Pause at a durable checkpoint" disabled={busy} onClick={() => action("pause")} className="h-8 w-8 grid place-items-center rounded border border-[var(--border)] text-[var(--accent-warn)]"><Pause size={14} /></button>}{!TERMINAL.has(snapshot.workflow.status) && <button title="Stop mission" disabled={busy} onClick={() => action("stop")} className="h-8 w-8 grid place-items-center rounded border border-[var(--border)] text-[var(--accent-danger)]"><Square size={12} /></button>}{["failed", "cancelled", "paused", "incomplete", "blocked"].includes(snapshot.workflow.status) && <button title="Resume from checkpoint" disabled={busy} onClick={() => action("resume")} className="h-8 px-2 flex items-center gap-1 rounded border border-[var(--border)] text-[10px] text-[var(--accent-ai)]"><Play size={13} /> Resume</button>}{TERMINAL.has(snapshot.workflow.status) && <button title="Replay as a new run" disabled={busy} onClick={() => action("replay")} className="h-8 px-2 flex items-center gap-1 rounded border border-[var(--border)] text-[10px] text-[var(--text-2)]"><RotateCcw size={13} /> Replay</button>}</Panel>;
}

function RunStat({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "danger" | "success" }) {
  const color = tone === "danger" ? "var(--accent-danger)" : tone === "success" ? "var(--accent-success)" : "var(--text)";
  return <Panel padding="sm"><div className="text-[8px] uppercase tracking-[0.12em] text-[var(--muted)]">{label}</div><div className="text-sm font-semibold leading-tight mt-0.5 truncate" style={{ color }}>{value}</div><div className="text-[8px] leading-tight text-[var(--muted)] truncate">{note}</div></Panel>;
}

function TabBar({ active, onChange, evidence }: { active: ViewTab; onChange: (tab: ViewTab) => void; evidence: number }) {
  return <div className="hive-tabs sticky top-0 z-20 flex items-center gap-0.5 sm:gap-1 overflow-x-auto border-b border-[var(--border-soft)] bg-[var(--bg)] pb-2">{([['conversation', 'Conversation'], ['dashboard', 'Mission data'], ['workspace', 'Workspace'], ['plan', 'Plan'], ['evidence', `Research ${evidence}`], ['agents', 'Agents'], ['audit', 'Audit']] as const).map(([id, label]) => <button key={id} onClick={() => onChange(id)} className="h-9 px-2 sm:px-3 rounded-[var(--r-md)] text-[9px] sm:text-[10px] whitespace-nowrap" style={{ background: active === id ? "var(--surface-3)" : "transparent", color: active === id ? "var(--accent-ai)" : "var(--text-2)", border: `1px solid ${active === id ? "var(--border-loud)" : "transparent"}` }}>{label}</button>)}</div>;
}

function ApprovalCard({ approval, busy, onAnswer }: { approval: PendingApproval; busy: boolean; onAnswer: (allow: boolean) => void }) {
  return <Panel className="grid md:grid-cols-[1fr_auto] gap-3 items-center" style={{ borderColor: "var(--accent-warn)" }}><div><div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--accent-warn)]"><AlertTriangle size={13} /> Tool approval</div><div className="text-sm mt-1">Allow <span className="text-[var(--accent-ai)] font-mono">{approval.name}</span>?</div><pre className="text-[9px] text-[var(--muted)] mt-1 max-h-20 overflow-auto whitespace-pre-wrap">{JSON.stringify(approval.args, null, 2)}</pre></div><div className="flex gap-2"><Button active disabled={busy} onClick={() => onAnswer(true)}>Allow</Button><Button variant="danger" disabled={busy} onClick={() => onAnswer(false)}>Deny</Button></div></Panel>;
}

function DashboardView({ snapshot, models, onChanged, onOpenAudit, onFork }: { snapshot: Snapshot; models: ModelProfileInfo[]; onChanged: () => void; onOpenAudit: () => void; onFork: (id: string) => void }) {
  const [data, setData] = useState<MissionProjection | null>(null);
  const [host, setHost] = useState<{ cpu?: number; ramPct?: number; vramPct?: number; cpuTemp?: number; gpuTemp?: number; nvmeTemp?: number; serving?: { model?: string | null }; runtime?: { activeRuns?: unknown[]; processes?: unknown[] } } | null>(null);
  const [notice, setNotice] = useState("");
  const [policyBudget, setPolicyBudget] = useState(snapshot.workflow.budget.name);
  const [policyModel, setPolicyModel] = useState("");
  const [rewindNode, setRewindNode] = useState(snapshot.nodes.at(-1)?.nodeId || "");
  const [planText, setPlanText] = useState(() => JSON.stringify(Object.fromEntries(snapshot.workflow.spec.nodes.map((node) => [node.id, node.dependsOn || []])), null, 2));
  const load = useCallback(async () => {
    const [projection, metrics] = await Promise.all([
      fetch(`/api/hive/workflows/${snapshot.workflow.id}/dashboard`, { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/sysinfo", { cache: "no-store" }).then((response) => response.json()).catch(() => null),
    ]);
    if (projection.mission) setData(projection);
    if (metrics) setHost(metrics);
  }, [snapshot.workflow.id]);
  useEffect(() => {
    const initial = setTimeout(load, 0);
    const timer = setInterval(load, 2_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [load]);
  const post = async (body: Record<string, unknown>, pauseFirst = false) => {
    setNotice("");
    try {
      if (pauseFirst && snapshot.workflow.status !== "paused") {
        const paused = await fetch(`/api/hive/workflows/${snapshot.workflow.id}/pause`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        if (!paused.ok) throw new Error((await paused.json()).error || "pause failed");
      }
      const response = await fetch(`/api/hive/workflows/${snapshot.workflow.id}/operator`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "operator action failed");
      if (body.action === "fork" && result.workflowId) onFork(result.workflowId);
      setNotice(body.action === "rewind" ? "Rewound durable nodes. External side effects were not undone; their idempotency ledger is retained." : "Operator action recorded in the durable audit log.");
      await load(); onChanged();
    } catch (error) { setNotice((error as Error).message); }
  };
  if (!data) return <Panel><SignalTrace size="sm" /> Loading correlated mission data…</Panel>;
  const openEvent = (eventId?: string) => {
    if (!eventId) return;
    onOpenAudit();
    setTimeout(() => document.getElementById(`hive-event-${eventId}`)?.scrollIntoView({ block: "center" }), 50);
  };
  return <div className="space-y-3">
    <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
      <Panel><div className="text-[8px] uppercase text-[var(--muted)]">Outcome</div><div className="text-lg font-semibold" style={{ color: statusColor(data.quality.outcome) }}>{data.quality.outcome}</div><div className="text-[9px] mt-1">{data.quality.acceptancePassed}/{data.quality.acceptanceTotal} acceptance criteria · false-completion guard {data.quality.falseCompletionGuard ? "armed" : "failed"}</div></Panel>
      <Panel><div className="text-[8px] uppercase text-[var(--muted)]">Timing</div><div className="text-lg font-semibold">{formatDuration(data.mission.elapsedMs)}</div><div className="text-[9px] mt-1">critical path {formatDuration(data.graph.criticalPathMs)} · forecast {formatDuration(data.mission.forecastMs)}</div></Panel>
      <Panel><div className="text-[8px] uppercase text-[var(--muted)]">Usage</div><div className="text-lg font-semibold">{(data.resources.promptTokens + data.resources.completionTokens).toLocaleString()} tok</div><div className="text-[9px] mt-1">{data.resources.toolCalls} tools · {formatDuration(data.resources.modelSwapMs)} model swap</div></Panel>
      <Panel><div className="text-[8px] uppercase text-[var(--muted)]">Host now</div><div className="text-lg font-semibold">{host?.serving?.model || "no resident model"}</div><div className="text-[9px] mt-1">CPU {host?.cpu ?? "?"}% · RAM {host?.ramPct ?? "?"}% · VRAM {host?.vramPct ?? "?"}% · {host?.cpuTemp ?? "?"}°C</div></Panel>
    </div>
    <div className="grid xl:grid-cols-[1fr_360px] gap-3 items-start">
      <div className="space-y-3">
        <Panel><div className="text-[10px] uppercase tracking-wide text-[var(--text-2)]">Mission</div><p className="text-sm mt-2">{data.mission.objective}</p><p className="text-[10px] text-[var(--text-2)] mt-2">{data.mission.conclusion || data.mission.nextAction}</p>{data.mission.blocker && <p className="text-[10px] text-[var(--accent-danger)] mt-2">{data.mission.blocker}</p>}<div className="grid sm:grid-cols-2 gap-2 mt-3">{data.mission.criteria.map((criterion) => <div key={criterion.id} className="p-2 rounded border border-[var(--border-soft)]"><span className="text-[8px] uppercase" style={{ color: criterion.state === "pass" ? "var(--accent-success)" : "var(--accent-warn)" }}>{criterion.state}</span><div className="text-[9px] mt-1">{criterion.text}</div></div>)}</div></Panel>
        <Panel><div className="flex items-center text-[10px] uppercase tracking-wide text-[var(--text-2)]">Execution graph <span className="ml-auto">{formatDuration(data.graph.criticalPathMs)} critical</span></div><div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-2 mt-3">{data.graph.nodes.map((node) => <button key={node.id} onClick={() => openEvent(node.checkpoint?.eventId)} className="text-left p-2 rounded border border-[var(--border-soft)] hover:border-[var(--border-loud)]"><div className="text-[8px] uppercase" style={{ color: statusColor(node.status) }}>{node.status} · attempt {node.attempt}</div><div className="text-[10px] font-semibold mt-1">{node.label}</div><div className="text-[8px] text-[var(--muted)]">{formatDuration(node.durationMs)}{node.checkpoint ? " · checkpoint" : ""}</div></button>)}</div></Panel>
        <Panel><div className="text-[10px] uppercase tracking-wide text-[var(--text-2)]">Research and coding evidence</div><div className="grid md:grid-cols-2 gap-3 mt-3"><div><div className="text-[9px]">{data.research.sources.length} fetched sources · {data.research.independentOrigins} origins · marginal return {Math.round(data.research.marginalReturn * 100)}%</div><div className="space-y-1 mt-2">{data.research.sources.slice(0, 8).map((source) => <div key={source.evidenceId} className="flex gap-1"><button onClick={() => openEvent(source.eventId)} className="flex-1 min-w-0 text-left text-[8px] truncate text-[var(--accent-ai)]">{source.origin} · {source.sourceClass} · {source.authorityScore ?? "?"}</button><button onClick={() => post({ action: "evidence", evidenceId: source.evidenceId, decision: "pinned", reason: "Pinned from mission dashboard" })} className="text-[8px] text-[var(--accent-success)]">pin</button><button onClick={() => post({ action: "evidence", evidenceId: source.evidenceId, decision: "rejected", reason: "Rejected from mission dashboard" })} className="text-[8px] text-[var(--accent-danger)]">reject</button></div>)}</div></div><div><div className="text-[9px]">{data.coding.artifacts.length} artifacts · {data.coding.checks.filter((item) => item.passed).length}/{data.coding.checks.length} checks · {data.coding.uncheckedBehavior.length} unchecked</div><div className="space-y-1 mt-2">{data.coding.checks.slice(0, 8).map((item) => <div key={`${item.nodeId}-${item.code}`} className="text-[8px]" style={{ color: item.passed ? "var(--accent-success)" : "var(--accent-danger)" }}>{item.passed ? "✓" : "✗"} {item.code} · {item.detail}</div>)}</div></div></div></Panel>
        <Panel><div className="flex items-center text-[10px] uppercase tracking-wide text-[var(--text-2)]">Timeline <span className="ml-auto">{data.ledgerHealth.visibleEvents} durable events</span></div><div className="mt-2 max-h-56 overflow-auto">{data.timeline.slice(-80).map((item) => <button key={item.eventId} onClick={() => openEvent(item.eventId)} className="w-full grid grid-cols-[62px_1fr_auto] gap-2 text-left text-[8px] py-1 border-b border-[var(--border-soft)]"><span>#{item.seq}</span><span className="truncate">{item.kind}{item.nodeId ? ` · ${item.nodeId}` : ""}</span><span className="text-[var(--muted)]">+{item.gapFromPreviousMs}ms</span></button>)}</div><div className="text-[8px] mt-2" style={{ color: data.ledgerHealth.sequenceGap || data.ledgerHealth.anomalies.length ? "var(--accent-danger)" : "var(--accent-success)" }}>sequence gap {String(data.ledgerHealth.sequenceGap)} · anomalies {data.ledgerHealth.anomalies.length} · unknown versions {data.ledgerHealth.unknownEventVersions.length} · snapshot age {data.ledgerHealth.snapshotAgeMs}ms</div></Panel>
      </div>
      <div className="space-y-3">
        <Panel><div className="text-[10px] uppercase tracking-wide text-[var(--text-2)]">Operator controls</div><p className="text-[8px] text-[var(--muted)] mt-2">Rewind restores durable workflow state only. External effects remain and are protected by the side-effect ledger.</p><div className="grid grid-cols-2 gap-2 mt-3"><Button size="sm" onClick={() => post({ action: "fork" })}>Fork</Button><Button size="sm" onClick={() => post({ action: "output", decision: "useful", reason: "Marked useful in mission dashboard" })}>Useful</Button><Button size="sm" variant="danger" onClick={() => post({ action: "output", decision: "defective", reason: "Marked defective in mission dashboard" })}>Defective</Button><a href={`/api/hive/workflows/${snapshot.workflow.id}?events=2000`} target="_blank" rel="noreferrer" className="h-8 px-2 grid place-items-center rounded border border-[var(--border)] text-[9px]">Export trace</a></div><div className="flex gap-1 mt-3"><select value={rewindNode} onChange={(event) => setRewindNode(event.target.value)} className="min-w-0 flex-1 bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 text-[9px]">{snapshot.nodes.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.label}</option>)}</select><Button size="sm" disabled={!rewindNode} onClick={() => post({ action: "rewind", nodeId: rewindNode }, true)}>Rewind</Button></div><div className="grid grid-cols-2 gap-1 mt-3"><select value={policyBudget} onChange={(event) => setPolicyBudget(event.target.value)} className="bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 text-[9px]"><option value="normal">normal</option><option value="thorough">thorough</option><option value="extra">extra</option></select><select value={policyModel} onChange={(event) => setPolicyModel(event.target.value)} className="bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 text-[9px]"><option value="">model: auto</option>{models.map((model) => <option key={model.id} value={model.id}>{model.model}</option>)}</select></div><Button size="sm" className="w-full mt-2" onClick={() => post({ action: "execution_policy", budget: policyBudget, preferredModel: policyModel || "auto" }, true)}>Apply execution policy</Button>{notice && <p className="text-[8px] text-[var(--muted)] mt-2">{notice}</p>}</Panel>
        <Panel><div className="text-[10px] uppercase tracking-wide text-[var(--text-2)]">Plan dependencies</div><p className="text-[8px] text-[var(--muted)] mt-2">Pause first. Completed nodes are immutable; remaining dependencies are DAG-validated.</p><textarea value={planText} onChange={(event) => setPlanText(event.target.value)} className="w-full min-h-48 mt-2 bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 font-mono text-[8px]" /><Button size="sm" className="w-full mt-2" onClick={() => { try { post({ action: "plan", dependencies: JSON.parse(planText) }, true); } catch { setNotice("Plan must be valid JSON."); } }}>Validate and save plan</Button></Panel>
        <Panel><div className="text-[10px] uppercase tracking-wide text-[var(--text-2)]">Diagnostics</div><div className="text-[8px] mt-2 space-y-1"><div>trajectory efficiency {Math.round(data.quality.trajectoryEfficiency * 100)}%</div><div>first divergence {data.quality.firstDivergence || "none"}</div><div>interventions {data.quality.interventions.length}</div><div>GPU {host?.vramPct ?? "?"}% · GPU temp {host?.gpuTemp ?? "?"}°C · NVMe {host?.nvmeTemp ?? "?"}°C</div></div><div className="grid grid-cols-2 gap-2 mt-3"><a href={`/api/hive/workflows/${snapshot.workflow.id}/report`} target="_blank" rel="noreferrer" className="h-8 grid place-items-center rounded border border-[var(--border)] text-[9px]">Comparison report</a><button onClick={onOpenAudit} className="h-8 rounded border border-[var(--border)] text-[9px]">Raw ledger</button></div></Panel>
      </div>
    </div>
  </div>;
}

function ConversationView({ snapshot, liveNodes, liveTick, expandedNode, setExpandedNode, busy, overrideNode, guidance, setGuidance, steerBusy, steer, continueMission }: { snapshot: Snapshot; liveNodes: Map<string, LiveNode>; liveTick: number; expandedNode: string | null; setExpandedNode: (id: string | null) => void; busy: boolean; overrideNode: (nodeId: string, action: "retry" | "skip") => void; guidance: string; setGuidance: (value: string) => void; steerBusy: boolean; steer: (pause: boolean) => void; continueMission: () => void }) {
  const feed: ({ kind: "objective"; ts: number } | { kind: "node"; ts: number; node: Node } | { kind: "operator"; ts: number; message: string; id: string })[] = [
    { kind: "objective" as const, ts: snapshot.workflow.createdAt },
    ...snapshot.nodes.filter((node) => node.startedAt || node.result || node.error).map((node) => ({ kind: "node" as const, ts: node.startedAt || snapshot.workflow.createdAt + 1, node })),
    ...snapshot.events.filter((event) => event.kind === "operator_message").map((event) => { const payload = event.payload as { id?: string; message?: string }; return { kind: "operator" as const, ts: event.ts, message: payload.message || "", id: payload.id || String(event.seq) }; }),
  ].sort((a, b) => a.ts - b.ts);
  const conversation = snapshot.workflow.working?.conversation?.filter((turn) => turn && typeof turn.text === "string") || [{ role: "user", text: snapshot.workflow.envelope.objective }];
  const completed = snapshot.workflow.status === "succeeded" || snapshot.workflow.status === "complete";
  // Follow the live tail like a terminal — but only when the user is already
  // near the bottom, so scrolling up to read history is never fought.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = scrollRef.current; if (!box) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }, [liveTick, snapshot]);
  return <Panel padding="none" className="overflow-hidden flex flex-col lg:flex-1 lg:min-h-0"><div ref={scrollRef} className="max-h-[66vh] min-h-[420px] lg:max-h-none lg:min-h-0 lg:flex-1 overflow-auto px-3 md:px-5 py-3 space-y-3">{conversation.map((turn, index) => <OperatorMessage key={`turn-${index}`} label={index ? "You" : "Mission"} text={turn.text} ts={snapshot.workflow.createdAt + index} />)}{feed.filter((item) => item.kind !== "objective").map((item) => item.kind === "operator" ? <OperatorMessage key={item.id} label="Guidance" text={item.message} ts={item.ts} /> : <AgentMessage key={item.node.nodeId} node={item.node} live={liveNodes.get(item.node.nodeId)} events={snapshot.events} workflow={snapshot.workflow} expanded={expandedNode === item.node.nodeId} toggle={() => setExpandedNode(expandedNode === item.node.nodeId ? null : item.node.nodeId)} busy={busy} overrideNode={overrideNode} />)}{!feed.some((item) => item.kind === "node") && <div className="text-center text-[10px] text-[var(--muted)] py-16">The first agent will appear here when execution begins.</div>}</div><div className="border-t border-[var(--border)] p-2.5 bg-[var(--surface-1)] shrink-0"><textarea aria-label="Mission guidance" value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder={completed ? "Continue this mission…" : "Guide the next agent, correct an assumption, or change priorities…"} className="w-full min-h-14 max-h-28 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2 text-xs resize-y outline-none focus:border-[var(--border-loud)]" /><div className="flex flex-wrap items-center gap-2 mt-1.5"><span className="text-[8px] text-[var(--muted)] mr-auto">{completed ? "A continuation keeps the prior mission digest and durable agent history." : "Guidance is written to the durable context for subsequent agents."}</span>{completed ? <button disabled={steerBusy || !guidance.trim()} onClick={continueMission} className="h-8 px-3 inline-flex items-center gap-1.5 rounded border border-[var(--accent-ai)] text-[10px] text-[var(--accent-ai)] disabled:opacity-40"><Send size={12} /> Continue mission</button> : <><button disabled={steerBusy || !guidance.trim()} onClick={() => steer(false)} className="h-8 px-3 inline-flex items-center gap-1.5 rounded border border-[var(--border)] text-[10px] text-[var(--text-2)] disabled:opacity-40"><Send size={12} /> Send guidance</button><button disabled={steerBusy || !guidance.trim()} onClick={() => steer(true)} className="h-8 px-3 inline-flex items-center gap-1.5 rounded bg-[var(--accent-warn)] text-[var(--bg)] text-[10px] font-semibold disabled:opacity-40"><Pause size={12} /> Pause &amp; redirect</button></>}</div></div></Panel>;
}

function OperatorMessage({ label, text, ts }: { label: string; text: string; ts: number }) {
  return <div className="flex justify-end gap-2"><div className="max-w-[82%] rounded-[var(--r-lg)] rounded-tr-sm bg-[color-mix(in_srgb,var(--accent-ai)_14%,var(--surface-2))] border border-[var(--border)] px-3 py-2"><div className="flex items-center gap-2 text-[8px] uppercase tracking-wide text-[var(--accent-ai)]"><User size={10} />{label}<span className="text-[var(--muted)] normal-case ml-auto">{new Date(ts).toLocaleTimeString()}</span></div><div className="text-xs leading-relaxed mt-1 whitespace-pre-wrap">{text}</div></div></div>;
}

function AgentMessage({ node, live, events, workflow, expanded, toggle, busy, overrideNode }: { node: Node; live?: LiveNode; events: HiveEvent[]; workflow: Workflow; expanded: boolean; toggle: () => void; busy: boolean; overrideNode: (nodeId: string, action: "retry" | "skip") => void }) {
  // Prefer the realtime buffers (current attempt, streamed token by token);
  // fall back to the durable ledger for nodes from before this attach.
  const durable = nodeThinking(events, node.nodeId);
  const hasLive = !!live && !!(live.thinking || live.text || live.calls.length);
  const trace = hasLive
    ? { thinking: live!.thinking, text: live!.text, calls: live!.calls.map((call) => `${call.ok === undefined ? "→" : call.ok ? "✓" : "✗"} ${call.name}`), handoffs: durable.handoffs }
    : durable;
  const active = ["running", "awaiting_approval"].includes(node.status);
  const optional = !!workflow.spec.nodes.find((item) => item.id === node.nodeId)?.optional;
  const canOverride = node.status === "failed" && !["running", "queued"].includes(workflow.status);
  const result = node.result;
  return <div className="flex gap-2 max-w-[94%]"><div className="w-7 h-7 rounded-full border border-[var(--border)] bg-[var(--surface-2)] grid place-items-center shrink-0" style={{ color: statusColor(node.status) }}><Bot size={13} /></div><div className="min-w-0 flex-1 rounded-[var(--r-lg)] rounded-tl-sm bg-[var(--surface-2)] border border-[var(--border-soft)] px-3 py-2.5"><button onClick={toggle} aria-expanded={expanded} className="w-full flex flex-wrap items-center gap-x-2 gap-y-1 text-left"><span className="text-[10px] font-semibold">{node.label}</span><span className="text-[8px] uppercase tracking-wide" style={{ color: statusColor(node.status) }}>{node.status}</span><span className="text-[8px] text-[var(--muted)]">{node.role} · attempt {node.attempt}</span>{active && <SignalTrace size="sm" className="ml-auto" />}<span className="ml-auto text-[8px] text-[var(--accent-ai)]">{expanded ? "collapse" : "expand"}</span></button><div className="flex flex-wrap gap-x-3 text-[8px] text-[var(--muted)] mt-1"><span>{node.durationMs != null ? formatDuration(node.durationMs) : active ? "working" : "—"}</span><span>{node.promptTokens + node.completionTokens} tok</span><span>{node.toolCalls} tools</span>{node.adapterMs ? <span>adapter {node.adapterMs}ms</span> : null}{node.modelVersion && <span>model {node.modelVersion.slice(0, 8)}</span>}</div>{active && live && <LiveVitals live={live} />}{result?.summary && <p className="text-xs text-[var(--text-2)] leading-relaxed whitespace-pre-wrap mt-2">{result.summary}</p>}{node.error && <p className="text-[10px] text-[var(--accent-danger)] mt-2">{node.error}</p>}{(active || expanded) && <AgentDetails node={node} live={trace} streaming={active} />}{canOverride && <div className="flex gap-2 mt-3"><Button size="sm" disabled={busy} onClick={() => overrideNode(node.nodeId, "retry")} className="border border-[var(--accent-ai)]/50 text-[var(--accent-ai)]">Retry this step</Button>{optional && <Button size="sm" disabled={busy} onClick={() => overrideNode(node.nodeId, "skip")} className="border border-[var(--border)]">Skip optional step</Button>}</div>}</div></div>;
}

// ---- Realtime vitals: brain waves (J-space token certainty), context fill,
// decode speed, and live tool-argument decode progress for the running agent ----

function BrainWave({ wave, height = 36 }: { wave: number[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const width = canvas.clientWidth || 300;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
    const window_ = wave.slice(-Math.max(80, Math.floor(width / 2)));
    const bar = width / Math.max(80, window_.length);
    for (let i = 0; i < window_.length; i++) {
      const p = window_[i];
      const h = Math.max(2, p * (height - 4));
      ctx.fillStyle = p >= 0.85 ? "rgba(63,185,80,0.85)" : p >= 0.6 ? "rgba(210,153,34,0.9)" : "rgba(248,81,73,0.95)";
      ctx.fillRect(i * bar, height - h - 2, Math.max(1, bar - 0.4), h);
    }
  });
  return <canvas ref={ref} style={{ width: "100%", height }} className="block rounded-[var(--r-md)] bg-[var(--surface-1)]" />;
}

function LiveVitals({ live }: { live: LiveNode }) {
  const usage = live.usage;
  const ctxPct = usage && usage.ctx ? Math.min(100, Math.round(100 * usage.totalTokens / usage.ctx)) : null;
  const waveAvg = live.wave.length ? live.wave.reduce((sum, p) => sum + p, 0) / live.wave.length : null;
  const lowCount = live.wave.filter((p) => p < 0.5).length;
  const confColor = (avg: number) => avg >= 0.85 ? "var(--accent-success)" : avg >= 0.6 ? "var(--accent-warn)" : "var(--accent-danger)";
  return <div className="mt-2 rounded-[var(--r-md)] border border-[var(--border-soft)] bg-[var(--surface-1)] p-2 space-y-2">
    {live.wave.length ? <div>
      <div className="flex items-center justify-between text-[8px] uppercase tracking-[0.14em] text-[var(--muted)] mb-1"><span>Brain waves · J-space token certainty</span>{waveAvg != null && <span className="normal-case tracking-normal tabular-nums" style={{ color: confColor(waveAvg) }}>avg {Math.round(waveAvg * 100)}% · {lowCount} uncertain</span>}</div>
      <BrainWave wave={live.wave} />
    </div> : null}
    {live.alts.length ? <div>
      <div className="text-[8px] uppercase tracking-[0.14em] text-[var(--muted)] mb-1">Almost said · competing tokens at uncertain moments</div>
      <div className="flex flex-wrap gap-1">{live.alts.slice(-8).map((alt, index) => <span key={index} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-3)]"><b className="text-[var(--accent-warn)]">{JSON.stringify(alt.token).slice(1, -1)}</b> <span className="text-[var(--muted)]">{Math.round(alt.p * 100)}%</span>{alt.alts.slice(0, 2).map(([token, p], altIndex) => <span key={altIndex} className="text-[var(--muted)]"> · {JSON.stringify(token).slice(1, -1)} {Math.round(p * 100)}%</span>)}</span>)}</div>
    </div> : null}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] tabular-nums">
      {usage?.tokPerSec != null && <span className="text-[var(--text-2)]">{usage.tokPerSec} tok/s</span>}
      {ctxPct != null && <span className="flex items-center gap-1.5 min-w-24 flex-1 max-w-52"><span className="text-[var(--muted)] uppercase text-[8px] tracking-wide">ctx</span><span className="h-1 flex-1 rounded-full bg-[var(--surface-3)] overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${ctxPct}%`, background: ctxPct >= 90 ? "var(--accent-danger)" : ctxPct >= 70 ? "var(--accent-warn)" : "var(--accent-ai)" }} /></span><span className="text-[var(--muted)]">{ctxPct}%</span></span>}
      {usage?.conf && <span style={{ color: confColor(usage.conf.avg) }}>round certainty {Math.round(usage.conf.avg * 100)}%</span>}
      {live.rounds > 0 && <span className="text-[var(--muted)]">round {live.rounds}</span>}
      {live.progress && <span className="text-[var(--accent-ai)] animate-pulse">decoding {live.progress.name} · {live.progress.chars.toLocaleString()} chars</span>}
      {!live.wave.length && usage && <span className="text-[var(--muted)]">certainty capture unavailable during tool rounds on this backend</span>}
    </div>
  </div>;
}

// Streaming pane that follows its own tail while tokens arrive.
function StreamPre({ text, streaming, className }: { text: string; streaming: boolean; className: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { const box = ref.current; if (box && streaming) box.scrollTop = box.scrollHeight; }, [text, streaming]);
  return <pre ref={ref} className={className}>{text}</pre>;
}

function AgentDetails({ node, live, streaming = false }: { node: Node; live: ReturnType<typeof nodeThinking>; streaming?: boolean }) {
  const result = node.result;
  return <div className="mt-3 pt-3 border-t border-[var(--border-soft)] space-y-3">{live.handoffs.length ? <DetailBlock title="Agent handoff"><div className="space-y-2">{live.handoffs.map((handoff, index) => <div key={`${handoff.from}-${index}`} className="rounded border border-[var(--border-soft)] bg-[var(--surface-1)] p-2"><div className="text-[8px] uppercase tracking-wide text-[var(--accent-ai)]">from {handoff.from} · {handoff.status}</div><p className="mt-1 text-[10px] text-[var(--text-2)] whitespace-pre-wrap">{handoff.summary}</p>{handoff.uncertainties.length ? <p className="mt-1 text-[9px] text-[var(--accent-warn)]">Open: {handoff.uncertainties.join(" · ")}</p> : null}</div>)}</div></DetailBlock> : null}{live.thinking ? <DetailBlock title={streaming ? "Live reasoning · streaming" : "Reasoning"}><StreamPre streaming={streaming} text={live.thinking} className="text-[10px] text-[var(--text-2)] italic whitespace-pre-wrap max-h-64 overflow-auto" /></DetailBlock> : <DetailBlock title="Live reasoning"><p className="text-[10px] text-[var(--muted)]">{["pending", "ready"].includes(node.status) ? "This agent has not started yet." : streaming ? "Waiting for the first token…" : "This backend did not expose a reasoning trace for this step."}</p></DetailBlock>}{live.text && <DetailBlock title={streaming ? "Model output · streaming" : "Model output"}><StreamPre streaming={streaming} text={live.text} className="text-[10px] text-[var(--text)] whitespace-pre-wrap max-h-52 overflow-auto" /></DetailBlock>}{live.calls.length ? <DetailBlock title="Tool activity"><div className="flex flex-wrap gap-1">{live.calls.map((call, index) => <span key={index} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--muted)]">{call}</span>)}</div></DetailBlock> : null}{result?.findings?.length ? <DetailBlock title={`Findings · ${result.findings.length}`}><div className="space-y-1.5">{result.findings.map((finding) => <div key={finding.id} className="text-[10px] text-[var(--text-2)] leading-relaxed"><span className="text-[var(--muted)] mr-1">•</span>{finding.text}{finding.confidence != null && <span className="text-[8px] text-[var(--muted)] ml-2">{Math.round(finding.confidence * 100)}%</span>}</div>)}</div></DetailBlock> : null}{result?.verification && <DetailBlock title={`Verification · ${result.verification.passed ? "passed" : "failed"}`}><div className="space-y-1">{result.verification.checks.map((check) => <div key={check.code} className="grid grid-cols-[14px_1fr] gap-1 text-[9px]"><span style={{ color: check.passed ? "var(--accent-success)" : "var(--accent-danger)" }}>{check.passed ? "✓" : "×"}</span><span><b className="text-[var(--text-2)]">{check.code}</b> · <span className="text-[var(--muted)] whitespace-pre-wrap">{check.detail}</span></span></div>)}</div></DetailBlock>}{result?.artifacts?.length ? <DetailBlock title="Artifacts"><ArtifactLinks artifacts={result.artifacts} /></DetailBlock> : null}{result?.uncertainties?.length ? <DetailBlock title="Uncertainties"><ul className="text-[10px] text-[var(--accent-warn)] list-disc pl-4">{result.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul></DetailBlock> : null}{result?.errors?.length ? <DetailBlock title="Errors"><ul className="text-[10px] text-[var(--accent-danger)] list-disc pl-4">{result.errors.map((item, index) => <li key={index}>{item}</li>)}</ul></DetailBlock> : null}</div>;
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) { return <div><div className="text-[8px] uppercase tracking-[0.14em] text-[var(--muted)] mb-1">{title}</div>{children}</div>; }
function ArtifactLinks({ artifacts }: { artifacts: Artifact[] }) { return <div className="flex flex-wrap gap-2">{artifacts.map((artifact, index) => <a key={`${artifact.hash}-${index}`} href={`/api/hive/artifacts/${artifact.hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[9px] text-[var(--accent-ai)] border border-[var(--border)] rounded px-2 py-1"><FileText size={10} />{artifact.label || artifact.hash.slice(0, 10)}</a>)}</div>; }

function WorkspaceView({ snapshot, liveNodes, liveTick, refreshTick, file, setFile }: { snapshot: Snapshot; liveNodes: Map<string, LiveNode>; liveTick: number; refreshTick: number; file: string | null; setFile: (path: string | null) => void }) {
  void liveTick; // liveNodes has stable identity; the tick is the render clock.
  const [mobilePane, setMobilePane] = useState<"files" | "output" | "documents">("output");
  const workspace = snapshot.workflow.envelope.workspace || "";
  const documentNodes = snapshot.nodes.filter((node) => /plan|research|quer|read|evidence|map|intake/i.test(`${node.nodeId} ${node.label}`));
  const artifacts = snapshot.nodes.flatMap((node) => (node.result?.artifacts || []).map((artifact) => ({ ...artifact, node: node.label })));
  const activeDrafts = snapshot.nodes.map((node) => ({ node, live: liveNodes.get(node.nodeId) })).filter((item) => item.live?.progress || item.live?.text || item.live?.thinking);
  const openFile = (path: string) => { setFile(path); setMobilePane("output"); };
  return <div className="min-h-[68vh]">
    <div className="xl:hidden grid grid-cols-3 gap-1 mb-2 p-1 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-1)]">{([['files', 'Files'], ['output', file ? 'Code' : 'Live output'], ['documents', 'Plans & research']] as const).map(([id, label]) => <button key={id} onClick={() => setMobilePane(id)} className="min-h-9 px-2 rounded text-[9px]" style={{ background: mobilePane === id ? "var(--surface-3)" : "transparent", color: mobilePane === id ? "var(--accent-ai)" : "var(--text-2)", border: `1px solid ${mobilePane === id ? "var(--border-loud)" : "transparent"}` }}>{label}</button>)}</div>
    <div className="grid xl:grid-cols-[240px_minmax(0,1fr)_320px] gap-3 items-stretch">
    <Panel padding="none" className={`${mobilePane === "files" ? "flex" : "hidden"} xl:flex flex-col overflow-hidden h-[68dvh] xl:h-auto xl:min-h-64`}>
      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2"><FolderTree size={13} className="text-[var(--accent-ai)]" /><span className="text-[9px] uppercase tracking-[0.14em]">Workspace files</span></div>
      <div className="px-3 py-2 text-[8px] font-mono text-[var(--muted)] border-b border-[var(--border-soft)] break-all">{workspace || "No filesystem workspace for this research mission"}</div>
      <div className="flex-1 overflow-auto">{workspace ? <FileTree project={workspace} refreshTick={refreshTick} onOpenFile={openFile} selected={file} readOnly /> : <div className="p-4 text-[10px] text-[var(--muted)]">Research outputs and source artifacts remain visible in the mission documents panel.</div>}</div>
    </Panel>
    <Panel padding="none" className={`${mobilePane === "output" ? "flex" : "hidden"} xl:flex flex-col overflow-hidden h-[68dvh] xl:h-auto xl:min-h-[520px]`}>
      {workspace && file ? <EditorPane project={workspace} filePath={file} refreshTick={refreshTick} readOnly onClose={() => setFile(null)} onSaved={() => {}} /> : <div className="h-full flex flex-col">
        <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2"><Code2 size={13} className="text-[var(--accent-ai)]" /><span className="text-[9px] uppercase tracking-[0.14em]">Live agent output</span></div>
        <div className="flex-1 overflow-auto p-3 space-y-3">{activeDrafts.map(({ node, live }) => <div key={node.nodeId} className="rounded-[var(--r-md)] border border-[var(--border-soft)] bg-[var(--surface-2)] p-3"><div className="flex items-center gap-2 text-[9px]"><span className="text-[var(--accent-ai)] uppercase tracking-wide">{node.role}</span><span className="text-[var(--muted)]">{node.label}</span></div>{live?.progress && <div className="mt-2"><div className="text-[8px] uppercase tracking-wide text-[var(--accent-warn)] animate-pulse">Decoding {live.progress.name} · {live.progress.chars.toLocaleString()} chars</div>{live.progress.preview && <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all text-[9px] font-mono text-[var(--text-2)] bg-[var(--surface-1)] rounded p-2">…{live.progress.preview}</pre>}</div>}{live?.text && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px] text-[var(--text)]">{live.text}</pre>}{!live?.text && live?.thinking && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[9px] italic text-[var(--text-2)]">{live.thinking}</pre>}</div>)}{!activeDrafts.length && <div className="h-full min-h-80 grid place-items-center text-center text-[10px] text-[var(--muted)]"><div><Code2 size={22} className="mx-auto mb-2" />Select a file to inspect it.<br />The active agent&apos;s plan, reasoning, and decoded file draft will appear here live.</div></div>}</div>
      </div>}
    </Panel>
    <Panel padding="none" className={`${mobilePane === "documents" ? "flex" : "hidden"} xl:flex flex-col overflow-hidden h-[68dvh] xl:h-auto xl:min-h-64`}>
      <div className="px-3 py-2 border-b border-[var(--border)] text-[9px] uppercase tracking-[0.14em]">Plans & research</div>
      <div className="flex-1 overflow-auto p-3 space-y-3">{documentNodes.map((node) => { const live = liveNodes.get(node.nodeId); return <div key={node.nodeId} className="border-l-2 pl-2" style={{ borderColor: statusColor(node.status) }}><div className="text-[8px] uppercase tracking-wide text-[var(--accent-ai)]">{node.label} · {node.status}</div>{live?.text && <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-[9px] text-[var(--text-2)]">{live.text}</pre>}{node.result?.summary && <p className="mt-1 text-[9px] leading-relaxed text-[var(--text-2)]">{node.result.summary}</p>}{node.result?.findings?.length ? <div className="mt-1 text-[8px] text-[var(--muted)]">{node.result.findings.length} structured finding(s)</div> : null}</div>; })}{artifacts.length ? <div className="pt-2 border-t border-[var(--border-soft)]"><div className="text-[8px] uppercase tracking-wide text-[var(--muted)] mb-2">Durable artifacts · {artifacts.length}</div><div className="space-y-1">{artifacts.map((artifact, index) => <a key={`${artifact.hash}-${artifact.node}-${index}`} href={`/api/hive/artifacts/${artifact.hash}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[9px] text-[var(--accent-ai)] hover:underline"><FileText size={10} /><span className="truncate">{artifact.label || artifact.node}</span></a>)}</div></div> : null}</div>
    </Panel>
    </div>
  </div>;
}

function PlanView({ snapshot, liveNodes, expandedNode, setExpandedNode, busy, overrideNode }: { snapshot: Snapshot; liveNodes: Map<string, LiveNode>; expandedNode: string | null; setExpandedNode: (id: string | null) => void; busy: boolean; overrideNode: (nodeId: string, action: "retry" | "skip") => void }) {
  return <Panel><div className="space-y-0">{snapshot.nodes.map((node, index) => <div key={node.nodeId} className="grid grid-cols-[24px_1fr] gap-2"><div className="flex flex-col items-center pt-3" style={{ color: statusColor(node.status) }}><StatusIcon status={node.status} />{index < snapshot.nodes.length - 1 && <span className="w-px flex-1 min-h-10 bg-[var(--border)]" />}</div><div className="py-3 border-b border-[var(--border-soft)] last:border-0"><AgentMessage node={node} live={liveNodes.get(node.nodeId)} events={snapshot.events} workflow={snapshot.workflow} expanded={expandedNode === node.nodeId} toggle={() => setExpandedNode(expandedNode === node.nodeId ? null : node.nodeId)} busy={busy} overrideNode={overrideNode} /></div></div>)}</div></Panel>;
}

function EvidenceView({ evidence, nodes }: { evidence: Evidence[]; nodes: Node[] }) {
  const artifacts = nodes.flatMap((node) => (node.result?.artifacts || []).map((artifact) => ({ ...artifact, node: node.label })));
  return <div className="grid xl:grid-cols-[1fr_300px] gap-3 items-start"><Panel><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3"><ShieldCheck size={13} /> Source evidence · {evidence.length}</div><div className="space-y-2">{evidence.map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="block p-3 rounded-[var(--r-md)] border border-[var(--border-soft)] bg-[var(--surface-2)] hover:border-[var(--border-loud)]"><div className="flex items-center gap-2"><span className="text-[8px] uppercase tracking-wide" style={{ color: item.stance === "contradicting" ? "var(--accent-danger)" : item.stance === "supporting" ? "var(--accent-success)" : "var(--accent-ai)" }}>{item.stance}</span><span className="text-[10px] font-semibold truncate">{item.title || item.url}</span></div>{item.claim && <div className="text-[10px] text-[var(--text)] mt-1">{item.claim}</div>}<p className="text-[9px] text-[var(--muted)] leading-relaxed mt-1 line-clamp-4">{item.excerpt}</p></a>)}{!evidence.length && <div className="py-20 text-center text-[10px] text-[var(--muted)]">No fetched-source evidence yet.</div>}</div></Panel><Panel><div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3">Artifacts · {artifacts.length}</div><div className="space-y-2">{artifacts.map((artifact, index) => <a key={`${artifact.hash}-${artifact.node}-${index}`} href={`/api/hive/artifacts/${artifact.hash}`} target="_blank" rel="noreferrer" className="flex items-start gap-2 p-2 rounded border border-[var(--border-soft)] text-[10px] hover:border-[var(--border-loud)]"><FileText size={12} className="text-[var(--accent-ai)] shrink-0" /><span className="min-w-0"><b className="block truncate">{artifact.label || artifact.hash.slice(0, 12)}</b><span className="text-[8px] text-[var(--muted)]">{artifact.node} · {(artifact.size / 1024).toFixed(1)} KB</span></span></a>)}</div></Panel></div>;
}

function AgentStudio({ roles, models, overrides, editingRole, editPrompt, editModel, busy, setEditPrompt, setEditModel, startEdit, cancel, save, reset }: { roles: Record<string, RoleProfile>; models: ModelProfileInfo[]; overrides: Record<string, RoleOverride>; editingRole: string | null; editPrompt: string; editModel: string; busy: boolean; setEditPrompt: (value: string) => void; setEditModel: (value: string) => void; startEdit: (role: RoleProfile) => void; cancel: () => void; save: (id: string) => void; reset: (id: string) => void }) {
  const label = (model: ModelProfileInfo) => model.specialist ? `${model.specialist.role} · ${model.specialist.promotionStatus} · ${model.model}` : model.model;
  return <Panel><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3"><Settings2 size={13} /> Agent roles, prompts, and routing</div><div className="grid xl:grid-cols-2 gap-3">{Object.values(roles).map((role) => { const eligible = models.filter((model) => role.modelRequirements.every((requirement) => model.capabilities.includes(requirement))); const override = overrides[role.id]; const editing = editingRole === role.id; return <div key={role.id} className="p-3 rounded-[var(--r-md)] border border-[var(--border-soft)] bg-[var(--surface-2)]"><div className="flex items-center gap-2 flex-wrap"><Bot size={13} className="text-[var(--accent-ai)]" /><span className="text-xs font-semibold">{role.id}</span>{role.modelRequirements.map((requirement) => <span key={requirement} className="text-[7px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)]">{requirement}</span>)}{(override?.prompt || override?.preferredModel) && <Badge tone="highlight">customized</Badge>}{!editing && <button onClick={() => startEdit(role)} className="ml-auto text-[9px] text-[var(--accent-ai)]">Edit</button>}</div>{editing ? <div className="space-y-2 mt-3"><textarea value={editPrompt} onChange={(event) => setEditPrompt(event.target.value)} className="w-full min-h-28 bg-[var(--surface-1)] border border-[var(--border)] rounded p-2 text-[10px] resize-y" /><select value={editModel} onChange={(event) => setEditModel(event.target.value)} className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded p-2 text-[10px]"><option value="">Preferred model: auto</option>{models.map((model) => <option key={model.id} value={model.id}>{label(model)}</option>)}</select><div className="flex gap-2"><Button size="sm" active disabled={busy} onClick={() => save(role.id)}>Save</Button><Button size="sm" disabled={busy} onClick={cancel}>Cancel</Button>{(override?.prompt || override?.preferredModel) && <Button size="sm" disabled={busy} onClick={() => reset(role.id)} className="ml-auto text-[var(--accent-danger)]">Reset</Button>}</div></div> : <p className="text-[10px] text-[var(--text-2)] leading-relaxed mt-2">{role.prompt}</p>}<div className="text-[8px] text-[var(--muted)] mt-2">{override?.preferredModel ? `preferred ${override.preferredModel} · ` : ""}{eligible.length ? `eligible: ${eligible.map(label).join(", ")}` : "no eligible verified model"}</div></div>; })}</div></Panel>;
}

function AuditView({ snapshot }: { snapshot: Snapshot }) {
  const verdict = snapshot.workflow.working?.verdict;
  return <div className="grid xl:grid-cols-[360px_1fr] gap-3 items-start"><div className="space-y-3"><TaskContractEditor workflow={snapshot.workflow} /><Panel><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3"><ShieldCheck size={13} /> Runtime verdict</div><div className="text-2xl font-semibold" style={{ color: statusColor(verdict?.outcome || snapshot.workflow.status) }}>{verdict?.outcome || snapshot.workflow.status}</div><p className="text-[9px] text-[var(--text-2)] leading-relaxed mt-2">{verdict?.reason || "The runtime has not issued a terminal task verdict."}</p><div className="space-y-2 mt-4">{verdict?.criteria?.map((criterion) => <div key={criterion.id} className="p-2 rounded border border-[var(--border-soft)] bg-[var(--surface-2)]"><div className="text-[8px] uppercase tracking-wide" style={{ color: criterion.state === "pass" ? "var(--accent-success)" : criterion.state === "unknown" ? "var(--accent-warn)" : "var(--accent-danger)" }}>{criterion.state} · {criterion.id}</div><div className="text-[9px] mt-1">{criterion.text}</div>{criterion.detail && <div className="text-[8px] text-[var(--muted)] mt-1">{criterion.detail}</div>}</div>)}{!verdict?.criteria?.length && <div className="text-[10px] text-[var(--muted)]">Acceptance criteria have not been evaluated.</div>}</div></Panel><Panel><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3"><ShieldCheck size={13} /> Run autopsy</div><div className="text-2xl font-semibold" style={{ color: snapshot.diagnosis?.verdict === "failed" ? "var(--accent-danger)" : snapshot.diagnosis?.verdict === "clean" ? "var(--accent-success)" : "var(--accent-warn)" }}>{snapshot.diagnosis?.verdict || "pending"}</div><div className="space-y-2 mt-4">{snapshot.diagnosis?.findings.map((finding, index) => <div key={`${finding.code}-${index}`} className="p-2 rounded border border-[var(--border-soft)] bg-[var(--surface-2)]"><div className="text-[8px] uppercase tracking-wide" style={{ color: finding.severity === "failure" ? "var(--accent-danger)" : "var(--accent-warn)" }}>{finding.code}{finding.nodeId ? ` · ${finding.nodeId}` : ""}</div><div className="text-[9px] text-[var(--text-2)] mt-1 leading-relaxed">{finding.detail}</div></div>)}{!snapshot.diagnosis?.findings.length && <div className="text-[10px] text-[var(--muted)]">No audit findings.</div>}</div></Panel></div><Panel padding="none" className="overflow-hidden"><div className="px-3 py-2 border-b border-[var(--border)] text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Durable event ledger · {snapshot.events.length}</div><div className="max-h-[68vh] overflow-auto font-mono text-[9px]">{snapshot.events.map((event) => <div id={`hive-event-${event.eventId || event.seq}`} key={event.eventId || event.seq} className="grid grid-cols-[54px_72px_110px_1fr] gap-2 px-3 py-1.5 border-b border-[var(--border-soft)] scroll-mt-12"><span className="text-[var(--muted)]">#{event.seq}</span><span className="text-[var(--muted)]">{new Date(event.ts).toLocaleTimeString()}</span><span className="text-[var(--accent-ai)] truncate" title={`${event.traceId || snapshot.workflow.id} / ${event.spanId || event.seq}`}>{event.kind}</span><span className="text-[var(--text-2)] whitespace-pre-wrap break-all">{event.nodeId ? `[${event.nodeId}] ` : ""}{typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)}</span></div>)}</div></Panel></div>;
}

function TaskContractEditor({ workflow }: { workflow: Workflow }) {
  const [objective, setObjective] = useState(workflow.envelope.objective);
  const [requiredOutput, setRequiredOutput] = useState(workflow.envelope.requiredOutput);
  const [criteria, setCriteria] = useState(workflow.envelope.definitionOfDone.join("\n"));
  const [constraints, setConstraints] = useState(workflow.envelope.constraints.join("\n"));
  const [deliverables, setDeliverables] = useState(JSON.stringify(workflow.envelope.deliverables || [{ id: "primary-output", description: workflow.envelope.requiredOutput, required: true }], null, 2));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const editable = ["queued", "paused", "incomplete", "blocked", "failed"].includes(workflow.status);
  const save = async () => {
    setSaving(true); setMessage("");
    try {
      const response = await fetch(`/api/hive/workflows/${workflow.id}/contract`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope: { ...workflow.envelope, objective, latestUserRequest: objective, requiredOutput, constraints: constraints.split("\n").map((item) => item.trim()).filter(Boolean), deliverables: JSON.parse(deliverables), definitionOfDone: criteria.split("\n").map((item) => item.trim()).filter(Boolean) } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "contract update failed");
      setMessage("Saved to the durable task contract.");
    } catch (error) { setMessage((error as Error).message); }
    finally { setSaving(false); }
  };
  return <Panel><div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3">Task contract</div><div className="space-y-2"><textarea value={objective} disabled={!editable} onChange={(event) => setObjective(event.target.value)} aria-label="Objective" className="w-full min-h-16 bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 text-[10px] disabled:opacity-60" /><textarea value={requiredOutput} disabled={!editable} onChange={(event) => setRequiredOutput(event.target.value)} aria-label="Required output" className="w-full min-h-12 bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 text-[10px] disabled:opacity-60" /><textarea value={deliverables} disabled={!editable} onChange={(event) => setDeliverables(event.target.value)} aria-label="Deliverables JSON" className="w-full min-h-24 bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 font-mono text-[8px] disabled:opacity-60" /><textarea value={constraints} disabled={!editable} onChange={(event) => setConstraints(event.target.value)} aria-label="Constraints, one per line" className="w-full min-h-16 bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 text-[10px] disabled:opacity-60" /><textarea value={criteria} disabled={!editable} onChange={(event) => setCriteria(event.target.value)} aria-label="Acceptance criteria, one per line" className="w-full min-h-24 bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 text-[10px] disabled:opacity-60" />{editable ? <Button size="sm" active disabled={saving || !objective.trim() || !requiredOutput.trim() || !criteria.trim()} onClick={save}>{saving ? "Saving…" : "Save contract"}</Button> : <p className="text-[8px] text-[var(--muted)]">Pause the mission to edit its objective, deliverables, constraints, or acceptance criteria.</p>}{message && <p className="text-[8px] text-[var(--muted)]">{message}</p>}</div></Panel>;
}

function EmptyHive() { return <Panel className="min-h-[70vh] grid place-items-center text-center"><div className="max-w-md"><Bot size={28} className="mx-auto text-[var(--accent-ai)]" /><div className="text-sm font-semibold mt-3">Give the team a mission or open a previous run.</div><div className="text-[10px] text-[var(--muted)] leading-relaxed mt-2">Supervised missions stop for tool approval and accept durable guidance. Autopilot missions continue through verification gates without waiting for routine approval.</div></div></Panel>; }
function formatDuration(ms: number) { if (!ms || !Number.isFinite(ms)) return "0s"; const seconds = Math.round(ms / 1000), minutes = Math.floor(seconds / 60); return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; }
function relativeTime(ts: number) { const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000)); if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return new Date(ts).toLocaleDateString(); }
