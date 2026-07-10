"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, Check, Circle, FileText, Pause, Play, RotateCcw, Send, Settings2, ShieldCheck, Square, User, X } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SignalTrace } from "@/components/ui/signal-trace";
import { ICON_SIZE } from "@/components/ui/icon";

type Artifact = { hash: string; mediaType: string; size: number; label?: string };
type Finding = { id: string; text: string; evidenceIds?: string[]; confidence?: number };
type Verification = { passed: boolean; score?: number; checks: { code: string; passed: boolean; detail: string }[] };
type StageResult = { status: string; summary: string; findings: Finding[]; artifacts: Artifact[]; uncertainties: string[]; errors: string[]; verification?: Verification };
type Evidence = { id: string; url: string; retrievedAt: number; sourceHash: string; excerpt: string; stance: string; claim?: string; title?: string };
type Workflow = {
  id: string; kind: "research" | "coding"; status: string; templateId: string; executionRunId?: string;
  createdAt: number; updatedAt: number; startedAt?: number; finishedAt?: number; error?: string;
  working?: { controlMode?: string; operatorMessages?: { id: string; ts: number; message: string }[] };
  envelope: { objective: string; workspace?: string };
  budget: { name: string; wallTimeMs?: number; inferenceTokens?: number };
  spec: { nodes: { id: string; optional?: boolean }[] };
};
type Node = {
  nodeId: string; label: string; role: string; status: string; attempt: number; modelVersion?: string;
  startedAt?: number; finishedAt?: number; durationMs?: number; promptTokens: number; completionTokens: number;
  contextTokens: number; swapMs: number; toolCalls: number; result?: StageResult; error?: string;
};
type HiveEvent = { seq: number; ts: number; kind: string; nodeId?: string; role?: string; modelVersion?: string; payload: unknown };
type Diagnosis = { verdict: string; findings: { code: string; nodeId?: string; detail: string; severity: string }[]; stats: { nodes: number; completed: number; retries: number; swaps: number; evidence: number } };
type Snapshot = { workflow: Workflow; nodes: Node[]; evidence: Evidence[]; events: HiveEvent[]; diagnosis?: Diagnosis };
type PendingApproval = { id: string; name: string; args: Record<string, unknown> };
type RoleProfile = { id: string; coordinator?: boolean; prompt: string; permittedTools: string[]; modelRequirements: string[]; evaluationSuite: string };
type RoleOverride = { prompt?: string; preferredModel?: string };
type ModelProfileInfo = { id: string; provider: string; model: string; capabilities: string[]; probeStatus: string };
type ViewTab = "conversation" | "plan" | "evidence" | "agents" | "audit";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const RUN_TERMINAL = new Set(["done", "error", "stopped", "interrupted"]);
const statusColor = (status: string) => status === "succeeded" ? "var(--accent-success)" : status === "failed" || status === "cancelled" ? "var(--accent-danger)" : status === "running" ? "var(--accent-warn)" : "var(--muted)";

function StatusIcon({ status }: { status: string }) {
  if (status === "succeeded") return <Check size={ICON_SIZE.sm} />;
  if (status === "failed" || status === "cancelled") return <X size={ICON_SIZE.sm} />;
  if (status === "running") return <SignalTrace size="sm" />;
  if (status === "paused" || status === "awaiting_approval") return <Pause size={ICON_SIZE.sm} />;
  return <Circle size={ICON_SIZE.sm} />;
}

function nodeThinking(events: HiveEvent[], nodeId: string) {
  let thinking = "", text = "";
  const calls: string[] = [];
  for (const event of events) {
    if (event.nodeId !== nodeId) continue;
    if (event.kind === "worker_think") thinking += String(event.payload ?? "");
    else if (event.kind === "worker_text") text += String(event.payload ?? "");
    else if (event.kind === "worker_tool_request") { const payload = event.payload as { name?: string } | null; if (payload?.name) calls.push(`→ ${payload.name}`); }
    else if (event.kind === "worker_tool_result") { const payload = event.payload as { name?: string; ok?: boolean } | null; if (payload?.name) calls.push(`${payload.ok ? "✓" : "✗"} ${payload.name}`); }
  }
  return { thinking, text, calls };
}

