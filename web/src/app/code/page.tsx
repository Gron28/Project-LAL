"use client";
// Mini claude code: agentic coding chat over the workspace, with live tool activity,
// sub-agent traces, approval gating, and vision via the Gemma backend.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Bot, Brain, Check, ChevronDown, ChevronRight, CircleStop, Copy, ExternalLink, FolderGit2, Hammer, Menu, MessageSquarePlus, PanelLeft, Paperclip, Pencil, Send, Settings, ShieldCheck, Sparkles, Trash2, X, Zap } from "lucide-react";
import MarkdownView from "@/components/markdown-view";
import DirPicker from "@/components/code/dir-picker";
import FileTree from "@/components/code/file-tree";
import EditorPane from "@/components/code/editor-pane";
import GitPanel from "@/components/code/git-panel";
import RunPanel from "@/components/code/run-panel";
import AgentSettings from "@/components/agent/agent-settings";
import StatsHud, { StatsGlance, type Usage } from "@/components/agent/stats-hud";
import { useNavCollapsed } from "@/app/nav-context";

type Ev =
  | { k: "text"; v: string; agent?: string }
  | { k: "think"; v: string; agent?: string }
  | { k: "round"; agent?: string }
  | { k: "max_rounds"; v: number; agent?: string }
  | { k: "tool_request"; v: { id: string; name: string; args: Record<string, unknown> }; agent?: string }
  | { k: "tool_result"; v: { id: string; name: string; ok: boolean; output: string }; agent?: string }
  | { k: "approval_needed"; v: { id: string; name: string; args: Record<string, unknown> } }
  | { k: "project"; v: { root: string; instructionFiles: string[] } }
  | { k: "done"; v: { conversationId?: string; dir?: string } }
  | { k: "error"; v: string }
  // Deliberate-mode-only events (from /api/agent/deliberate — see lib/deliberate.ts).
  // "inner" wraps a nested tool-loop event tagged with which phase/role produced it;
  // it's unwrapped into the SAME shapes above (with `agent` set to that phase/role)
  // by applyEvent, so this rendering pipeline never needs a second code path.
  | { k: "roles"; v: { roles: { name: string; lens: string; bias?: string }[] } }
  | { k: "phase"; v: { name: string } }
  | { k: "role_progress"; v: { role: string; stage: string } }
  | { k: "debate_turn"; v: { round: number; role: string; text: string } }
  | { k: "convergence"; v: { round: number; verdict: string } }
  | { k: "artifact"; v: { path: string } }
  | { k: "inner"; v: { phase: string; role?: string; event: Ev } };

type ToolCall = { id: string; name: string; args: Record<string, unknown>; agent?: string; ok?: boolean; output?: string; pendingApproval?: boolean };
type Block =
  | { t: "user"; text: string; hIdx: number }
  | { t: "assistant"; text: string; think: string; agent?: string }
  | { t: "tool"; call: ToolCall }
  | { t: "status"; text: string }
  | { t: "error"; text: string };
type Convo = { id: string; title: string; updatedAt: number; project?: string };
// Raw shape of a persisted /code conversation turn (server keeps the full tool-loop
// transcript — tool role, null content on tool-call-only assistant turns).
type RawMsg = {
  role: string; content: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string; name?: string;
};
// What gets sent back to the server as context for the next turn — the raw
// transcript verbatim (system stripped, since the server adds its own), NOT a
// summary. Dropping tool_calls/tool messages here once meant the model had no
// memory of tool calls it already made (asked to describe an image, then on a
// follow-up it couldn't see it had already called describe_image, so it called
// it again — same for files it had already written).
type HistMsg = RawMsg;

// Rebuild the UI's Block[] (for display) and the raw history (for continuing the
// conversation with full tool-call memory intact) from a stored session's transcript.
function reconstructSession(messages: RawMsg[]): { blocks: Block[]; history: HistMsg[] } {
  const blocks: Block[] = [];
  const history: HistMsg[] = messages.filter((m) => m.role !== "system");
  const openToolById = new Map<string, ToolCall>();
  for (const m of messages) {
    if (m.role === "user") {
      blocks.push({ t: "user", text: m.content ?? "", hIdx: history.indexOf(m) });
    } else if (m.role === "assistant") {
      if (m.content) blocks.push({ t: "assistant", text: m.content, think: "" });
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments); } catch {}
        const call: ToolCall = { id: tc.id, name: tc.function.name, args, ok: true };
        openToolById.set(tc.id, call);
        blocks.push({ t: "tool", call });
      }
    } else if (m.role === "tool" && m.tool_call_id) {
      const call = openToolById.get(m.tool_call_id);
      if (call) call.output = m.content ?? "";
    }
  }
  return { blocks, history };
}

// Shared by both /api/agent/loop's stream and /api/agent/deliberate's — mutates
// `next` in place (matching the caller's existing slice-then-mutate pattern).
// Deliberate's "inner" events wrap a nested tool-loop event tagged with which
// phase/role produced it; unwrapping them into an `agent`-tagged version of the
// SAME event shapes means this one function renders both without a second path —
// a debate turn's tool_request block looks exactly like a sub-agent's would.
function applyEvent(next: Block[], e: Ev): void {
  const agent = (e as { agent?: string }).agent;
  const lastAssistant = () => {
    const last = next[next.length - 1];
    if (last?.t === "assistant" && last.agent === agent) return last;
    const nb = { t: "assistant" as const, text: "", think: "", agent };
    next.push(nb);
    return nb;
  };
  if (e.k === "text") { const a = lastAssistant(); a.text += e.v; }
  else if (e.k === "think") { const a = lastAssistant(); a.think += e.v; }
  else if (e.k === "tool_request") next.push({ t: "tool", call: { ...e.v, agent } });
  else if (e.k === "tool_result") {
    for (let j = next.length - 1; j >= 0; j--) {
      const b = next[j];
      if (b.t === "tool" && b.call.id === e.v.id) { next[j] = { t: "tool", call: { ...b.call, ok: e.v.ok, output: e.v.output } }; break; }
    }
  } else if (e.k === "error") next.push({ t: "error", text: e.v });
  else if (e.k === "max_rounds") next.push({ t: "error", text: (agent ? `[${agent}] ` : "") + `stopped after ${e.v} tool-call rounds without finishing.` });
  else if (e.k === "phase") next.push({ t: "status", text: "── " + e.v.name + " ──" });
  else if (e.k === "roles") next.push({ t: "status", text: "Perspectives: " + e.v.roles.map((r) => `${r.name} (${r.lens})`).join(" · ") });
  else if (e.k === "debate_turn") next.push({ t: "assistant", text: e.v.text, think: "", agent: e.v.role });
  else if (e.k === "convergence") next.push({ t: "status", text: `convergence check, round ${e.v.round}: ${e.v.verdict}` });
  else if (e.k === "artifact") next.push({ t: "status", text: "saved: " + e.v.path.split("/").pop() });
  else if (e.k === "inner") applyEvent(next, { ...e.v.event, agent: e.v.role || e.v.phase } as Ev);
}

