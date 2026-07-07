"use client";
// Mini claude code: agentic coding chat over the workspace, with live tool activity,
// sub-agent traces, approval gating, and vision via the Gemma backend.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, Bot, Brain, Check, ChevronDown, ChevronRight, CircleStop, Copy, ExternalLink, Hammer, MessageSquarePlus, PanelLeft, Paperclip, Pencil, Send, ShieldCheck, Trash2, X, Zap } from "lucide-react";
import MarkdownView from "@/components/markdown-view";
import DirPicker from "@/components/code/dir-picker";
import FileTree from "@/components/code/file-tree";
import EditorPane from "@/components/code/editor-pane";
import GitPanel from "@/components/code/git-panel";
import RunPanel from "@/components/code/run-panel";
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
  | { k: "done"; v: { conversationId: string } }
  | { k: "error"; v: string };

type ToolCall = { id: string; name: string; args: Record<string, unknown>; agent?: string; ok?: boolean; output?: string; pendingApproval?: boolean };
type Block =
  | { t: "user"; text: string; hIdx: number }
  | { t: "assistant"; text: string; think: string; agent?: string }
  | { t: "tool"; call: ToolCall }
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
  const toggleTree = (v: boolean) => { setTreeOpen(v); try { localStorage.setItem("code_tree_open", v ? "1" : "0"); } catch {} };
  const workspaceRef = useRef(""); // openConvo can run before the workspace fetch lands in state
  const history = useRef<HistMsg[]>([]);
  const abortRef = useRef<AbortController | null>(null);
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

  const openConvo = async (id: string) => {
    setSessionsOpen(false);
    try {
      const r = await fetch(`/api/agent/conversations/${id}`);
      if (!r.ok) return;
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
    } catch { /* ignore */ }
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

  // The tool loop runs to completion server-side regardless of the client
  // connection (verified: killing the client mid-tool-call still let an 8s shell
  // command finish and the model produce its final reply, all persisted) — but
  // the UI had no way to learn the outcome if the live stream died, e.g. the tab
  // was closed and reopened, or a mobile browser suspended/killed the background
  // connection. On return, pull the persisted conversation and adopt it if it's
  // moved on from — or finished past — what's on screen.
  const convoIdRef = useRef("");
  useEffect(() => { convoIdRef.current = convoId; }, [convoId]);
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const reconcilePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reconcile = async (): Promise<boolean> => {
    const id = convoIdRef.current;
    if (!id) return false;
    try {
      const r = await fetch(`/api/agent/conversations/${id}`);
      if (!r.ok) return false;
      const j = await r.json();
      const msgs = (j.messages ?? []) as RawMsg[];
      if (!msgs.length) return false;
      const last = msgs[msgs.length - 1];
      // An assistant turn is only "still going" if it has tool_calls pending —
      // NOT if its content happens to be empty. A model that acts via tools with
      // no closing remark ends with content:"" and no tool_calls, which is a
      // legitimately finished turn, not an unfinished one. Requiring non-empty
      // content here misdiagnosed that as "still running" forever (no live fetch
      // to ever prove otherwise), which is what made Stop and the busy spinner
      // get stuck.
      const finished = last?.role === "assistant" && !last.tool_calls?.length;
      const { blocks: b, history: h } = reconstructSession(msgs);
      history.current = h;
      setBlocks(b);
      if (finished) { setBusy(false); return true; }
      return false;
    } catch { return false; }
  };
  const startReconcilePoll = () => {
    if (reconcilePollRef.current) return;
    let tries = 0;
    reconcilePollRef.current = setInterval(async () => {
      tries++;
      const done = await reconcile();
      if (done || tries > 48) { // ~2min ceiling
        if (reconcilePollRef.current) { clearInterval(reconcilePollRef.current); reconcilePollRef.current = null; }
      }
    }, 2500);
  };
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState !== "visible" || !busyRef.current) return;
      reconcile().then((done) => { if (!done) startReconcilePoll(); });
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("focus", resync);
      if (reconcilePollRef.current) { clearInterval(reconcilePollRef.current); reconcilePollRef.current = null; }
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
    fetch("/api/agent/loop").then((r) => r.json()).then((j) => {
      workspaceRef.current = j.workspace || "";
      setWorkspace(j.workspace || ""); setProjects(j.projects || []);
      if (j.modes?.length) setModes(j.modes);
    }).catch(() => {})
      .then(() => { loadConvos(); return fetch("/api/agent/conversations?kind=code"); })
      .then((r) => (r.ok ? r.json() : []))
      .then(async (list: Convo[]) => {
        if (!list?.[0]) return;
        await openConvo(list[0].id);
        // A fully closed-and-reopened tab (not just backgrounded) is a fresh
        // mount — it has no memory that a task might still be running. If the
        // resumed session's last message isn't a finished assistant reply, the
        // loop may still be going server-side; start polling rather than sitting
        // there looking done when it might not be.
        const r2 = await fetch(`/api/agent/conversations/${list[0].id}`).catch(() => null);
        const j2 = await r2?.json().catch(() => null);
        const msgs = (j2?.messages ?? []) as RawMsg[];
        const last = msgs[msgs.length - 1];
        const looksUnfinished = msgs.length > 0 && !(last?.role === "assistant" && !last.tool_calls?.length);
        if (looksUnfinished) { setBusy(true); startReconcilePoll(); }
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

  const send = async () => {
    const text = input.trim() || "Take a look at the attached image.";
    if ((!input.trim() && !attached.length) || busy) return;
    const pending = attached;
    setInput("");
    setAttached([]);
    setBusy(true);
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

    const ac = new AbortController();
    abortRef.current = ac;
    let doneCid = "";
    try {
      const res = await fetch("/api/agent/loop", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.current, model, autoApprove: auto, think, mode, project: project || undefined, conversationId: convoId || undefined }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let e: Ev;
          try { e = JSON.parse(line); } catch { continue; }
          setBlocks((prev) => {
            const next = prev.slice();
            const lastAssistant = () => {
              const last = next[next.length - 1];
              if (last?.t === "assistant" && last.agent === (e as { agent?: string }).agent) return last;
              const nb = { t: "assistant" as const, text: "", think: "", agent: (e as { agent?: string }).agent };
              next.push(nb);
              return nb;
            };
            if (e.k === "text") { const a = lastAssistant(); a.text += e.v; }
            else if (e.k === "think") { const a = lastAssistant(); a.think += e.v; }
            else if (e.k === "tool_request") next.push({ t: "tool", call: { ...e.v, agent: e.agent } });
            else if (e.k === "tool_result") {
              for (let j = next.length - 1; j >= 0; j--) {
                const b = next[j];
                if (b.t === "tool" && b.call.id === e.v.id) { next[j] = { t: "tool", call: { ...b.call, ok: e.v.ok, output: e.v.output } }; break; }
              }
            } else if (e.k === "approval_needed") {
              for (let j = next.length - 1; j >= 0; j--) {
                const b = next[j];
                if (b.t === "tool" && b.call.id === e.v.id) { next[j] = { t: "tool", call: { ...b.call, pendingApproval: true } }; break; }
              }
            } else if (e.k === "error") next.push({ t: "error", text: e.v });
            else if (e.k === "max_rounds") next.push({
              t: "error",
              text: (e.agent ? `[${e.agent}] ` : "") + `stopped after ${e.v} tool-call rounds without finishing — the task may be incomplete. Send another message to continue it.`,
            });
            return next;
          });
          // agent (or a helper sub-agent) may have touched files — refresh tree/git/editor
          if (e.k === "tool_result" && ["write_file", "edit_file", "run_shell", "run_python", "git"].includes(e.v.name)) setFsTick((t) => t + 1);
          if (e.k === "project") setInstructionFiles(e.v.instructionFiles || []);
          if (e.k === "approval_needed") setApproval(e.v);
          if (e.k === "done") { doneCid = e.v.conversationId; setConvoId(e.v.conversationId); loadConvos(); }
          if (e.k === "done" || e.k === "error") setApproval(null);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") setBlocks((prev) => [...prev, { t: "error", text: (err as Error).message }]);
    }
    // Rebuild history from the server's saved transcript (full tool_calls/tool
    // messages included) rather than appending just the final text summary.
    // Carrying forward only the text meant the model had NO memory of tool calls
    // it already made — asked to describe an image, then given a follow-up, it
    // couldn't see it had already called describe_image and would call it again;
    // same for files it had already written. The server persists the real
    // transcript regardless (verified) — the client should build on that, not a
    // lossy summary of it.
    if (doneCid) {
      try {
        const r = await fetch(`/api/agent/conversations/${doneCid}`);
        if (r.ok) {
          const j = await r.json();
          const { history: h } = reconstructSession((j.messages ?? []) as RawMsg[]);
          history.current = h;
        }
      } catch { /* keep whatever local history we had */ }
    }
    setBusy(false);
    setApproval(null);
    abortRef.current = null;
  };

  // Always resolves the stuck UI state locally even if there's no live fetch to
  // abort (e.g. busy was set by the reconnect-poll path, not an active send()) —
  // the user should never be unable to escape a spinner from this button.
  const stop = () => {
    abortRef.current?.abort();
    if (reconcilePollRef.current) { clearInterval(reconcilePollRef.current); reconcilePollRef.current = null; }
    setBusy(false);
  };

  const inp = "bg-[var(--surface-1)] border border-[var(--border)] rounded px-2 py-1.5 text-xs";
  // Panels reflow the chat via PADDING on this outer wrapper only — the chat column
  // must never gain a nested scroll container (the stick/jump logic is built on
  // window scrolling; see the scroll-effect comment above).
  return (
    <div className={(treeOpen ? "xl:pl-64 " : "") + (openFile ? "lg:pr-[min(52vw,760px)]" : "")}>
    <div className="max-w-4xl mx-auto px-4 pb-32 pt-4 flex flex-col min-h-dvh">
      <header className="flex items-center gap-3 flex-wrap mb-4">
        <span className="text-[var(--accent-ai)] font-bold tracking-widest text-sm flex items-center gap-2"><Bot size={18} /> MINI CLAUDE CODE</span>
        <select value={model} onChange={(e) => setModel(e.target.value)} className={inp}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value)} className={inp} title="agent workflow mode">
          {modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <button onClick={() => setAuto(!auto)} title={auto ? "tools auto-approved" : "file/shell tools ask first"}
          className="flex items-center gap-1.5 text-xs border rounded px-2.5 py-1.5"
          style={{ borderColor: auto ? "var(--accent-warn, #d29922)" : "var(--border)", color: auto ? "var(--accent-warn, #d29922)" : "var(--text-2)" }}>
          {auto ? <Zap size={13} /> : <ShieldCheck size={13} />}{auto ? "auto-approve" : "ask first"}
        </button>
        <button onClick={() => setThink(!think)} title={think ? "thinking enabled" : "thinking disabled (faster, less deliberation)"}
          className="flex items-center gap-1.5 text-xs border rounded px-2.5 py-1.5"
          style={{ borderColor: think ? "var(--accent-ai)" : "var(--border)", color: think ? "var(--accent-ai)" : "var(--muted)" }}>
          <Brain size={13} />{think ? "think" : "no-think"}
        </button>
        <div className="flex items-center gap-1">
          <button onClick={newSession} title="new session in this workspace"
            className="flex items-center text-xs border border-[var(--border)] rounded px-2 py-1.5 text-[var(--accent-ai)]">
            <MessageSquarePlus size={13} />
          </button>
          <div className="relative">
            <button onClick={() => setSessionsOpen((o) => !o)} title="past sessions"
              className="flex items-center gap-1.5 text-xs border border-[var(--border)] rounded px-2.5 py-1.5 text-[var(--text-2)]">
              sessions <ChevronDown size={12} />
            </button>
            {sessionsOpen && (
              <div className="absolute left-0 top-full mt-1 z-30 w-72 max-h-80 overflow-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-lg shadow-xl">
                {convos.length === 0 && <div className="text-xs text-[var(--muted)] px-3 py-2">no past sessions</div>}
              {convos.map((c) => (
                <button key={c.id} onClick={() => openConvo(c.id)}
                  className={"w-full flex items-center gap-2 text-xs px-3 py-2 hover:bg-[var(--surface-2)] text-left " + (c.id === convoId ? "bg-[var(--surface-2)]" : "")}>
                  <span className="flex-1 truncate">{c.title}</span>
                  {c.project && c.project !== workspace && (
                    <span className="text-[10px] text-[var(--muted)] font-mono max-w-[80px] truncate shrink-0" title={c.project}>{c.project.split("/").pop()}</span>
                  )}
                  <button onClick={(e) => deleteSession(c.id, e)} className="text-[var(--muted)] hover:text-[var(--accent-danger)] shrink-0"><Trash2 size={12} /></button>
                </button>
              ))}
              </div>
            )}
          </div>
        </div>
        <span className="flex items-center gap-1.5 ml-auto">
          <button onClick={() => toggleTree(!treeOpen)}
            title="file tree & git panel" className="flex items-center text-xs border rounded px-2 py-1.5"
            style={{ borderColor: treeOpen ? "var(--accent-ai)" : "var(--border)", color: treeOpen ? "var(--accent-ai)" : "var(--text-2)" }}>
            <PanelLeft size={13} />
          </button>
          <select value={project} onChange={(e) => { setProject(e.target.value); setOpenFile(null); newSession(); }}
            className={inp + " max-w-[240px]"} title="project directory the agent works in (switching starts a fresh session)">
            <option value="">{workspace ? "workspace (default)" : "workspace"}</option>
            {projects.filter((p) => p !== workspace).map((p) => <option key={p} value={p}>{p.split("/").slice(-2).join("/")}</option>)}
          </select>
          <button onClick={() => setPickerOpen(true)} className="text-xs border border-[var(--border)] rounded px-2 py-1.5" title="open another project">＋</button>
          {instructionFiles.length > 0 && (
            <span className="text-[10px] px-2 py-1 rounded border border-[var(--accent-ai)]/50 text-[var(--accent-ai)]" title={"loaded into the agent's system prompt: " + instructionFiles.join(", ")}>
              {instructionFiles.join(" + ")}
            </span>
          )}
        </span>
      </header>

      <div className="flex-1 space-y-3">
        {blocks.length === 0 && (
          <div className="text-sm text-[var(--muted)] leading-relaxed border border-[var(--border-soft)] rounded-lg p-5">
            An agent with real tools over <span className="font-mono text-[var(--text-2)]">{workspace || "the workspace"}</span>:
            files, grep, shell, a Python REPL, web search/fetch, image understanding (via Gemma), and helper sub-agents.
            Ask it to build, fix, or research something.
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
          className={(openFile ? "hidden lg:flex " : "flex ") + "fixed bottom-24 left-1/2 -translate-x-1/2 z-40 items-center gap-1.5 text-xs bg-[var(--surface-1)] border border-[var(--border)] rounded-full shadow-lg px-3 py-1.5 text-[var(--text-2)]"}>
          <ArrowDown size={13} /> jump to latest
        </button>
      )}

      {approval && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 bg-[var(--surface-1)] border border-[var(--accent-warn,#d29922)] rounded-xl shadow-xl px-4 py-3 max-w-[90vw] w-[560px]">
          <div className="text-xs font-semibold mb-1.5">{approval.name}</div>
          {/* Full args, not a truncated summary — a 90-char preview once hid the
              back half of a run_shell command behind the one place blind trust
              is most dangerous: what you're about to let it execute. */}
          <pre className="text-[11px] font-mono bg-[var(--surface-2,#11151c)] border border-[var(--border-soft)] rounded p-2 max-h-56 overflow-auto whitespace-pre-wrap mb-2">
            {approval.name === "run_shell" ? String(approval.args.command ?? "")
              : approval.name === "git" ? "git " + [approval.args.command, ...(Array.isArray(approval.args.args) ? approval.args.args : [])].join(" ")
              : JSON.stringify(approval.args, null, 1)}
          </pre>
          <div className="flex justify-end gap-2">
            <button onClick={() => decide(approval.id, false)} className="text-xs border border-[var(--border)] rounded px-3 py-1.5">Deny</button>
            <button onClick={() => decide(approval.id, true)} className="text-xs font-semibold bg-[var(--accent-ai)] text-[#05090c] rounded px-3 py-1.5">Approve</button>
          </div>
        </div>
      )}

      <div className={"fixed bottom-14 md:bottom-0 left-0 right-0 bg-[var(--bg)] border-t border-[var(--border)] p-3"
        + (navCollapsed ? "" : " md:left-14 lg:left-44")
        + (openFile ? " lg:right-[min(52vw,760px)]" : "") + (treeOpen ? (navCollapsed ? " xl:left-64" : " xl:left-[27rem]") : "")}>
        <div className="max-w-4xl mx-auto">
          {attached.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap">
              {attached.map((f, i) => (
                <span key={i} className="flex items-center gap-1.5 text-[11px] bg-[var(--surface-1)] border border-[var(--border)] rounded px-2 py-1">
                  {f.name}
                  <button onClick={() => setAttached((a) => a.filter((_, j) => j !== i))} className="text-[var(--muted)] hover:text-[var(--accent-danger)]"><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} title="attach image (for the agent's describe_image tool)"
              className="px-3 rounded border border-[var(--border)] text-[var(--text-2)]"><Paperclip size={15} /></button>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              onPaste={(e) => { const files = e.clipboardData?.files; if (files?.length) addFiles(files); }}
              placeholder="Build me… / Fix… / Research…" className={inp + " flex-1 resize-none text-sm"} />
            {busy
              ? <button onClick={stop} className="px-4 rounded bg-[var(--accent-danger)] text-[#05090c] flex items-center gap-1.5 text-sm font-semibold"><CircleStop size={15} /> Stop</button>
              : <button onClick={send} disabled={!input.trim() && !attached.length} className="px-4 rounded bg-[var(--accent-ai)] text-[#05090c] flex items-center gap-1.5 text-sm font-semibold disabled:opacity-40"><Send size={15} /> Send</button>}
          </div>
        </div>
      </div>
    </div>

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
    </div>
  );
}