export default function HivePage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [roles, setRoles] = useState<Record<string, RoleProfile>>({});
  const [roleOverrides, setRoleOverrides] = useState<Record<string, RoleOverride>>({});
  const [models, setModels] = useState<ModelProfileInfo[]>([]);
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [editModel, setEditModel] = useState("");
  const [roleBusy, setRoleBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [kind, setKind] = useState<"research" | "coding">("research");
  const [budget, setBudget] = useState("standard");
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

  const esRef = useRef<EventSource | null>(null);
  const attachedRunIdRef = useRef<string | null>(null);
  const reloadRef = useRef<(id: string) => void>(() => {});
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadList = useCallback(async () => {
    try {
      const data = await fetch("/api/hive/workflows", { cache: "no-store" }).then((response) => response.json());
      setWorkflows(data.workflows || []); setRoles(data.roles || {}); setRoleOverrides(data.roleOverrides || {}); setModels(data.models || []);
    } catch { /* model swaps can briefly interrupt the local API */ }
  }, []);

  const loadSnapshot = useCallback(async (id: string) => {
    try {
      const detail = await fetch(`/api/hive/workflows/${id}?events=2000`, { cache: "no-store" }).then((response) => response.json());
      if (!detail.workflow) return;
      setSnapshot(detail); setAutoApprove(detail.workflow.working?.controlMode === "autopilot");
      const runId: string | undefined = detail.workflow.executionRunId;
      if (runId && attachedRunIdRef.current !== runId) {
        esRef.current?.close(); attachedRunIdRef.current = runId;
        const stream = new EventSource(`/api/agent/runs/${runId}/stream`); esRef.current = stream;
        stream.onmessage = (message) => {
          let event: { k?: string; v?: unknown };
          try { event = JSON.parse(message.data); } catch { return; }
          if (event.k === "approval_needed") setPendingApproval(event.v as PendingApproval);
          else if (event.k === "approval_result") setPendingApproval(null);
          const ended = event.k === "status" && typeof event.v === "string" && RUN_TERMINAL.has(event.v);
          if (ended) { stream.close(); if (esRef.current === stream) { esRef.current = null; attachedRunIdRef.current = null; } }
          if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
          reloadTimerRef.current = setTimeout(() => { reloadTimerRef.current = null; reloadRef.current(id); }, ended ? 0 : 400);
        };
      }
    } catch { /* keep the last durable snapshot visible */ }
  }, []);

  useEffect(() => { reloadRef.current = loadSnapshot; }, [loadSnapshot]);
  useEffect(() => { const initial = setTimeout(loadList, 0); const timer = setInterval(loadList, 5_000); return () => { clearTimeout(initial); clearInterval(timer); }; }, [loadList]);
  useEffect(() => {
    esRef.current?.close(); esRef.current = null; attachedRunIdRef.current = null;
    if (!selected) { const timer = setTimeout(() => { setSnapshot(null); setPendingApproval(null); setExpandedNode(null); }, 0); return () => clearTimeout(timer); }
    const timer = setTimeout(() => { setPendingApproval(null); setExpandedNode(null); loadSnapshot(selected); }, 0);
    return () => { clearTimeout(timer); if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current); esRef.current?.close(); esRef.current = null; attachedRunIdRef.current = null; };
  }, [selected, loadSnapshot]);

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
      setSelected(data.workflowId); setActiveTab("conversation"); setObjective(""); await loadList();
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

  return (
    <main className="min-h-dvh bg-[var(--bg)] text-[var(--text)] px-3 py-3 pb-20">
      <div className="max-w-[1700px] mx-auto grid lg:grid-cols-[310px_minmax(0,1fr)] gap-3 items-start">
        <aside className="flex flex-col gap-3 lg:sticky lg:top-3">
          <Panel className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2"><div className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-2)]">New mission</div><ModeSwitch auto={autoApprove} onChange={setAutoApprove} /></div>
            <div className="grid grid-cols-2 gap-1">{(["research", "coding"] as const).map((value) => <button key={value} onClick={() => setKind(value)} className="h-8 rounded-[var(--r-md)] border text-[10px] uppercase tracking-wide" style={{ borderColor: kind === value ? "var(--accent-ai)" : "var(--border)", color: kind === value ? "var(--accent-ai)" : "var(--text-2)", background: kind === value ? "color-mix(in srgb, var(--accent-ai) 10%, transparent)" : "var(--surface-2)" }}>{value}</button>)}</div>
            <textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder={kind === "research" ? "What should the team investigate?" : "What should the team build or repair?"} className="w-full min-h-28 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-3 text-xs leading-relaxed resize-y outline-none focus:border-[var(--border-loud)]" />
            {kind === "coding" && <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="Absolute workspace path" className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2.5 text-xs outline-none focus:border-[var(--border-loud)]" />}
            <div className="grid grid-cols-2 gap-2"><select value={budget} onChange={(event) => setBudget(event.target.value)} className="bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2 text-[10px]"><option value="quick">Quick · 2m</option><option value="standard">Standard · 15m</option><option value="deep">Deep · 60m</option></select><select value={preferredModel} onChange={(event) => setPreferredModel(event.target.value)} className="bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2 text-[10px]"><option value="">Models: by role</option>{[...new Set(models.map((model) => model.model))].map((model) => <option key={model}>{model}</option>)}</select></div>
            <p className="text-[9px] text-[var(--muted)] leading-relaxed">{autoApprove ? "Autopilot runs permitted tools automatically. Verification gates remain mandatory." : "Supervised mode stops for mutating tools and accepts guidance throughout the run."}</p>
            <Button active disabled={busy || !objective.trim()} onClick={start} className="w-full justify-center font-bold text-xs disabled:opacity-40">Start {kind} mission</Button>
            {error && <p className="text-[10px] text-[var(--accent-danger)] leading-relaxed">{error}</p>}
          </Panel>

          <Panel padding="none" className="overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] flex items-center text-[9px] uppercase tracking-[0.16em] text-[var(--muted)]">Runs <span className="ml-auto">{workflows.length}</span></div>
            <div className="max-h-[42vh] overflow-auto">{workflows.map((workflow) => <RunRow key={workflow.id} workflow={workflow} selected={selected === workflow.id} open={() => { setSelected(workflow.id); setActiveTab("conversation"); }} remove={() => deleteRun(workflow.id)} />)}{!workflows.length && <div className="p-4 text-[10px] text-[var(--muted)]">No missions yet.</div>}</div>
          </Panel>
          <button onClick={() => setActiveTab("agents")} className="h-9 flex items-center gap-2 px-3 rounded-[var(--r-md)] border border-[var(--border)] text-[10px] text-[var(--text-2)] hover:border-[var(--border-loud)]"><Settings2 size={13} /> Configure agents <span className="ml-auto text-[var(--muted)]">{Object.keys(roles).length}</span></button>
        </aside>

        <section className="min-w-0 flex flex-col gap-3">
          {snapshot ? <>
            <RunHeader snapshot={snapshot} busy={busy} action={action} />
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2"><RunStat label="Progress" value={`${completed}/${snapshot.nodes.length}`} note={activeNode ? activeNode.label : "no active agent"} /><RunStat label="Tokens" value={usedTokens.toLocaleString()} note={snapshot.workflow.budget.inferenceTokens ? `${Math.round(100 * usedTokens / snapshot.workflow.budget.inferenceTokens)}% of budget` : "recorded usage"} /><RunStat label="Elapsed" value={formatDuration(elapsedMs)} note={snapshot.workflow.budget.wallTimeMs ? `${formatDuration(snapshot.workflow.budget.wallTimeMs)} budget` : snapshot.workflow.status} /><RunStat label="Evidence" value={String(snapshot.evidence.length)} note={`${snapshot.nodes.reduce((sum, node) => sum + (node.result?.artifacts.length || 0), 0)} artifacts`} /><RunStat label="Autopsy" value={snapshot.diagnosis?.verdict || "pending"} note={`${snapshot.diagnosis?.findings.length || 0} findings`} tone={snapshot.diagnosis?.verdict === "failed" ? "danger" : snapshot.diagnosis?.verdict === "clean" ? "success" : undefined} /></div>
            <TabBar active={activeTab} onChange={setActiveTab} evidence={snapshot.evidence.length} />
            {pendingApproval && <ApprovalCard approval={pendingApproval} busy={busy} onAnswer={respondApproval} />}
            {activeTab === "conversation" && <ConversationView snapshot={snapshot} expandedNode={expandedNode} setExpandedNode={setExpandedNode} busy={busy} overrideNode={overrideNode} guidance={guidance} setGuidance={setGuidance} steerBusy={steerBusy} steer={steer} />}
            {activeTab === "plan" && <PlanView snapshot={snapshot} expandedNode={expandedNode} setExpandedNode={setExpandedNode} busy={busy} overrideNode={overrideNode} />}
            {activeTab === "evidence" && <EvidenceView evidence={snapshot.evidence} nodes={snapshot.nodes} />}
            {activeTab === "agents" && <AgentStudio roles={roles} models={models} overrides={roleOverrides} editingRole={editingRole} editPrompt={editPrompt} editModel={editModel} busy={roleBusy} setEditPrompt={setEditPrompt} setEditModel={setEditModel} startEdit={startEditRole} cancel={() => setEditingRole(null)} save={saveRole} reset={resetRole} />}
            {activeTab === "audit" && <AuditView snapshot={snapshot} />}
          </> : activeTab === "agents" ? <AgentStudio roles={roles} models={models} overrides={roleOverrides} editingRole={editingRole} editPrompt={editPrompt} editModel={editModel} busy={roleBusy} setEditPrompt={setEditPrompt} setEditModel={setEditModel} startEdit={startEditRole} cancel={() => setEditingRole(null)} save={saveRole} reset={resetRole} /> : <EmptyHive />}
        </section>
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
  return <Panel padding="sm" className="flex flex-wrap items-center gap-2"><div className="min-w-0 flex-1 px-1"><div className="text-xs font-semibold truncate">{snapshot.workflow.envelope.objective}</div><div className="text-[8px] text-[var(--muted)] mt-0.5">{snapshot.workflow.kind} · {snapshot.workflow.budget.name} · {snapshot.workflow.working?.controlMode || "supervised"}</div></div><span className="text-[9px] uppercase tracking-wide px-2 py-1 rounded-full border" style={{ color: statusColor(snapshot.workflow.status), borderColor: statusColor(snapshot.workflow.status) }}>{snapshot.workflow.status}</span>{["running", "queued", "awaiting_approval"].includes(snapshot.workflow.status) && <button title="Pause at a durable checkpoint" disabled={busy} onClick={() => action("pause")} className="h-8 w-8 grid place-items-center rounded border border-[var(--border)] text-[var(--accent-warn)]"><Pause size={14} /></button>}{!TERMINAL.has(snapshot.workflow.status) && <button title="Stop mission" disabled={busy} onClick={() => action("stop")} className="h-8 w-8 grid place-items-center rounded border border-[var(--border)] text-[var(--accent-danger)]"><Square size={12} /></button>}{["failed", "cancelled", "paused"].includes(snapshot.workflow.status) && <button title="Resume from checkpoint" disabled={busy} onClick={() => action("resume")} className="h-8 px-2 flex items-center gap-1 rounded border border-[var(--border)] text-[10px] text-[var(--accent-ai)]"><Play size={13} /> Resume</button>}{TERMINAL.has(snapshot.workflow.status) && <button title="Replay as a new run" disabled={busy} onClick={() => action("replay")} className="h-8 px-2 flex items-center gap-1 rounded border border-[var(--border)] text-[10px] text-[var(--text-2)]"><RotateCcw size={13} /> Replay</button>}</Panel>;
}

function RunStat({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "danger" | "success" }) {
  const color = tone === "danger" ? "var(--accent-danger)" : tone === "success" ? "var(--accent-success)" : "var(--text)";
  return <Panel padding="sm"><div className="text-[8px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div><div className="text-lg font-semibold mt-0.5 truncate" style={{ color }}>{value}</div><div className="text-[8px] text-[var(--muted)] truncate">{note}</div></Panel>;
}

function TabBar({ active, onChange, evidence }: { active: ViewTab; onChange: (tab: ViewTab) => void; evidence: number }) {
  return <div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border-soft)] pb-2">{([['conversation', 'Conversation'], ['plan', 'Plan'], ['evidence', `Evidence ${evidence}`], ['agents', 'Agents'], ['audit', 'Audit']] as const).map(([id, label]) => <button key={id} onClick={() => onChange(id)} className="h-8 px-3 rounded-[var(--r-md)] text-[10px] whitespace-nowrap" style={{ background: active === id ? "var(--surface-3)" : "transparent", color: active === id ? "var(--accent-ai)" : "var(--text-2)", border: `1px solid ${active === id ? "var(--border-loud)" : "transparent"}` }}>{label}</button>)}</div>;
}