const summarizeArgs = (a: Record<string, unknown>) => {
  const s = Object.entries(a).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(", ");
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
};

const projSeg = (project: string) =>
  project ? btoa(unescape(encodeURIComponent(project))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "_";
const fileHref = (project: string, p: string) =>
  `/api/agent/file/${projSeg(project)}/` + p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

function CopyBtn({ text, size = 12 }: { text: string; size?: number }) {
  const [ok, setOk] = useState(false);
  return (
    <button title="copy" className="text-[var(--muted)] hover:text-[var(--text-2)]"
      onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); } catch {} }}>
      {ok ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}

function ToolBlock({ call, project }: { call: ToolCall; project: string }) {
  const [open, setOpen] = useState(false);
  const color = call.pendingApproval ? "var(--accent-warn, #d29922)" : call.ok === false ? "var(--accent-danger)" : "var(--accent-ai)";
  const pathArg = typeof call.args.path === "string" ? call.args.path : null;
  const previewable = pathArg && ["write_file", "edit_file", "read_file"].includes(call.name);
  return (
    <div className="ml-1 my-1 border-l-2 pl-3" style={{ borderColor: color }}>
      <span className="flex items-center gap-2">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2 text-xs min-w-0" style={{ color }}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Hammer size={12} />
          <span className="font-semibold">{call.agent ? call.agent + " · " : ""}{call.name}</span>
          <span className="text-[var(--muted)] font-normal truncate max-w-[380px]">{summarizeArgs(call.args)}</span>
        </button>
        {previewable && call.ok !== false && (
          <a href={fileHref(project, pathArg)} target="_blank" rel="noreferrer" title={"open " + pathArg}
            className="flex items-center gap-1 text-[10px] text-[var(--accent-ai)] shrink-0">
            <ExternalLink size={11} />open
          </a>
        )}
      </span>
      {open && (
        <pre className="mt-1 text-[11px] bg-[var(--surface-2,#11151c)] rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap">
          {JSON.stringify(call.args, null, 1)}
          {call.output !== undefined ? "\n──────────\n" + call.output : call.pendingApproval ? "\n(waiting for approval)" : "\n(running…)"}
        </pre>
      )}
    </div>
  );
}