function ApprovalCard({ approval, busy, onAnswer }: { approval: PendingApproval; busy: boolean; onAnswer: (allow: boolean) => void }) {
  return <Panel className="grid md:grid-cols-[1fr_auto] gap-3 items-center" style={{ borderColor: "var(--accent-warn)" }}><div><div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-[var(--accent-warn)]"><AlertTriangle size={13} /> Tool approval</div><div className="text-sm mt-1">Allow <span className="text-[var(--accent-ai)] font-mono">{approval.name}</span>?</div><pre className="text-[9px] text-[var(--muted)] mt-1 max-h-20 overflow-auto whitespace-pre-wrap">{JSON.stringify(approval.args, null, 2)}</pre></div><div className="flex gap-2"><Button active disabled={busy} onClick={() => onAnswer(true)}>Allow</Button><Button variant="danger" disabled={busy} onClick={() => onAnswer(false)}>Deny</Button></div></Panel>;
}

function ConversationView({ snapshot, expandedNode, setExpandedNode, busy, overrideNode, guidance, setGuidance, steerBusy, steer }: { snapshot: Snapshot; expandedNode: string | null; setExpandedNode: (id: string | null) => void; busy: boolean; overrideNode: (nodeId: string, action: "retry" | "skip") => void; guidance: string; setGuidance: (value: string) => void; steerBusy: boolean; steer: (pause: boolean) => void }) {
  const feed: ({ kind: "objective"; ts: number } | { kind: "node"; ts: number; node: Node } | { kind: "operator"; ts: number; message: string; id: string })[] = [
    { kind: "objective" as const, ts: snapshot.workflow.createdAt },
    ...snapshot.nodes.filter((node) => node.startedAt || node.result || node.error).map((node) => ({ kind: "node" as const, ts: node.startedAt || snapshot.workflow.createdAt + 1, node })),
    ...snapshot.events.filter((event) => event.kind === "operator_message").map((event) => { const payload = event.payload as { id?: string; message?: string }; return { kind: "operator" as const, ts: event.ts, message: payload.message || "", id: payload.id || String(event.seq) }; }),
  ].sort((a, b) => a.ts - b.ts);
  return <Panel padding="none" className="overflow-hidden"><div className="max-h-[66vh] min-h-[420px] overflow-auto px-3 md:px-5 py-4 space-y-4">{feed.map((item) => item.kind === "objective" ? <OperatorMessage key="objective" label="Mission" text={snapshot.workflow.envelope.objective} ts={item.ts} /> : item.kind === "operator" ? <OperatorMessage key={item.id} label="Guidance" text={item.message} ts={item.ts} /> : <AgentMessage key={item.node.nodeId} node={item.node} events={snapshot.events} workflow={snapshot.workflow} expanded={expandedNode === item.node.nodeId} toggle={() => setExpandedNode(expandedNode === item.node.nodeId ? null : item.node.nodeId)} busy={busy} overrideNode={overrideNode} />)}{!feed.some((item) => item.kind === "node") && <div className="text-center text-[10px] text-[var(--muted)] py-16">The first agent will appear here when execution begins.</div>}</div>{snapshot.workflow.status !== "succeeded" && <div className="border-t border-[var(--border)] p-3 bg-[var(--surface-1)]"><textarea value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="Guide the next agent, correct an assumption, or change priorities…" className="w-full min-h-16 max-h-32 bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] p-2.5 text-xs resize-y outline-none focus:border-[var(--border-loud)]" /><div className="flex flex-wrap items-center gap-2 mt-2"><span className="text-[8px] text-[var(--muted)] mr-auto">Guidance is written to the durable context for subsequent agents.</span><button disabled={steerBusy || !guidance.trim()} onClick={() => steer(false)} className="h-8 px-3 inline-flex items-center gap-1.5 rounded border border-[var(--border)] text-[10px] text-[var(--text-2)] disabled:opacity-40"><Send size={12} /> Send guidance</button><button disabled={steerBusy || !guidance.trim()} onClick={() => steer(true)} className="h-8 px-3 inline-flex items-center gap-1.5 rounded bg-[var(--accent-warn)] text-[var(--bg)] text-[10px] font-semibold disabled:opacity-40"><Pause size={12} /> Pause &amp; redirect</button></div></div>}</Panel>;
}