export default function CodePage() {
  const navCollapsed = useNavCollapsed();
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");           // "" = default workspace
  const [instructionFiles, setInstructionFiles] = useState<string[]>([]);
  const [auto, setAuto] = useState(false);
  const [think, setThink] = useState(true);
  const [modes, setModes] = useState<{ id: string; label: string }[]>([{ id: "default", label: "default" }]);
  const [mode, setMode] = useState("default");
  const [minutes, setMinutes] = useState(10); // deliberate mode's time-budget slider
  const [settingsOpen, setSettingsOpen] = useState(false); // same LlmSettings panel /chat uses — temperature/num_ctx/etc, applies here too since serving reads the same saved options
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [approval, setApproval] = useState<{ id: string; name: string; args: Record<string, unknown> } | null>(null);
  const [convos, setConvos] = useState<Convo[]>([]);
  const [convoId, setConvoId] = useState("");
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [attached, setAttached] = useState<{ name: string; dataUrl: string }[]>([]);
  const [revealedIdx, setRevealedIdx] = useState<number | null>(null); // long-press reveal (touch)
  const [showJump, setShowJump] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [sideTab, setSideTab] = useState<"files" | "git" | "run">("files");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fsTick, setFsTick] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  // New UI state: live meter, truncation/continue, mobile menu, HUD visibility.
  const [usage, setUsage] = useState<Usage>(null);
  const [truncated, setTruncated] = useState(false);
  const [autoContinue, setAutoContinue] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);        // mobile: model/mode/project sheet
  const [hudOpen, setHudOpen] = useState(true);           // desktop: expanded telemetry strip
  const [servingModel, setServingModel] = useState<string | null>(null);
  const autoContinueCount = useRef(0);                    // cap auto-continues per user turn
  const truncatedRef = useRef(false);                     // live truncated flag seen this run
  useEffect(() => { try { setAutoContinue(localStorage.getItem("code_autocontinue") === "1"); } catch {} }, []);
  const changeAutoContinue = (v: boolean) => { setAutoContinue(v); try { localStorage.setItem("code_autocontinue", v ? "1" : "0"); } catch {} };
  const toggleTree = (v: boolean) => { setTreeOpen(v); try { localStorage.setItem("code_tree_open", v ? "1" : "0"); } catch {} };
  const workspaceRef = useRef(""); // openConvo can run before the workspace fetch lands in state
  const history = useRef<HistMsg[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);   // auto-follow only while the user is at the bottom
  const lpRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lpCancel = () => { if (lpRef.current) { clearTimeout(lpRef.current); lpRef.current = null; } };
  // Spread onto a message bubble: opacity-0 group-hover:opacity-100 never fires on
  // touch (no hover state) — a ~500ms finger-hold reveals the copy/edit actions
  // there instead. Same pattern as /chat.
  const longPress = (i: number) => ({
    onTouchStart: () => { lpCancel(); lpRef.current = setTimeout(() => setRevealedIdx(i), 500); },
    onTouchEnd: lpCancel,
    onTouchMove: lpCancel,
    onTouchCancel: lpCancel,
    onContextMenu: (e: React.MouseEvent) => { if (revealedIdx === i) e.preventDefault(); },
  });

  // describe_image is a workspace-file tool — the only way to show the agent an
  // image is to get it onto disk first. Without this, that meant leaving the app
  // to copy files into the workspace by hand.
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, 4);
    const read = await Promise.all(imgs.map((f) => new Promise<{ name: string; dataUrl: string }>((res) => {
      const r = new FileReader();
      r.onload = () => res({ name: f.name, dataUrl: String(r.result) });
      r.readAsDataURL(f);
    })));
    setAttached((a) => [...a, ...read].slice(0, 4));
  };

  const loadConvos = async () => {
    try {
      const r = await fetch("/api/agent/conversations?kind=code");
      if (r.ok) setConvos(await r.json());
    } catch { /* ignore */ }
  };

  const openConvo = async (id: string): Promise<RawMsg[] | null> => {
    setSessionsOpen(false);
    try {
      const r = await fetch(`/api/agent/conversations/${id}`);
      if (!r.ok) return null;
      const j = await r.json();
      const { blocks: b, history: h } = reconstructSession((j.messages ?? []) as RawMsg[]);
      // Restore the session's project folder BEFORE rendering, so the file tree /
      // git panel load against the right root. Older sessions have no project
      // field; a saved default-workspace path maps back to "" (the select's
      // "workspace" option); a folder deleted since the session ran falls back
      // to the workspace with an inline notice instead of a dead project.
      const savedProj = typeof j.project === "string" && j.project !== workspaceRef.current ? j.project : "";
      let projWarning = "";
      if (savedProj) {
        const ok = await fetch("/api/agent/fs?" + new URLSearchParams({ op: "list", path: ".", project: savedProj }))
          .then((r2) => r2.ok).catch(() => false);
        if (ok) setProjects((prev) => (prev.includes(savedProj) ? prev : [savedProj, ...prev]));
        else projWarning = "this session's project folder is missing (" + savedProj + ") — using the default workspace";
      }
      setProject(savedProj && !projWarning ? savedProj : "");
      setOpenFile(null);
      history.current = h;
      setBlocks(projWarning ? [...b, { t: "error", text: projWarning }] : b);
      setConvoId(id);
      setInstructionFiles([]);
      return (j.messages ?? []) as RawMsg[];
    } catch { return null; }
  };

  const newSession = () => {
    setSessionsOpen(false);
    history.current = [];
    setBlocks([]);
    setConvoId("");
    setInstructionFiles([]);
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" }).catch(() => {});
    setConvos((prev) => prev.filter((c) => c.id !== id));
    if (id === convoId) newSession();
  };

  // A run lives server-side in the run manager, welded to nothing — this client
  // (or any other tab/device) just ATTACHES to its SSE event stream and renders.
  // Closing the tab changes nothing about the run; reopening reattaches and
  // replays. Run status ("running"/"done"/"error"/"stopped"/"interrupted") comes
  // from the server — the old transcript-shape guessing (and its permanently
  // stuck busy spinner) is gone.
  const convoIdRef = useRef("");
  useEffect(() => { convoIdRef.current = convoId; }, [convoId]);
  const esRef = useRef<EventSource | null>(null);
  const runIdRef = useRef("");
  useEffect(() => () => { esRef.current?.close(); }, []); // unmount: detach (run unaffected)

  // Rebuild history (with full tool_calls/tool messages) from the saved transcript
  // once a run settles — carrying forward only the streamed text once meant the
  // model had NO memory of tool calls it already made (it would re-describe images,
  // re-write files). The server persists the real transcript; build on that.
  const adoptSavedTranscript = async () => {
    const id = convoIdRef.current;
    if (!id) return;
    try {
      const r = await fetch(`/api/agent/conversations/${id}`);
      if (!r.ok) return;
      const j = await r.json();
      const { history: h } = reconstructSession((j.messages ?? []) as RawMsg[]);
      history.current = h;
    } catch { /* keep whatever local history we had */ }
  };

  // Attach to a run's event stream. `savedMsgs` non-null = reattach mode: on the
  // run's turn-boundary event, the view is rebuilt as reconstruct(saved[..base]) +
  // replay(all run events) — byte-equivalent to having watched live from the start.
  const attachRun = (runId: string, savedMsgs: RawMsg[] | null) => {
    esRef.current?.close();
    runIdRef.current = runId;
    truncatedRef.current = false;
    setTruncated(false);
    const es = new EventSource(`/api/agent/runs/${runId}/stream`);
    esRef.current = es;
    const finish = async (status: string, errText?: string) => {
      es.close();
      if (esRef.current === es) { esRef.current = null; runIdRef.current = ""; }
      if (status === "error") setBlocks((prev) => [...prev, { t: "error", text: "run failed: " + (errText || "unknown error") }]);
      else if (status === "interrupted") setBlocks((prev) => [...prev, { t: "error", text: errText || "the app restarted while this run was in progress" }]);
      else if (status === "stopped") setBlocks((prev) => [...prev, { t: "status", text: "── stopped ──" }]);
      setApproval(null);
      await adoptSavedTranscript();
      setBusy(false);
      loadConvos();
      // A reply cut off by the token cap: auto-resume if enabled (bounded), else
      // surface the Continue affordance. Only for a clean finish, never after an
      // error/stop/interrupt (those aren't "the model ran out of room mid-thought").
      if (status === "done" && truncatedRef.current) {
        if (autoContinue && autoContinueCount.current < 4) { autoContinueCount.current++; continueRun(); }
        else setTruncated(true);
      }
    };
    es.onmessage = (ev) => {
      // The wire carries the Ev union PLUS run-manager envelope kinds
      // (run/turn/status/approval_result/usage/truncated) — parse loosely, narrow per kind.
      let raw: { k: string; v?: unknown; error?: string };
      try { raw = JSON.parse(ev.data); } catch { return; }
      if (raw.k === "run") {
        // Meta preamble — carries the persisted truncated flag for a run that
        // finished while we were detached (cross-device Continue).
        if ((raw.v as { truncated?: boolean } | undefined)?.truncated) truncatedRef.current = true;
        return;
      }
      if (raw.k === "usage") { setUsage(raw.v as Usage); return; }
      if (raw.k === "truncated") { truncatedRef.current = true; return; }
      if (raw.k === "turn") {
        if (savedMsgs) {
          const base = (raw.v as { base?: number } | undefined)?.base ?? 0;
          const nonSystem = savedMsgs.filter((m) => m.role !== "system");
          const { blocks: b, history: h } = reconstructSession(nonSystem.slice(0, base));
          history.current = h;
          setBlocks(b);
        }
        return;
      }
      if (raw.k === "status") {
        const v = String(raw.v);
        if (["done", "error", "stopped", "interrupted"].includes(v)) finish(v, raw.error);
        return;
      }
      if (raw.k === "approval_needed") {
        const call = raw.v as { id: string; name: string; args: Record<string, unknown> };
        setBlocks((prev) => {
          const next = prev.slice();
          for (let j = next.length - 1; j >= 0; j--) {
            const b = next[j];
            if (b.t === "tool" && b.call.id === call.id) { next[j] = { t: "tool", call: { ...b.call, pendingApproval: true } }; break; }
          }
          return next;
        });
        setApproval(call);
        return;
      }
      if (raw.k === "approval_result") {
        const v = raw.v as { id: string };
        setBlocks((prev) => prev.map((b) => (b.t === "tool" && b.call.id === v.id ? { ...b, call: { ...b.call, pendingApproval: false } } : b)));
        setApproval((a) => (a && a.id === v.id ? null : a));
        return;
      }
      const e = raw as unknown as Ev;
      setBlocks((prev) => { const next = prev.slice(); applyEvent(next, e); return next; });
      if (e.k === "tool_result" && ["write_file", "edit_file", "run_shell", "run_python", "git"].includes(e.v.name)) setFsTick((t) => t + 1);
      if (e.k === "project") setInstructionFiles(e.v.instructionFiles || []);
      if (e.k === "done" && e.v.conversationId) { setConvoId(e.v.conversationId); convoIdRef.current = e.v.conversationId; }
    };
    // EventSource reconnects on its own (resuming via Last-Event-ID). If the run
    // ended while we were away, the server replays the terminal status and we
    // settle through finish() above — no polling, no guessing.
  };

  // Coming back to the tab/network with nothing attached: ask the server the one
  // truthful question — is a run live for this conversation? — and reattach if so.
  useEffect(() => {
    const resync = async () => {
      if (document.visibilityState !== "visible" || esRef.current) return;
      const id = convoIdRef.current;
      if (!id) return;
      try {
        const runs: { id: string; status: string; conversationId: string }[] = await fetch("/api/agent/runs?limit=20").then((r) => r.json());
        const r = runs.find((x) => x.status === "running" && x.conversationId === id);
        if (!r) return;
        const c = await fetch(`/api/agent/conversations/${id}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        setBusy(true);
        attachRun(r.id, (c?.messages ?? []) as RawMsg[]);
      } catch { /* offline — next visibility change retries */ }
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("focus", resync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch("/api/agent/models").then((r) => r.json()).then((j) => { setModels(j.models || []); setModel(j.current || j.models?.[0] || ""); });
    try { setTreeOpen(localStorage.getItem("code_tree_open") === "1"); } catch {}
    // Resume the most recent session, same UX as /chat — without this, opening
    // /code always looked blank even though every session was saved server-side.
    // The workspace fetch must land first: openConvo needs it to map a saved
    // default-workspace path back to the select's "" option.
    const qs = new URLSearchParams(window.location.search);
    const deepLinkProject = qs.get("project");
    fetch("/api/agent/loop").then((r) => r.json()).then((j) => {
      workspaceRef.current = j.workspace || "";
      setWorkspace(j.workspace || ""); setProjects(j.projects || []);
      // "deliberate" isn't one of /api/agent/loop's MODES — it's a client-side-only
      // entry pointing at the separate /api/agent/deliberate endpoint (see
      // lib/deliberate.ts), since it's a multi-phase, time-boxed orchestration with
      // its own artifacts, not another single tool-loop preset.
      if (j.modes?.length) setModes([...j.modes, { id: "deliberate", label: "deliberate (research)" }]);
      // Deep-link from Library ("open in /code" on a project): jump straight to
      // that folder with a fresh session, same as picking it from the dropdown.
      if (deepLinkProject) setProject(deepLinkProject);
    }).catch(() => {})
      .then(() => { loadConvos(); return fetch("/api/agent/conversations?kind=code"); })
      .then((r) => (r.ok ? r.json() : []))
      .then(async (list: Convo[]) => {
        if (deepLinkProject) { window.history.replaceState(null, "", "/code"); return; }
        // Deep-link from Library ("open in /code" on a chat): ?conv=<id> opens that
        // specific session instead of whichever is most recent.
        const deepLinkId = qs.get("conv");
        const targetId = deepLinkId || list?.[0]?.id;
        if (!targetId) return;
        const msgs = await openConvo(targetId);
        if (deepLinkId) window.history.replaceState(null, "", "/code");
        // A fully closed-and-reopened tab is a fresh mount with no memory that a
        // task might still be running — so ask the run manager instead of guessing
        // from the transcript's shape. A live run for this conversation gets
        // reattached (replay + tail); anything else is genuinely not running.
        try {
          const runs: { id: string; status: string; conversationId: string }[] = await fetch("/api/agent/runs?limit=20").then((r) => r.json());
          const live = runs.find((x) => x.status === "running" && x.conversationId === targetId);
          if (live) { setBusy(true); attachRun(live.id, msgs ?? []); }
        } catch { /* server unreachable — visibility resync will retry */ }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // "scroll" fires for BOTH the user's own gesture and our own scrollIntoView()
    // below — during a fast stream (many tokens/sec) that's a fight the user always
    // loses: they scroll up, the very next token's auto-scroll snaps back to the
    // bottom before the browser even reports the position change, re-affirming
    // "near bottom" on the next scroll event. wheel/touchmove only ever fire for a
    // real user gesture, so they unstick immediately and unconditionally; only the
    // passive scroll check re-sticks (once the user's back at the bottom themselves).
    const unstick = () => { stickRef.current = false; setShowJump(true); };
    const onScroll = () => {
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
      stickRef.current = atBottom;
      setShowJump(!atBottom);
      if (revealedIdx !== null) setRevealedIdx(null); // scrolling dismisses a long-press reveal
    };
    window.addEventListener("wheel", unstick, { passive: true });
    window.addEventListener("touchmove", unstick, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", unstick);
      window.removeEventListener("touchmove", unstick);
      window.removeEventListener("scroll", onScroll);
    };
  }, [revealedIdx]);
  useEffect(() => { if (stickRef.current) bottomRef.current?.scrollIntoView(); }, [blocks]);
  const jumpToBottom = () => { stickRef.current = true; setShowJump(false); bottomRef.current?.scrollIntoView(); };

  // rewind the conversation to just before a user message and load it for editing
  const editUser = (blockIndex: number) => {
    if (busy) return;
    const b = blocks[blockIndex];
    if (b?.t !== "user") return;
    history.current = history.current.slice(0, b.hIdx);
    setBlocks(blocks.slice(0, blockIndex));
    setInput(b.text);
  };

  const decide = async (id: string, allow: boolean) => {
    setApproval(null);
    setBlocks((prev) => prev.map((b) => (b.t === "tool" && b.call.id === id ? { ...b, call: { ...b.call, pendingApproval: false } } : b)));
    await fetch("/api/agent/loop", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, allow }) }).catch(() => {});
  };

  // Deliberate mode's query is one-shot, not a multi-turn chat: it doesn't append
  // to `history.current` for a follow-up message the way the normal loop does,
  // since a deliberation isn't something you continue with "and also...".
  const sendDeliberate = async () => {
    const query = input.trim();
    if (!query || busy) return;
    setInput("");
    setBusy(true);
    stickRef.current = true;
    setShowJump(false);
    setBlocks((prev) => [...prev, { t: "user", text: query, hIdx: -1 }]);
    try {
      const res = await fetch("/api/agent/deliberate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, minutes, model, autoApprove: auto, project: project || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      if (j.conversationId) { setConvoId(j.conversationId); convoIdRef.current = j.conversationId; }
      attachRun(j.runId, null); // busy clears when the run's terminal status arrives
    } catch (err) {
      setBlocks((prev) => [...prev, { t: "error", text: (err as Error).message }]);
      setBusy(false);
    }
  };

  const send = async () => {
    if (mode === "deliberate") return sendDeliberate();
    const text = input.trim() || "Take a look at the attached image.";
    if ((!input.trim() && !attached.length) || busy) return;
    const pending = attached;
    setInput("");
    setAttached([]);
    setBusy(true);
    setTruncated(false);
    autoContinueCount.current = 0; // a fresh user turn resets the auto-continue budget
    stickRef.current = true;
    setShowJump(false);

    // Land attachments in the project directory BEFORE the agent sees the
    // message, so its first describe_image call can find them immediately.
    const paths: string[] = [];
    for (const f of pending) {
      try {
        const r = await fetch("/api/agent/upload", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: project || undefined, filename: f.name, dataUrl: f.dataUrl }),
        });
        const j = await r.json();
        if (j.path) paths.push(j.path);
      } catch { /* ignore — the model just won't have this one */ }
    }
    const withAttachments = paths.length
      ? text + "\n\n[attached image" + (paths.length > 1 ? "s" : "") + ": " + paths.join(", ") + "]"
      : text;

    const hIdx = history.current.length;
    history.current.push({ role: "user", content: withAttachments });
    setBlocks((prev) => [...prev, { t: "user", text: withAttachments, hIdx }]);

    try {
      // POST returns {runId, conversationId} immediately — the loop runs detached
      // in the server's run manager. Rendering (and history rebuild on settle)
      // happens through the attached SSE stream, same path as a reattach.
      const res = await fetch("/api/agent/loop", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.current, model, autoApprove: auto, think, mode, project: project || undefined, conversationId: convoId || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      if (j.conversationId) { setConvoId(j.conversationId); convoIdRef.current = j.conversationId; loadConvos(); }
      attachRun(j.runId, null); // busy clears when the run's terminal status arrives
    } catch (err) {
      setBlocks((prev) => [...prev, { t: "error", text: (err as Error).message }]);
      setBusy(false);
    }
  };

  // Stop is a real server-side operation now: it aborts the run's controller,
  // which cancels the model decode and unwinds the tool loop. The local escape
  // hatch remains for the no-run-attached case — the user should never be unable
  // to escape a spinner from this button.
  const stop = () => {
    const id = runIdRef.current;
    if (id) fetch(`/api/agent/runs/${id}/stop`, { method: "POST" }).catch(() => {});
    else { esRef.current?.close(); esRef.current = null; setBusy(false); }
  };

  // Resume a reply the model cut off at the token limit. It's just another loop
  // turn against the SAME conversation — the saved transcript already ends with the
  // truncated assistant text, so the model continues from there. Works whether the
  // truncation happened on this device or another (the run meta persists the flag).
  const continueRun = async () => {
    if (busy) return;
    setTruncated(false);
    setBusy(true);
    stickRef.current = true;
    const nudge = "Continue exactly where you left off — your previous reply was cut off by the token limit. Do not repeat what you already wrote; pick up mid-sentence if needed.";
    history.current.push({ role: "user", content: nudge });
    // No visible user bubble for a continue — it reads as one flowing reply.
    try {
      const res = await fetch("/api/agent/loop", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.current, model, autoApprove: auto, think, mode, project: project || undefined, conversationId: convoId || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      if (j.conversationId) { setConvoId(j.conversationId); convoIdRef.current = j.conversationId; }
      attachRun(j.runId, null);
    } catch (err) {
      setBlocks((prev) => [...prev, { t: "error", text: (err as Error).message }]);
      setBusy(false);
    }
  };

  const inp = "bg-[var(--surface-2)] border border-[var(--border-soft)] rounded-lg px-2.5 py-1.5 text-xs text-[var(--text-2)] outline-none focus:border-[var(--border-loud)] max-w-[46vw] sm:max-w-none";
  const iconBtn = "flex items-center justify-center h-8 w-8 rounded-lg border border-[var(--border-soft)] text-[var(--text-2)] hover:border-[var(--border)] hover:text-[var(--text)] transition-colors";
  const modeLabel = modes.find((m) => m.id === mode)?.label ?? mode;
  // Panels reflow the chat via PADDING on this outer wrapper only — the chat column
  // must never gain a nested scroll container (the stick/jump logic is built on
  // window scrolling; see the scroll-effect comment above).
  return (
    <div className={(treeOpen ? "xl:pl-64 " : "") + (openFile ? "lg:pr-[min(52vw,760px)]" : "")}>
    <div className="max-w-4xl mx-auto px-3 sm:px-4 pb-40 flex flex-col min-h-dvh">
      {/* ── Sticky command bar + telemetry ───────────────────────────────── */}
      <div className="sticky top-0 z-30 -mx-3 sm:-mx-4 px-3 sm:px-4 bg-[var(--bg)]/92 backdrop-blur-md border-b border-[var(--border-soft)]">
        <header className="flex items-center gap-2 h-14">
          {/* Mobile: menu opens the full control sheet */}
          <button onClick={() => setMenuOpen(true)} className={iconBtn + " sm:hidden"} title="controls"><Menu size={16} /></button>
          <span className="hidden sm:flex text-[var(--accent-ai)] font-bold tracking-widest text-xs items-center gap-2 shrink-0"><Bot size={17} /> AGENT</span>

          {/* Desktop inline controls */}
          <div className="hidden sm:flex items-center gap-1.5 flex-1 min-w-0">
            <select value={model} onChange={(e) => setModel(e.target.value)} className={inp} title="model">
              {model && !models.includes(model) && <option value={model}>{model}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className={inp} title="workflow mode">
              {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            {mode === "deliberate" && (
              <span className="flex items-center gap-1.5 text-xs bg-[var(--surface-2)] border border-[var(--border-soft)] rounded-lg px-2.5 py-1" title="deliberation time budget">
                <input type="range" min={2} max={60} step={1} value={minutes} onChange={(e) => setMinutes(parseInt(e.target.value, 10))} className="w-20 accent-[var(--accent-ai)]" />
                <span className="text-[var(--text-2)] tabular-nums w-12">{minutes}m</span>
              </span>
            )}
            <select value={project} onChange={(e) => { setProject(e.target.value); setOpenFile(null); newSession(); }}
              className={inp + " max-w-[180px]"} title="project (switching starts a fresh session)">
              <option value="">{workspace ? "workspace" : "workspace"}</option>
              {projects.filter((p) => p !== workspace).map((p) => <option key={p} value={p}>{p.split("/").slice(-2).join("/")}</option>)}
            </select>
            <button onClick={() => setPickerOpen(true)} className={iconBtn} title="open another project"><FolderGit2 size={15} /></button>
          </div>

          {/* Right cluster (both layouts) */}
          <div className="flex items-center gap-1.5 ml-auto shrink-0">
            <button onClick={() => setThink(!think)} title={think ? "thinking on" : "thinking off"}
              className={iconBtn} style={{ borderColor: think ? "var(--accent-ai)" : undefined, color: think ? "var(--accent-ai)" : undefined }}><Brain size={15} /></button>
            <button onClick={() => setAuto(!auto)} title={auto ? "tools auto-approved" : "tools ask first"}
              className={iconBtn} style={{ borderColor: auto ? "var(--accent-warn)" : undefined, color: auto ? "var(--accent-warn)" : undefined }}>{auto ? <Zap size={15} /> : <ShieldCheck size={15} />}</button>
            <button onClick={() => toggleTree(!treeOpen)} title="files · git · run" className={iconBtn}
              style={{ borderColor: treeOpen ? "var(--accent-ai)" : undefined, color: treeOpen ? "var(--accent-ai)" : undefined }}><PanelLeft size={15} /></button>
            <div className="relative">
              <button onClick={() => setSessionsOpen((o) => !o)} title="past sessions" className={iconBtn}><ChevronDown size={15} /></button>
              {sessionsOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setSessionsOpen(false)} />
                  <div className="absolute right-0 top-full mt-1.5 z-30 w-72 max-h-[60vh] overflow-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-2xl p-1">
                    {convos.length === 0 && <div className="text-xs text-[var(--muted)] px-3 py-2">no past sessions</div>}
                    {convos.map((c) => (
                      <button key={c.id} onClick={() => openConvo(c.id)}
                        className={"w-full flex items-center gap-2 text-xs px-3 py-2 rounded-lg hover:bg-[var(--surface-2)] text-left " + (c.id === convoId ? "bg-[var(--surface-2)]" : "")}>
                        <span className="flex-1 truncate">{c.title}</span>
                        {c.project && c.project !== workspace && (
                          <span className="text-[10px] text-[var(--muted)] font-mono max-w-[80px] truncate shrink-0" title={c.project}>{c.project.split("/").pop()}</span>
                        )}
                        <button onClick={(e) => deleteSession(c.id, e)} className="text-[var(--muted)] hover:text-[var(--accent-danger)] shrink-0"><Trash2 size={12} /></button>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button onClick={newSession} title="new session" className={iconBtn + " text-[var(--accent-ai)]"}><MessageSquarePlus size={15} /></button>
            <button onClick={() => setSettingsOpen(true)} title="settings" className={iconBtn}><Settings size={15} /></button>
          </div>
        </header>

        {/* Telemetry: full strip on desktop, tap-to-expand glance on mobile */}
        <div className="pb-2">
          <div className="hidden sm:block"><StatsHud usage={usage} active={busy} onServingChange={setServingModel} /></div>
          <button onClick={() => setHudOpen((o) => !o)} className="sm:hidden flex items-center gap-2 w-full">
            <StatsGlance usage={usage} />
            <ChevronDown size={12} className={"ml-auto text-[var(--muted)] transition-transform " + (hudOpen ? "rotate-180" : "")} />
          </button>
          {hudOpen && <div className="sm:hidden pt-2"><StatsHud usage={usage} active={busy} onServingChange={setServingModel} /></div>}
        </div>
      </div>

      <div className="flex-1 space-y-3 pt-4">
        {instructionFiles.length > 0 && (
          <div className="flex items-center gap-2 text-[10px] text-[var(--accent-ai)]">
            <Sparkles size={11} />
            <span title="loaded into the agent's system prompt">project instructions: {instructionFiles.join(" + ")}</span>
          </div>
        )}
        {blocks.length === 0 && (
          <div className="mt-6 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-[var(--surface-2)] border border-[var(--border-soft)] mb-4"><Bot size={22} className="text-[var(--accent-ai)]" /></div>
            <p className="text-sm text-[var(--text-2)] max-w-md mx-auto leading-relaxed">
              An agent with real tools over <span className="font-mono text-[var(--text)]">{project ? project.split("/").pop() : (workspace ? "workspace" : "the workspace")}</span>:
              files, shell, a Python REPL, web research, image understanding, and helper sub-agents.
            </p>
            <p className="text-xs text-[var(--muted)] mt-2">Ask it to build, fix, research — or train a model.</p>
          </div>
        )}
        {blocks.map((b, i) => {
          if (b.t === "user") return (
            <div key={i} {...longPress(i)} className="group bg-[var(--surface-1)] border border-[var(--border)] rounded-lg px-4 py-2.5 text-sm">
              <div className="flex items-start gap-2">
                <span className="flex-1 whitespace-pre-wrap">{b.text}</span>
                <span className={"flex gap-2 transition-opacity shrink-0 pt-0.5 " + (revealedIdx === i ? "opacity-100" : "opacity-0 pointer-events-none [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-hover:pointer-events-auto")}>
                  <CopyBtn text={b.text} size={13} />
                  <button title="edit & rewind here" disabled={busy} onClick={() => { setRevealedIdx(null); editUser(i); }}
                    className="text-[var(--muted)] hover:text-[var(--text-2)] disabled:opacity-30"><Pencil size={13} /></button>
                </span>
              </div>
            </div>
          );
          if (b.t === "tool") return <ToolBlock key={i} call={b.call} project={project} />;
          if (b.t === "error") return <div key={i} className="text-xs text-[var(--accent-danger)] border border-[var(--accent-danger)]/40 rounded px-3 py-2">{b.text}</div>;
          if (b.t === "status") return <div key={i} className="text-[11px] uppercase tracking-widest text-[var(--accent-ai)] px-1">{b.text}</div>;
          return (
            <div key={i} {...longPress(i)} className="group text-sm leading-relaxed">
              <div className="flex items-center gap-2">
                {b.agent && <span className="text-[10px] uppercase tracking-widest text-[var(--muted)]">{b.agent}</span>}
                <span className={"ml-auto transition-opacity " + (revealedIdx === i ? "opacity-100" : "opacity-0 pointer-events-none [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-hover:pointer-events-auto")}>{b.text && <CopyBtn text={b.text} size={13} />}</span>
              </div>
              {b.think && <details className="text-xs text-[var(--muted)] mb-1"><summary className="cursor-pointer">thinking…</summary><div className="whitespace-pre-wrap border-l border-[var(--border-soft)] pl-3 mt-1">{b.think}</div></details>}
              <MarkdownView text={b.text} />
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {showJump && (
        // The editor pane is a full-screen takeover below lg (openFile w-full) — this
        // floating pill would otherwise render above it (z-40 > editor's z-30)
        // regardless of DOM order, visually leaking into an unrelated full-screen view.
        <button onClick={jumpToBottom} title="jump to latest"
          className={(openFile ? "hidden lg:flex " : "flex ") + "fixed bottom-32 left-1/2 -translate-x-1/2 z-40 items-center gap-1.5 text-xs bg-[var(--surface-1)] border border-[var(--border)] rounded-full shadow-lg px-3 py-1.5 text-[var(--text-2)]"}>
          <ArrowDown size={13} /> jump to latest
        </button>
      )}

      {approval && (
        <div className="fixed bottom-24 md:bottom-24 left-1/2 -translate-x-1/2 z-40 bg-[var(--surface-1)] border border-[var(--accent-warn)] rounded-xl shadow-2xl px-4 py-3 max-w-[92vw] w-[560px] animate-fade-in">
          <div className="flex items-center gap-2 text-xs font-semibold mb-1.5"><ShieldCheck size={14} className="text-[var(--accent-warn)]" /> approve <span className="font-mono text-[var(--accent-warn)]">{approval.name}</span>?</div>
          {/* Full args, not a truncated summary — a 90-char preview once hid the
              back half of a run_shell command behind the one place blind trust
              is most dangerous: what you're about to let it execute. */}
          <pre className="text-[11px] font-mono bg-[var(--surface-2)] border border-[var(--border-soft)] rounded-lg p-2 max-h-56 overflow-auto whitespace-pre-wrap mb-2">
            {approval.name === "run_shell" ? String(approval.args.command ?? "")
              : approval.name === "git" ? "git " + [approval.args.command, ...(Array.isArray(approval.args.args) ? approval.args.args : [])].join(" ")
              : JSON.stringify(approval.args, null, 1)}
          </pre>
          <div className="flex justify-end gap-2">
            <button onClick={() => decide(approval.id, false)} className="text-xs border border-[var(--border)] rounded-lg px-3 py-1.5">Deny</button>
            <button onClick={() => decide(approval.id, true)} className="text-xs font-semibold bg-[var(--accent-ai)] text-[#05090c] rounded-lg px-3 py-1.5">Approve</button>
          </div>
        </div>
      )}

      <div className={"fixed bottom-14 md:bottom-0 left-0 right-0 bg-[var(--bg)]/95 backdrop-blur-md border-t border-[var(--border)] px-3 pt-2.5 pb-[calc(env(safe-area-inset-bottom)+0.625rem)]"
        + (navCollapsed ? "" : " md:left-14 lg:left-44")
        + (openFile ? " lg:right-[min(52vw,760px)]" : "") + (treeOpen ? (navCollapsed ? " xl:left-64" : " xl:left-[27rem]") : "")}>
        <div className="max-w-4xl mx-auto">
          {/* Continue affordance: the last reply hit the token ceiling mid-thought. */}
          {truncated && !busy && (
            <button onClick={continueRun}
              className="flex items-center gap-2 text-xs mb-2 px-3 py-1.5 rounded-lg border border-[var(--accent-warn)] text-[var(--accent-warn)] hover:bg-[var(--accent-warn)]/10 transition-colors animate-fade-in">
              <ArrowRight size={13} /> reply was cut off — continue
            </button>
          )}
          {attached.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap">
              {attached.map((f, i) => (
                <span key={i} className="flex items-center gap-1.5 text-[11px] bg-[var(--surface-2)] border border-[var(--border-soft)] rounded-lg px-2 py-1">
                  {f.name}
                  <button onClick={() => setAttached((a) => a.filter((_, j) => j !== i))} className="text-[var(--muted)] hover:text-[var(--accent-danger)]"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 bg-[var(--surface-1)] border border-[var(--border)] focus-within:border-[var(--border-loud)] rounded-2xl px-2 py-1.5 transition-colors">
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} title="attach image (for describe_image)"
              className="h-9 w-9 flex items-center justify-center rounded-lg text-[var(--muted)] hover:text-[var(--text-2)] shrink-0"><Paperclip size={16} /></button>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              onPaste={(e) => { const files = e.clipboardData?.files; if (files?.length) addFiles(files); }}
              placeholder={mode === "deliberate" ? "What question should the deliberation settle?" : "Build, fix, research…"}
              className="flex-1 resize-none bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--muted)] outline-none py-1.5 max-h-40 min-h-[2.25rem]"
              style={{ height: "auto" }}
              onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }} />
            {busy
              ? <button onClick={stop} className="h-9 px-3.5 rounded-xl bg-[var(--accent-danger)] text-[#05090c] flex items-center gap-1.5 text-sm font-semibold shrink-0"><CircleStop size={15} /> Stop</button>
              : <button onClick={send} disabled={!input.trim() && !attached.length} className="h-9 px-3.5 rounded-xl bg-[var(--accent-ai)] text-[#05090c] flex items-center gap-1.5 text-sm font-semibold disabled:opacity-40 shrink-0"><Send size={15} /></button>}
          </div>
          <div className="flex items-center justify-between mt-1.5 px-1 text-[10px] text-[var(--muted)]">
            <span className="truncate">{servingModel ? <span className="text-[var(--text-3)]">{servingModel}</span> : model} · {modeLabel}{autoContinue ? " · auto-continue" : ""}</span>
            <span className="tabular-nums shrink-0"><StatsGlance usage={usage} /></span>
          </div>
        </div>
      </div>
    </div>

    {/* Mobile control sheet: model / mode / project / toggles */}
    {menuOpen && (
      <div className="fixed inset-0 z-[55] sm:hidden flex items-end bg-black/50 animate-fade-in" onClick={() => setMenuOpen(false)}>
        <div onClick={(e) => e.stopPropagation()} className="w-full bg-[var(--surface-1)] border-t border-[var(--border)] rounded-t-2xl p-4 space-y-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <div className="flex items-center justify-between"><span className="text-sm font-semibold">Controls</span><button onClick={() => setMenuOpen(false)} className="text-[var(--muted)] p-1"><X size={18} /></button></div>
          <label className="block text-[11px] text-[var(--muted)]">Model
            <select value={model} onChange={(e) => setModel(e.target.value)} className={inp + " w-full mt-1 max-w-none"}>
              {model && !models.includes(model) && <option value={model}>{model}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="block text-[11px] text-[var(--muted)]">Mode
            <select value={mode} onChange={(e) => setMode(e.target.value)} className={inp + " w-full mt-1 max-w-none"}>
              {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          {mode === "deliberate" && (
            <label className="block text-[11px] text-[var(--muted)]">Time budget: {minutes}m
              <input type="range" min={2} max={60} step={1} value={minutes} onChange={(e) => setMinutes(parseInt(e.target.value, 10))} className="w-full accent-[var(--accent-ai)] mt-1" />
            </label>
          )}
          <label className="block text-[11px] text-[var(--muted)]">Project
            <select value={project} onChange={(e) => { setProject(e.target.value); setOpenFile(null); newSession(); }} className={inp + " w-full mt-1 max-w-none"}>
              <option value="">workspace</option>
              {projects.filter((p) => p !== workspace).map((p) => <option key={p} value={p}>{p.split("/").slice(-2).join("/")}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2 pt-1">
            <button onClick={() => setThink(!think)} className="flex items-center gap-1.5 text-xs border rounded-lg px-3 py-2" style={{ borderColor: think ? "var(--accent-ai)" : "var(--border-soft)", color: think ? "var(--accent-ai)" : "var(--text-2)" }}><Brain size={14} />{think ? "think" : "no-think"}</button>
            <button onClick={() => setAuto(!auto)} className="flex items-center gap-1.5 text-xs border rounded-lg px-3 py-2" style={{ borderColor: auto ? "var(--accent-warn)" : "var(--border-soft)", color: auto ? "var(--accent-warn)" : "var(--text-2)" }}>{auto ? <Zap size={14} /> : <ShieldCheck size={14} />}{auto ? "auto" : "ask"}</button>
            <button onClick={() => { setPickerOpen(true); setMenuOpen(false); }} className="flex items-center gap-1.5 text-xs border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[var(--text-2)]"><FolderGit2 size={14} /> open</button>
            <button onClick={() => { toggleTree(!treeOpen); setMenuOpen(false); }} className="flex items-center gap-1.5 text-xs border border-[var(--border-soft)] rounded-lg px-3 py-2 text-[var(--text-2)]"><PanelLeft size={14} /> panels</button>
          </div>
        </div>
      </div>
    )}

    {treeOpen && (
      <>
        {/* below xl the sidebar overlays the chat — backdrop click dismisses */}
        <div className="fixed inset-0 z-10 bg-black/40 xl:hidden" onClick={() => toggleTree(false)} />
        <aside className={"fixed top-0 bottom-14 md:bottom-0 left-0 w-64 z-20 border-r border-[var(--border)] bg-[var(--bg)] flex flex-col"
          + (navCollapsed ? "" : " md:left-14 lg:left-44")}>
          <div className="flex items-center gap-1 px-2 pt-2 pb-1 border-b border-[var(--border-soft)] shrink-0">
            {(["files", "git", "run"] as const).map((t) => (
              <button key={t} onClick={() => setSideTab(t)}
                className={"text-[11px] rounded px-2 py-1 " + (sideTab === t ? "text-[var(--accent-ai)] bg-[var(--surface-2,#11151c)]" : "text-[var(--muted)]")}>
                {t}
              </button>
            ))}
            <button onClick={() => toggleTree(false)} className="ml-auto text-[var(--muted)] hover:text-[var(--text-2)]"><X size={13} /></button>
          </div>
          <div className="flex-1 overflow-auto">
            {sideTab === "files"
              ? <FileTree project={project} refreshTick={fsTick} onOpenFile={(rel) => setOpenFile(rel)} selected={openFile} />
              : sideTab === "git"
              ? <GitPanel project={project} refreshTick={fsTick} onCommitted={() => setFsTick((t) => t + 1)} />
              : <RunPanel project={project} />}
          </div>
        </aside>
      </>
    )}

    {openFile && (
      <aside className="fixed top-0 bottom-14 md:bottom-0 right-0 z-30 w-full lg:w-[min(52vw,760px)] border-l border-[var(--border)] bg-[var(--bg)]">
        <EditorPane project={project} filePath={openFile} refreshTick={fsTick} rawHref={fileHref(project, openFile)}
          onClose={() => setOpenFile(null)} onSaved={() => setFsTick((t) => t + 1)} />
      </aside>
    )}

    <DirPicker open={pickerOpen} recents={projects} onClose={() => setPickerOpen(false)}
      onPick={(p) => { setPickerOpen(false); setProjects((prev) => [p, ...prev.filter((x) => x !== p)]); setProject(p); setOpenFile(null); newSession(); }} />
    <AgentSettings open={settingsOpen} onClose={() => setSettingsOpen(false)}
      model={model} models={models} onModelChange={setModel}
      think={think} onThinkChange={setThink}
      auto={auto} onAutoChange={setAuto}
      autoContinue={autoContinue} onAutoContinueChange={changeAutoContinue} />
    </div>
  );
}