function OperatorMessage({ label, text, ts }: { label: string; text: string; ts: number }) {
  return <div className="flex justify-end gap-2"><div className="max-w-[82%] rounded-[var(--r-lg)] rounded-tr-sm bg-[color-mix(in_srgb,var(--accent-ai)_14%,var(--surface-2))] border border-[var(--border)] px-3 py-2"><div className="flex items-center gap-2 text-[8px] uppercase tracking-wide text-[var(--accent-ai)]"><User size={10} />{label}<span className="text-[var(--muted)] normal-case ml-auto">{new Date(ts).toLocaleTimeString()}</span></div><div className="text-xs leading-relaxed mt-1 whitespace-pre-wrap">{text}</div></div></div>;
}

function AgentMessage({ node, events, workflow, expanded, toggle, busy, overrideNode }: { node: Node; events: HiveEvent[]; workflow: Workflow; expanded: boolean; toggle: () => void; busy: boolean; overrideNode: (nodeId: string, action: "retry" | "skip") => void }) {
  const live = nodeThinking(events, node.nodeId); const active = ["running", "awaiting_approval"].includes(node.status);
  const optional = !!workflow.spec.nodes.find((item) => item.id === node.nodeId)?.optional;
  const canOverride = node.status === "failed" && !["running", "queued"].includes(workflow.status);
  const result = node.result;
  const hasDetails = !!(live.thinking || live.text || live.calls.length || result?.findings.length || result?.verification || result?.artifacts.length || result?.uncertainties.length || result?.errors.length);
  return <div className="flex gap-2 max-w-[94%]"><div className="w-7 h-7 rounded-full border border-[var(--border)] bg-[var(--surface-2)] grid place-items-center shrink-0" style={{ color: statusColor(node.status) }}><Bot size={13} /></div><div className="min-w-0 flex-1 rounded-[var(--r-lg)] rounded-tl-sm bg-[var(--surface-2)] border border-[var(--border-soft)] px-3 py-2.5"><button onClick={toggle} disabled={!hasDetails} className="w-full flex flex-wrap items-center gap-x-2 gap-y-1 text-left disabled:cursor-default"><span className="text-[10px] font-semibold">{node.label}</span><span className="text-[8px] uppercase tracking-wide" style={{ color: statusColor(node.status) }}>{node.status}</span><span className="text-[8px] text-[var(--muted)]">{node.role} · attempt {node.attempt}</span>{active && <SignalTrace size="sm" className="ml-auto" />}{hasDetails && !active && <span className="ml-auto text-[8px] text-[var(--accent-ai)]">{expanded ? "less" : "details"}</span>}</button><div className="flex flex-wrap gap-x-3 text-[8px] text-[var(--muted)] mt-1"><span>{node.durationMs != null ? formatDuration(node.durationMs) : active ? "working" : "—"}</span><span>{node.promptTokens + node.completionTokens} tok</span><span>{node.toolCalls} tools</span>{node.modelVersion && <span>model {node.modelVersion.slice(0, 8)}</span>}</div>{result?.summary && <p className="text-xs text-[var(--text-2)] leading-relaxed whitespace-pre-wrap mt-2">{result.summary}</p>}{node.error && <p className="text-[10px] text-[var(--accent-danger)] mt-2">{node.error}</p>}{live.calls.length > 0 && <div className="flex flex-wrap gap-1 mt-2">{live.calls.map((call, index) => <span key={index} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--muted)]">{call}</span>)}</div>}{(active || expanded) && <AgentDetails node={node} live={live} />}{canOverride && <div className="flex gap-2 mt-3"><Button size="sm" disabled={busy} onClick={() => overrideNode(node.nodeId, "retry")} className="border border-[var(--accent-ai)]/50 text-[var(--accent-ai)]">Retry this step</Button>{optional && <Button size="sm" disabled={busy} onClick={() => overrideNode(node.nodeId, "skip")} className="border border-[var(--border)]">Skip optional step</Button>}</div>}</div></div>;
}

function AgentDetails({ node, live }: { node: Node; live: ReturnType<typeof nodeThinking> }) {
  const result = node.result;
  return <div className="mt-3 pt-3 border-t border-[var(--border-soft)] space-y-3">{live.thinking && <DetailBlock title="Thinking"><pre className="text-[10px] text-[var(--text-2)] italic whitespace-pre-wrap max-h-52 overflow-auto">{live.thinking}</pre></DetailBlock>}{live.text && <DetailBlock title="Live output"><pre className="text-[10px] text-[var(--text)] whitespace-pre-wrap max-h-52 overflow-auto">{live.text}</pre></DetailBlock>}{result?.findings?.length ? <DetailBlock title={`Findings · ${result.findings.length}`}><div className="space-y-1.5">{result.findings.map((finding) => <div key={finding.id} className="text-[10px] text-[var(--text-2)] leading-relaxed"><span className="text-[var(--muted)] mr-1">•</span>{finding.text}{finding.confidence != null && <span className="text-[8px] text-[var(--muted)] ml-2">{Math.round(finding.confidence * 100)}%</span>}</div>)}</div></DetailBlock> : null}{result?.verification && <DetailBlock title={`Verification · ${result.verification.passed ? "passed" : "failed"}`}><div className="space-y-1">{result.verification.checks.map((check) => <div key={check.code} className="grid grid-cols-[14px_1fr] gap-1 text-[9px]"><span style={{ color: check.passed ? "var(--accent-success)" : "var(--accent-danger)" }}>{check.passed ? "✓" : "×"}</span><span><b className="text-[var(--text-2)]">{check.code}</b> · <span className="text-[var(--muted)]">{check.detail}</span></span></div>)}</div></DetailBlock>}{result?.artifacts?.length ? <DetailBlock title="Artifacts"><ArtifactLinks artifacts={result.artifacts} /></DetailBlock> : null}{result?.uncertainties?.length ? <DetailBlock title="Uncertainties"><ul className="text-[10px] text-[var(--accent-warn)] list-disc pl-4">{result.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul></DetailBlock> : null}{result?.errors?.length ? <DetailBlock title="Errors"><ul className="text-[10px] text-[var(--accent-danger)] list-disc pl-4">{result.errors.map((item, index) => <li key={index}>{item}</li>)}</ul></DetailBlock> : null}</div>;
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) { return <div><div className="text-[8px] uppercase tracking-[0.14em] text-[var(--muted)] mb-1">{title}</div>{children}</div>; }
function ArtifactLinks({ artifacts }: { artifacts: Artifact[] }) { return <div className="flex flex-wrap gap-2">{artifacts.map((artifact) => <a key={artifact.hash} href={`/api/hive/artifacts/${artifact.hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[9px] text-[var(--accent-ai)] border border-[var(--border)] rounded px-2 py-1"><FileText size={10} />{artifact.label || artifact.hash.slice(0, 10)}</a>)}</div>; }

function PlanView({ snapshot, expandedNode, setExpandedNode, busy, overrideNode }: { snapshot: Snapshot; expandedNode: string | null; setExpandedNode: (id: string | null) => void; busy: boolean; overrideNode: (nodeId: string, action: "retry" | "skip") => void }) {
  return <Panel><div className="space-y-0">{snapshot.nodes.map((node, index) => <div key={node.nodeId} className="grid grid-cols-[24px_1fr] gap-2"><div className="flex flex-col items-center pt-3" style={{ color: statusColor(node.status) }}><StatusIcon status={node.status} />{index < snapshot.nodes.length - 1 && <span className="w-px flex-1 min-h-10 bg-[var(--border)]" />}</div><div className="py-3 border-b border-[var(--border-soft)] last:border-0"><AgentMessage node={node} events={snapshot.events} workflow={snapshot.workflow} expanded={expandedNode === node.nodeId} toggle={() => setExpandedNode(expandedNode === node.nodeId ? null : node.nodeId)} busy={busy} overrideNode={overrideNode} /></div></div>)}</div></Panel>;
}

function EvidenceView({ evidence, nodes }: { evidence: Evidence[]; nodes: Node[] }) {
  const artifacts = nodes.flatMap((node) => (node.result?.artifacts || []).map((artifact) => ({ ...artifact, node: node.label })));
  return <div className="grid xl:grid-cols-[1fr_300px] gap-3 items-start"><Panel><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3"><ShieldCheck size={13} /> Source evidence · {evidence.length}</div><div className="space-y-2">{evidence.map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="block p-3 rounded-[var(--r-md)] border border-[var(--border-soft)] bg-[var(--surface-2)] hover:border-[var(--border-loud)]"><div className="flex items-center gap-2"><span className="text-[8px] uppercase tracking-wide" style={{ color: item.stance === "contradicting" ? "var(--accent-danger)" : item.stance === "supporting" ? "var(--accent-success)" : "var(--accent-ai)" }}>{item.stance}</span><span className="text-[10px] font-semibold truncate">{item.title || item.url}</span></div>{item.claim && <div className="text-[10px] text-[var(--text)] mt-1">{item.claim}</div>}<p className="text-[9px] text-[var(--muted)] leading-relaxed mt-1 line-clamp-4">{item.excerpt}</p></a>)}{!evidence.length && <div className="py-20 text-center text-[10px] text-[var(--muted)]">No fetched-source evidence yet.</div>}</div></Panel><Panel><div className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3">Artifacts · {artifacts.length}</div><div className="space-y-2">{artifacts.map((artifact) => <a key={`${artifact.hash}-${artifact.node}`} href={`/api/hive/artifacts/${artifact.hash}`} target="_blank" rel="noreferrer" className="flex items-start gap-2 p-2 rounded border border-[var(--border-soft)] text-[10px] hover:border-[var(--border-loud)]"><FileText size={12} className="text-[var(--accent-ai)] shrink-0" /><span className="min-w-0"><b className="block truncate">{artifact.label || artifact.hash.slice(0, 12)}</b><span className="text-[8px] text-[var(--muted)]">{artifact.node} · {(artifact.size / 1024).toFixed(1)} KB</span></span></a>)}</div></Panel></div>;
}

function AgentStudio({ roles, models, overrides, editingRole, editPrompt, editModel, busy, setEditPrompt, setEditModel, startEdit, cancel, save, reset }: { roles: Record<string, RoleProfile>; models: ModelProfileInfo[]; overrides: Record<string, RoleOverride>; editingRole: string | null; editPrompt: string; editModel: string; busy: boolean; setEditPrompt: (value: string) => void; setEditModel: (value: string) => void; startEdit: (role: RoleProfile) => void; cancel: () => void; save: (id: string) => void; reset: (id: string) => void }) {
  return <Panel><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3"><Settings2 size={13} /> Agent roles, prompts, and routing</div><div className="grid xl:grid-cols-2 gap-3">{Object.values(roles).map((role) => { const eligible = models.filter((model) => role.modelRequirements.every((requirement) => model.capabilities.includes(requirement))); const override = overrides[role.id]; const editing = editingRole === role.id; return <div key={role.id} className="p-3 rounded-[var(--r-md)] border border-[var(--border-soft)] bg-[var(--surface-2)]"><div className="flex items-center gap-2 flex-wrap"><Bot size={13} className="text-[var(--accent-ai)]" /><span className="text-xs font-semibold">{role.id}</span>{role.modelRequirements.map((requirement) => <span key={requirement} className="text-[7px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--muted)]">{requirement}</span>)}{(override?.prompt || override?.preferredModel) && <Badge tone="highlight">customized</Badge>}{!editing && <button onClick={() => startEdit(role)} className="ml-auto text-[9px] text-[var(--accent-ai)]">Edit</button>}</div>{editing ? <div className="space-y-2 mt-3"><textarea value={editPrompt} onChange={(event) => setEditPrompt(event.target.value)} className="w-full min-h-28 bg-[var(--surface-1)] border border-[var(--border)] rounded p-2 text-[10px] resize-y" /><select value={editModel} onChange={(event) => setEditModel(event.target.value)} className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded p-2 text-[10px]"><option value="">Preferred model: auto</option>{[...new Set(models.map((model) => model.model))].map((model) => <option key={model}>{model}</option>)}</select><div className="flex gap-2"><Button size="sm" active disabled={busy} onClick={() => save(role.id)}>Save</Button><Button size="sm" disabled={busy} onClick={cancel}>Cancel</Button>{(override?.prompt || override?.preferredModel) && <Button size="sm" disabled={busy} onClick={() => reset(role.id)} className="ml-auto text-[var(--accent-danger)]">Reset</Button>}</div></div> : <p className="text-[10px] text-[var(--text-2)] leading-relaxed mt-2">{role.prompt}</p>}<div className="text-[8px] text-[var(--muted)] mt-2">{override?.preferredModel ? `preferred ${override.preferredModel} · ` : ""}{eligible.length ? `eligible: ${eligible.map((model) => model.model).join(", ")}` : "no eligible verified model"}</div></div>; })}</div></Panel>;
}

function AuditView({ snapshot }: { snapshot: Snapshot }) {
  return <div className="grid xl:grid-cols-[360px_1fr] gap-3 items-start"><Panel><div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)] mb-3"><ShieldCheck size={13} /> Run autopsy</div><div className="text-2xl font-semibold" style={{ color: snapshot.diagnosis?.verdict === "failed" ? "var(--accent-danger)" : snapshot.diagnosis?.verdict === "clean" ? "var(--accent-success)" : "var(--accent-warn)" }}>{snapshot.diagnosis?.verdict || "pending"}</div><div className="space-y-2 mt-4">{snapshot.diagnosis?.findings.map((finding, index) => <div key={`${finding.code}-${index}`} className="p-2 rounded border border-[var(--border-soft)] bg-[var(--surface-2)]"><div className="text-[8px] uppercase tracking-wide" style={{ color: finding.severity === "failure" ? "var(--accent-danger)" : "var(--accent-warn)" }}>{finding.code}{finding.nodeId ? ` · ${finding.nodeId}` : ""}</div><div className="text-[9px] text-[var(--text-2)] mt-1 leading-relaxed">{finding.detail}</div></div>)}{!snapshot.diagnosis?.findings.length && <div className="text-[10px] text-[var(--muted)]">No audit findings.</div>}</div></Panel><Panel padding="none" className="overflow-hidden"><div className="px-3 py-2 border-b border-[var(--border)] text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Durable event ledger · {snapshot.events.length}</div><div className="max-h-[68vh] overflow-auto font-mono text-[9px]">{snapshot.events.map((event) => <div key={event.seq} className="grid grid-cols-[54px_72px_110px_1fr] gap-2 px-3 py-1.5 border-b border-[var(--border-soft)]"><span className="text-[var(--muted)]">#{event.seq}</span><span className="text-[var(--muted)]">{new Date(event.ts).toLocaleTimeString()}</span><span className="text-[var(--accent-ai)] truncate">{event.kind}</span><span className="text-[var(--text-2)] whitespace-pre-wrap break-all">{event.nodeId ? `[${event.nodeId}] ` : ""}{typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)}</span></div>)}</div></Panel></div>;
}

function EmptyHive() { return <Panel className="min-h-[70vh] grid place-items-center text-center"><div className="max-w-md"><Bot size={28} className="mx-auto text-[var(--accent-ai)]" /><div className="text-sm font-semibold mt-3">Give the team a mission or open a previous run.</div><div className="text-[10px] text-[var(--muted)] leading-relaxed mt-2">Supervised missions stop for tool approval and accept durable guidance. Autopilot missions continue through verification gates without waiting for routine approval.</div></div></Panel>; }
function formatDuration(ms: number) { if (!ms || !Number.isFinite(ms)) return "0s"; const seconds = Math.round(ms / 1000), minutes = Math.floor(seconds / 60); return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; }
function relativeTime(ts: number) { const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000)); if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return new Date(ts).toLocaleDateString(); }
