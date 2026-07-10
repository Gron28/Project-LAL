"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, CircleStop, Eye, FileCode, Menu, Sparkles, Paperclip, X, Pencil, Trash2, SlidersHorizontal, Copy, Mic, Volume2, VolumeX, AudioLines, Globe, FileText, TerminalSquare } from "lucide-react";
import LlmSettings from "./llm-settings";
import { enqueueSpeech, stopSpeech, setSpeechListener } from "./voice";
import MarkdownView from "@/components/markdown-view";
import { StatsGlance, type Usage } from "@/components/agent/stats-hud";
import { SignalTrace } from "@/components/ui/signal-trace";

type Msg = { role: "user" | "assistant"; content: string; thinking?: string; status?: string; images?: string[]; visionModel?: string; truncated?: boolean };
type Convo = { id: string; title: string; model: string; updatedAt: string };

const SUGGESTIONS = [
  "Explain a concept in simple terms.",
  "Write a short Python function for me.",
  "Summarize the text I paste next.",
  "Brainstorm ideas for a project.",
];

// Apply SEARCH/REPLACE sections (from an ```edit block) to a base file. Returns
// the patched file + how many sections applied/failed. Tolerant of trailing
// whitespace drift (small models add/drop it).
function applyEdits(base: string, editBlock: string): { result: string; applied: number; failed: number } {
  let result = base;
  let applied = 0;
  let failed = 0;
  const re = /<<<<<<<\s*SEARCH\s*\n([\s\S]*?)\n?=======\s*\n([\s\S]*?)\n?>>>>>>>\s*REPLACE/g;
  const norm = (s: string) => s.replace(/[ \t]+/g, " ").trim();
  let m: RegExpExecArray | null;
  while ((m = re.exec(editBlock)) !== null) {
    const find = m[1];
    const replace = m[2];
    // 1) exact match
    let i = result.indexOf(find);
    if (i >= 0) {
      result = result.slice(0, i) + replace + result.slice(i + find.length);
      applied++;
      continue;
    }
    // 2) whole-block trimmed
    const ft = find.trim();
    i = ft ? result.indexOf(ft) : -1;
    if (i >= 0) {
      result = result.slice(0, i) + replace.trim() + result.slice(i + ft.length);
      applied++;
      continue;
    }
    // 3) line-based fuzzy: match a contiguous run of lines ignoring per-line
    // indentation / trailing whitespace (the common cause of a failed SEARCH).
    const baseLines = result.split("\n");
    const fLines = find.replace(/^\n+|\n+$/g, "").split("\n");
    const fNorm = fLines.map(norm);
    let at = -1;
    for (let s = 0; s + fNorm.length <= baseLines.length; s++) {
      let ok = true;
      for (let k = 0; k < fNorm.length; k++) {
        if (norm(baseLines[s + k]) !== fNorm[k]) { ok = false; break; }
      }
      if (ok) { at = s; break; }
    }
    if (at >= 0) {
      baseLines.splice(at, fNorm.length, ...replace.replace(/^\n+|\n+$/g, "").split("\n"));
      result = baseLines.join("\n");
      applied++;
      continue;
    }
    failed++;
  }
  return { result, applied, failed };
}

// Render assistant text. ```html blocks become artifact cards; ```edit blocks
// (SEARCH/REPLACE) are applied to the running artifact and rendered as the full
// updated file — so "change just the background" produces a usable file, not a
// loose snippet. `priorHtml` is the artifact in effect before this message.
function AssistantContent({ text, priorHtml = "" }: { text: string; priorHtml?: string }) {
  const parts: { type: "text" | "html"; body: string; edited?: boolean; before?: string }[] = [];
  const re = /```(html|edit)\s*([\s\S]*?)```/gi;
  let last = 0;
  let running = priorHtml;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", body: text.slice(last, m.index) });
    const lang = m[1].toLowerCase();
    const body = m[2].trim();
    if (lang === "html") {
      parts.push({ type: "html", body });
      running = body;
    } else {
      const before = running;
      const { result, applied, failed } = applyEdits(running, body);
      if (applied > 0) {
        parts.push({ type: "html", body: result, edited: true, before });
        running = result;
        if (failed > 0) parts.push({ type: "text", body: `\n_(${failed} edit section${failed > 1 ? "s" : ""} didn't match and were skipped)_` });
      } else {
        parts.push({ type: "text", body: `_Couldn't apply the edit — the search text didn't match the current file. Try again or use the artifact's Edit button._` });
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", body: text.slice(last) });
  if (parts.length === 0) return <>{text}</>;

  return (
    <>
      {parts.map((p, i) =>
        p.type === "text" ? (
          <MarkdownView key={i} text={p.body} />
        ) : (
          <HtmlArtifact key={i} html={p.body} fromEdit={p.edited} before={p.before} />
        ),
      )}
    </>
  );
}

// The artifact in effect just before message `idx` (cumulative: html blocks set
// it, edit blocks patch it), so edits chain across turns.
function priorArtifactAt(messages: Msg[], idx: number): string {
  let cur = "";
  for (let i = 0; i < idx; i++) {
    const text = messages[i]?.content ?? "";
    const re = /```(html|edit)\s*([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1].toLowerCase() === "html") cur = m[2].trim();
      else { const { result, applied } = applyEdits(cur, m[2].trim()); if (applied > 0) cur = result; }
    }
  }
  return cur;
}


// Line-level diff (LCS) for the readable before/after view on a patched artifact.
// Modeled on Claude Code: an edit shows what changed, not just the new blob.
type DiffLine = { kind: "ctx" | "add" | "del" | "skip"; text: string };
function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const mm = b.length;
  // Guard against pathological cost on huge files; fall back to whole-block swap.
  if (n * mm > 600_000) {
    return [
      ...a.map((t) => ({ kind: "del" as const, text: t })),
      ...b.map((t) => ({ kind: "add" as const, text: t })),
    ];
  }
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(mm + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = mm - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < mm) {
    if (a[i] === b[j]) { raw.push({ kind: "ctx", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ kind: "del", text: a[i] }); i++; }
    else { raw.push({ kind: "add", text: b[j] }); j++; }
  }
  while (i < n) raw.push({ kind: "del", text: a[i++] });
  while (j < mm) raw.push({ kind: "add", text: b[j++] });
  // Collapse long unchanged runs into a single "skip" marker (keep 2 lines of context).
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = () => {
    if (run.length <= 5) out.push(...run);
    else {
      out.push(run[0], run[1]);
      out.push({ kind: "skip", text: `… ${run.length - 4} unchanged lines …` });
      out.push(run[run.length - 2], run[run.length - 1]);
    }
    run = [];
  };
  for (const line of raw) {
    if (line.kind === "ctx") run.push(line);
    else { flush(); out.push(line); }
  }
  flush();
  return out;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  const adds = lines.filter((l) => l.kind === "add").length;
  const dels = lines.filter((l) => l.kind === "del").length;
  return (
    <div>
      <div className="px-2 py-1 text-[10px] text-[var(--muted)] border-b border-[var(--border)]">
        <span className="text-emerald-400">+{adds}</span> <span className="text-red-400">−{dels}</span> lines changed
      </div>
      <pre className="text-[11px] font-mono p-0 max-h-72 overflow-auto leading-relaxed">
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.kind === "add"
                ? "bg-emerald-500/10 text-emerald-300 px-2"
                : l.kind === "del"
                  ? "bg-red-500/10 text-red-300 px-2"
                  : l.kind === "skip"
                    ? "text-[var(--muted)] italic px-2 select-none"
                    : "text-[var(--muted)] px-2"
            }
          >
            <span className="select-none opacity-50 mr-1.5">
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "skip" ? " " : " "}
            </span>
            {l.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function HtmlArtifact({ html, fromEdit = false, before }: { html: string; fromEdit?: boolean; before?: string }) {
  const [code, setCode] = useState(html);
  const [editing, setEditing] = useState(false);
  const hasDiff = fromEdit && typeof before === "string" && before.length > 0 && before !== html;
  const [showDiff, setShowDiff] = useState(hasDiff);
  const dirty = code !== html;
  const open = () => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/html" }));
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-${Date.now()}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  return (
    <div className="my-2 border border-[var(--border)] rounded-[var(--r-md)] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-[var(--surface-2)] text-xs">
        <span className="text-[var(--muted)] inline-flex items-center gap-1.5">
          <FileCode size={13} /> HTML file · {(code.length / 1024).toFixed(1)} KB{fromEdit ? " · patched" : ""}{dirty ? " · edited" : ""}
        </span>
        <div className="ml-auto flex gap-2">
          {hasDiff && (
            <button onClick={() => setShowDiff((v) => !v)} className="text-[var(--accent-ai)] hover:underline">{showDiff ? "File" : "Changes"}</button>
          )}
          <button onClick={() => setEditing((v) => !v)} className="text-[var(--accent-ai)] hover:underline">{editing ? "Done" : "Edit"}</button>
          <button onClick={open} className="text-[var(--accent-ai)] hover:underline">Open</button>
          <button onClick={download} className="text-[var(--accent-ai)] hover:underline">Download</button>
        </div>
      </div>
      {editing ? (
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          className="w-full h-64 bg-[var(--surface-1)] text-[11px] font-mono text-zinc-200 p-2 outline-none resize-y leading-relaxed"
        />
      ) : hasDiff && showDiff ? (
        <DiffView before={before as string} after={code} />
      ) : (
        <pre className="text-[11px] font-mono text-[var(--muted)] p-2 max-h-32 overflow-auto whitespace-pre-wrap">
          {code.slice(0, 600)}{code.length > 600 ? "…" : ""}
        </pre>
      )}
    </div>
  );
}

type ServerMsg = { role: string; content: string | null };
// Defensive: /code sessions share this store (tool role, null content, tool_calls)
// and must never reach here (fetches are kind=chat-filtered) — but if one ever does,
// coerce instead of crashing the whole page on an unrenderable role/null content.
function msgFromServer(m: ServerMsg): Msg {
  return { role: m.role === "assistant" ? "assistant" : "user", content: m.content ?? "" };
}


function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

// Pull the next speakable chunk from streaming text: up to the last sentence end
// past `spokenLen`, or — if a sentence is dragging — a word break near ~70 chars,
// so speech starts within a few words instead of waiting for the whole reply.
function nextSpeakChunk(content: string, spokenLen: number): { chunk: string; newLen: number } | null {
  const pending = content.slice(spokenLen);
  if (!pending.trim()) return null;
  const m = pending.match(/^[\s\S]*?[.!?\n](\s|$)/);
  if (m && m[0].trim().length > 1) return { chunk: m[0], newLen: spokenLen + m[0].length };
  if (pending.length > 70) {
    const cut = pending.lastIndexOf(" ", 70);
    const at = cut > 20 ? cut : 70;
    return { chunk: pending.slice(0, at), newLen: spokenLen + at };
  }
  return null;
}

export default function AgentChat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);

  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");

  const [convos, setConvos] = useState<Convo[]>([]);
  const [convoId, setConvoId] = useState("");
  const [listOpen, setListOpen] = useState(false);

  const [think, setThink] = useState(true);
  const [usage, setUsage] = useState<Usage>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [webMode, setWebMode] = useState(false);
  const [docsMode, setDocsMode] = useState(false);
  useEffect(() => { fetch("/api/modes").then((r) => r.json()).then((j) => { setWebMode(!!j.web); setDocsMode(!!j.groundDocs); }).catch(() => {}); }, []);
  const toggleModes = (web: boolean, docs: boolean) => { setWebMode(web); setDocsMode(docs); fetch("/api/modes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ web, groundDocs: docs }) }).catch(() => {}); };
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const [attached, setAttached] = useState<{ name: string; data: string }[]>([]);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [revealedIdx, setRevealedIdx] = useState<number | null>(null); // long-press reveal (touch)
  const [listening, setListening] = useState(false);
  const [speakOn, setSpeakOn] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false); // full hands-free conversation mode
  const [speakingText, setSpeakingText] = useState(""); // current chunk being spoken (subtitle)
  const [bargeIn, setBargeIn] = useState(false); // experimental: talk over the voice to interrupt
  // refs so the auto-listen loop reads live state without re-subscribing
  const voiceModeRef = useRef(false);
  const listeningRef = useRef(false);
  const streamingRef = useRef(false);
  const bargeInRef = useRef(false);
  const speakingRef = useRef(""); // mirrors speakingText for the recognizer callback
  const startVoiceRef = useRef<() => void>(() => {});
  const autoListenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persisted barge-in preference (experimental; off by default).
  useEffect(() => {
    try { setBargeIn(localStorage.getItem("agent.bargeIn") === "1"); } catch { /* ignore */ }
  }, []);
  const toggleBargeIn = () => {
    setBargeIn((v) => {
      const nv = !v;
      try { localStorage.setItem("agent.bargeIn", nv ? "1" : "0"); } catch { /* ignore */ }
      return nv;
    });
  };

  // Hands-free turn-taking, VOICE MODE ONLY: open the mic on entry and again each
  // time it finishes speaking, so you don't tap between turns. Tap the orb to
  // interrupt. (Never active outside voice mode / the assistant page.)
  useEffect(() => {
    if (!voiceMode) { setSpeechListener(null); setSpeakingText(""); speakingRef.current = ""; return; }
    const armListen = (delay: number) => {
      if (autoListenTimer.current) clearTimeout(autoListenTimer.current);
      autoListenTimer.current = setTimeout(() => {
        if (voiceModeRef.current && !listeningRef.current && !streamingRef.current) startVoiceRef.current();
      }, delay);
    };
    // Barge-in: open the mic WHILE it's speaking so the user can talk over it.
    // Ignores the streaming guard (speech can begin mid-stream). Experimental.
    const armBarge = (delay: number) => {
      if (autoListenTimer.current) clearTimeout(autoListenTimer.current);
      autoListenTimer.current = setTimeout(() => {
        if (voiceModeRef.current && bargeInRef.current && !listeningRef.current) startVoiceRef.current();
      }, delay);
    };
    setSpeechListener((s) => {
      setSpeakingText(s);
      speakingRef.current = s;
      if (s) {
        if (bargeInRef.current) armBarge(250); // listen during speech → allow talking over it
        else if (autoListenTimer.current) clearTimeout(autoListenTimer.current);
      } else armListen(700); // speech finished → listen for the reply
    });
    armListen(400); // entering voice mode → start listening
    return () => { setSpeechListener(null); if (autoListenTimer.current) clearTimeout(autoListenTimer.current); };
  }, [voiceMode]);
  const [copied, setCopied] = useState<string>("");
  const recogRef = useRef<{ stop: () => void } | null>(null);
  const lpRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyText = (text: string, tag = "msg") => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(tag); setTimeout(() => setCopied(""), 1200); }).catch(() => {});
    setRevealedIdx(null);
  };

  const lpCancel = () => { if (lpRef.current) { clearTimeout(lpRef.current); lpRef.current = null; } };
  // Spread onto a message bubble: a ~500ms finger-hold reveals its actions.
  const longPress = (i: number) => ({
    onTouchStart: () => { lpCancel(); lpRef.current = setTimeout(() => setRevealedIdx(i), 500); },
    onTouchEnd: lpCancel,
    onTouchMove: lpCancel,
    onTouchCancel: lpCancel,
    onContextMenu: (e: React.MouseEvent) => { if (revealedIdx === i) e.preventDefault(); },
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true); // is the user pinned to the bottom of the chat?

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (revealedIdx !== null) setRevealedIdx(null); // scrolling dismisses a long-press menu
  };
  const convoIdRef = useRef(""); // live convoId for callbacks that must not capture a stale value
  const genIdRef = useRef<string>(""); // the current generation's run id (for Stop + reattach)
  const reconcileIdxRef = useRef<number>(-1); // assistant index of an in-flight turn, for visibility-resync
  const turnRef = useRef(0); // bumps per send; a reattach bumps it to neutralize a dead/late stream
  const esChatRef = useRef<EventSource | null>(null);
  useEffect(() => () => { esChatRef.current?.close(); }, []); // unmount: detach (run unaffected)
  // Stop = a REAL server-side cancel now: generations run in the run manager, so
  // stopping aborts the model decode itself (the old endpoint was a no-op and the
  // GPU kept generating after every Stop). Then tear down the voice.
  const stop = () => {
    const g = genIdRef.current;
    if (g) fetch("/api/agent/chat/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: g }) }).catch(() => {});
    stopSpeech();
  };

  const stopAllAgents = async () => {
    if (!confirm("Stop every active agent, chat, and deliberation run? This cancels their current model calls.")) return;
    try {
      const r = await fetch("/api/agent/runs/stop-all", { method: "POST" }).then((x) => x.json());
      if (r.stopping) stopSpeech();
    } catch { /* the current generation remains available through its normal Stop control */ }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    // Cap raised from 4: the vision backend now routes to a faster (smaller) model
    // once a batch exceeds 5 images (see VISION_FAST_THRESHOLD, api/agent/chat/route.ts) —
    // a cap of 4 would have made that branch unreachable.
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, 10);
    const read = await Promise.all(
      imgs.map(
        (f) =>
          new Promise<{ name: string; data: string }>((res) => {
            const r = new FileReader();
            r.onload = () => res({ name: f.name, data: String(r.result) });
            r.readAsDataURL(f);
          }),
      ),
    );
    setAttached((a) => [...a, ...read].slice(0, 10));
  };

  const loadConvos = useCallback(async () => {
    try {
      const r = await fetch("/api/agent/conversations?kind=chat");
      if (r.ok) setConvos(await r.json());
    } catch { /* ignore */ }
  }, []);

  const openConvo = useCallback(async (id: string): Promise<ServerMsg[] | null> => {
    setListOpen(false);
    try {
      const r = await fetch(`/api/agent/conversations/${id}`);
      if (!r.ok) return null;
      const j = await r.json();
      setMessages((j.messages ?? []).map(msgFromServer));
      setConvoId(id);
      // Restore the settings this session actually used, rather than leaving
      // whatever's currently globally selected.
      if (typeof j.model === "string" && j.model) setModel(j.model);
      if (typeof j.think === "boolean") setThink(j.think);
      return (j.messages ?? []) as ServerMsg[];
    } catch { return null; }
  }, []);

  // Attach to a chat generation's run stream (live send or reattach after the tab
  // was suspended/closed) and render its tokens into the assistant slot at `idx`.
  // Replay from seq 0 rebuilds the full text deterministically, so attaching late
  // shows exactly what attaching live would have. Resolves when the run settles.
  const attachChatRun = useCallback((runId: string, idx: number, myTurn: number, willSpeak: boolean) => new Promise<void>((resolve) => {
    esChatRef.current?.close();
    genIdRef.current = runId;
    const es = new EventSource(`/api/agent/runs/${runId}/stream`);
    esChatRef.current = es;
    let content = "";
    let thinking = "";
    let visionModel = "";
    let status = "Connecting to the local agent…";
    let truncated = false;
    let spokenLen = 0;
    const paint = () => {
      const c = content, t = thinking, vm = visionModel, wasTruncated = truncated;
      setMessages((p) => {
        const copy = [...p];
        copy[idx] = { role: "assistant", content: c, thinking: t, ...(status ? { status } : {}), ...(vm ? { visionModel: vm } : {}), ...(wasTruncated ? { truncated: true } : {}) };
        return copy;
      });
    };
    const finish = (status: string, errText?: string) => {
      es.close();
      if (esChatRef.current === es) esChatRef.current = null;
      if (turnRef.current === myTurn) {
        if (status === "stopped") content = (content || "") + "\n\n_(stopped)_";
        else if (status === "error" || status === "interrupted") content = (content ? content + "\n\n" : "") + `Error: ${(errText || status).slice(0, 200)}`;
        paint();
        genIdRef.current = "";
        reconcileIdxRef.current = -1;
        setStreaming(false);
        loadConvos();
        if (willSpeak && content.length > spokenLen) enqueueSpeech(content.slice(spokenLen)); // read the tail
      }
      resolve();
    };
    es.onmessage = (ev) => {
      if (turnRef.current !== myTurn) { es.close(); if (esChatRef.current === es) esChatRef.current = null; resolve(); return; }
      let e: { k: string; v?: unknown; error?: string };
      try { e = JSON.parse(ev.data); } catch { return; }
      if (e.k === "run") {
        if ((e.v as { truncated?: boolean } | undefined)?.truncated) { truncated = true; paint(); }
      } else if (e.k === "model_loading") { status = `Loading ${(e.v as { model?: string })?.model || "local model"}…`; paint(); }
      else if (e.k === "model_ready") { status = `${(e.v as { model?: string })?.model || "Local model"} is ready`; paint(); }
      else if (e.k === "think") { thinking += String(e.v ?? ""); paint(); }
      else if (e.k === "text") {
        content += String(e.v ?? "");
        status = "";
        paint();
        if (willSpeak) {
          let r;
          while ((r = nextSpeakChunk(content, spokenLen))) { enqueueSpeech(r.chunk); spokenLen = r.newLen; }
        }
      } else if (e.k === "model") { visionModel = String(e.v ?? ""); paint(); }
      else if (e.k === "usage") setUsage(e.v as Usage);
      else if (e.k === "truncated") { truncated = true; paint(); }
      else if (e.k === "transcript") {
        const heard = String(e.v ?? "");
        if (heard) setMessages((p) => { const c = [...p]; if (c[idx - 1]?.role === "user") c[idx - 1] = { ...c[idx - 1], content: heard }; return c; });
      } else if (e.k === "status") {
        const v = String(e.v);
        if (["done", "error", "stopped", "interrupted"].includes(v)) finish(v, e.error);
      }
    };
    // EventSource reconnects on its own (resuming via Last-Event-ID); if the run
    // ended while disconnected, the reconnect replays the terminal status.
  }), [loadConvos]);

  // When the tab becomes visible again (or the network returns) and a reply was in
  // flight but nothing is attached, ask the run manager whether the generation is
  // still live — reattach if so, adopt the persisted reply if it already finished.
  useEffect(() => {
    const resync = async () => {
      if (document.visibilityState !== "visible") return;
      if (!streamingRef.current || esChatRef.current) return;
      const idx = reconcileIdxRef.current;
      const cid = convoIdRef.current;
      if (idx < 0 || !cid) return;
      try {
        const runs: { id: string; status: string; conversationId: string; kind: string }[] =
          await fetch("/api/agent/runs?limit=20").then((r) => r.json());
        const liveRun = runs.find((x) => x.status === "running" && x.kind === "chat" && x.conversationId === cid);
        if (liveRun) { attachChatRun(liveRun.id, idx, turnRef.current, false); return; }
        // Not live: the reply (possibly partial) is whatever got persisted.
        const r = await fetch(`/api/agent/conversations/${cid}`);
        if (r.ok) {
          const j = await r.json();
          turnRef.current++;
          reconcileIdxRef.current = -1;
          genIdRef.current = "";
          setMessages(((j.messages ?? []) as ServerMsg[]).map(msgFromServer));
        }
        setStreaming(false);
      } catch { /* offline — the next visibility change retries */ }
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("focus", resync);
    };
  }, [attachChatRun]);

  // On mount: models + conversation list (for the dropdown), but a new session
  // starts genuinely blank — it does NOT resume the most recent chat. Open an old
  // one from the dropdown, or via a deep link, which still reattaches a live run
  // if a fully closed-and-reopened tab left one generating.
  useEffect(() => {
    fetch("/api/agent/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) { setModels(j.models ?? []); setModel(j.current ?? ""); } })
      .catch(() => {});
    loadConvos().then(() => {});
    const reattachIfLive = async (cid: string, msgs: ServerMsg[] | null) => {
      try {
        const runs: { id: string; status: string; conversationId: string; kind: string }[] =
          await fetch("/api/agent/runs?limit=20").then((r) => r.json());
        const liveRun = runs.find((x) => x.status === "running" && x.kind === "chat" && x.conversationId === cid);
        if (!liveRun) return;
        const base = msgs ?? [];
        const idx = base.length;
        setMessages([...base.map(msgFromServer), { role: "assistant", content: "", thinking: "" }]);
        setStreaming(true);
        reconcileIdxRef.current = idx;
        convoIdRef.current = cid;
        attachChatRun(liveRun.id, idx, ++turnRef.current, false);
      } catch { /* server unreachable — visibility resync will retry */ }
    };
    // Deep-link from Library ("open in /chat"): ?conv=<id> opens that specific
    // conversation. Without one, the session starts blank.
    const deepLinkId = new URLSearchParams(window.location.search).get("conv");
    if (deepLinkId) {
      openConvo(deepLinkId).then((msgs) => reattachIfLive(deepLinkId, msgs));
      window.history.replaceState(null, "", "/chat");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConvos, openConvo]);

  useEffect(() => {
    // Only auto-scroll if the user is already at the bottom — don't yank them
    // down while they've scrolled up to read during streaming.
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const newChat = () => {
    if (streaming) return;
    setMessages([]);
    setConvoId("");
    setListOpen(false);
    setTimeout(() => taRef.current?.focus(), 0);
  };

  const handoffToCode = async () => {
    if (!convoId || streaming) return;
    const r = await fetch("/api/agent/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: convoId }),
    }).then((x) => x.json()).catch(() => ({ error: "request failed" }));
    if (!r.conversationId) { setCopied("handofferr"); setTimeout(() => setCopied(""), 3000); return; }
    window.location.assign(`/code?conv=${encodeURIComponent(r.conversationId)}`);
  };

  const deleteConvo = async (id: string) => {
    await fetch(`/api/agent/conversations/${id}`, { method: "DELETE" }).catch(() => {});
    setConvos((c) => c.filter((x) => x.id !== id));
    if (id === convoId) newChat();
  };

  const changeModel = (m: string) => {
    setModel(m);
    fetch("/api/agent/models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: m }),
    }).catch(() => {});
  };

  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  const send = useCallback(
    async (text: string, base?: Msg[], audioB64?: string, speakOverride?: boolean) => {
      const body = text.trim();
      if ((!body && attached.length === 0 && !audioB64) || streaming) return;
      setInput("");
      setRevealedIdx(null);
      setSuggestDismissed(false);
      const imgs = attached.map((a) => a.data);
      setAttached([]);
      if (taRef.current) taRef.current.style.height = "auto";

      const history = base ?? messages;
      const currentArtifact = priorArtifactAt(history, history.length);
      const userContent = body || (audioB64 ? "🎤 Voice message" : body);
      const next: Msg[] = [...history, { role: "user", content: userContent, images: imgs.length ? imgs : undefined }];
      setMessages(next);
      setStreaming(true);
      const idx = next.length;
      const myTurn = ++turnRef.current; // identity of this turn; a reattach invalidates it
      reconcileIdxRef.current = idx;
      setMessages([...next, { role: "assistant", content: "", thinking: "", status: `Starting ${model}…` }]);
      atBottomRef.current = true; // a fresh send pins to the bottom

      try {
        // POST returns {runId, conversationId} immediately — the generation runs
        // detached in the server's run manager. Rendering happens through the
        // attached SSE stream (same code path a reattach uses), so a suspended or
        // closed tab changes nothing about the generation itself.
        const res = await fetch("/api/agent/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })), conversationId: convoId || undefined, model, think: audioB64 ? false : think, attachments: imgs, currentArtifact: currentArtifact || undefined, audio: audioB64 || undefined }),
        });
        if (!res.ok) {
          const err = await res.text().catch(() => "error");
          setMessages((p) => {
            const c = [...p];
            c[idx] = { role: "assistant", content: `Error: ${err.slice(0, 200)}` };
            return c;
          });
          setStreaming(false);
          return;
        }
        const j = await res.json();
        const cid = j.conversationId || res.headers.get("x-conversation-id");
        if (cid && cid !== convoId) { setConvoId(cid); convoIdRef.current = cid; }
        await attachChatRun(j.runId, idx, myTurn, speakOverride ?? speakOn);
      } catch (e) {
        if (turnRef.current === myTurn) {
          setMessages((p) => {
            const c = [...p];
            c[idx] = { role: "assistant", content: `Error: ${(e as Error).message.slice(0, 200)}` };
            return c;
          });
          genIdRef.current = "";
          reconcileIdxRef.current = -1;
          setStreaming(false);
        }
      } finally {
        setTimeout(() => taRef.current?.focus(), 0);
      }
    },
    [messages, streaming, convoId, model, think, attached, speakOn, attachChatRun],
  );

  const patchConvo = (op: "delete" | "truncate", index: number) =>
    convoId
      ? fetch(`/api/agent/conversations/${convoId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op, index }),
        }).catch(() => {})
      : Promise.resolve();

  const deleteMessage = async (i: number) => {
    if (streaming) return;
    setRevealedIdx(null);
    await patchConvo("delete", i);
    setMessages((p) => p.filter((_, j) => j !== i));
    loadConvos();
  };

  const startEdit = (i: number) => {
    if (streaming) return;
    setRevealedIdx(null);
    setEditingIdx(i);
    setEditText(messages[i].content);
  };
  const cancelEdit = () => { setEditingIdx(null); setEditText(""); };

  // Continue a truncated assistant message: stream the continuation and append
  // it to the SAME message/code in place (no new bubble, no rewrite).
  const continueMessage = async (i: number) => {
    if (streaming) return;
    setRevealedIdx(null);
    setStreaming(true);
    const base = messages[i]?.content ?? "";
    setMessages((p) => { const c = [...p]; if (c[i]) c[i] = { ...c[i], truncated: false }; return c; });
    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: messages.slice(0, i + 1).map(({ role, content }) => ({ role, content })),
          conversationId: convoId || undefined,
          continueIndex: i,
          model,
          think,
        }),
      });
      if (!res.ok) return;
      const j = await res.json();
      genIdRef.current = j.runId || "";
      await new Promise<void>((resolve) => {
        esChatRef.current?.close();
        const es = new EventSource(`/api/agent/runs/${j.runId}/stream`);
        esChatRef.current = es;
        let cont = "";
        es.onmessage = (ev) => {
          let e: { k: string; v?: unknown };
          try { e = JSON.parse(ev.data); } catch { return; }
          if (e.k === "text") {
            cont += String(e.v ?? "");
            setMessages((p) => { const c = [...p]; if (c[i]) c[i] = { ...c[i], content: base + cont }; return c; });
          } else if (e.k === "truncated") {
            setMessages((p) => { const c = [...p]; if (c[i]) c[i] = { ...c[i], truncated: true }; return c; });
          } else if (e.k === "status" && ["done", "error", "stopped", "interrupted"].includes(String(e.v))) {
            es.close();
            if (esChatRef.current === es) esChatRef.current = null;
            resolve();
          }
        };
      });
      loadConvos();
    } catch { /* error: keep what streamed (server persisted the continuation) */ } finally {
      genIdRef.current = "";
      setStreaming(false);
    }
  };

  // Voice input: fast browser speech-to-text. Normal mode → fills + sends as a
  // plain text message (no spoken reply). Voice mode → sends + speaks the reply.
  const startVoice = () => {
    if (listening) { recogRef.current?.stop(); return; }
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setCopied("insecure"); setTimeout(() => setCopied(""), 4000); return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setCopied("nomic"); setTimeout(() => setCopied(""), 3500); return; }
    const r = new SR();
    r.lang = navigator.language || "es-ES";
    r.interimResults = true;
    r.continuous = false;
    const vm = voiceMode; // capture the mode at the moment we start talking
    let finalText = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    r.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      const heard = (finalText + interim).trim();
      // Barge-in: the user is talking over the voice → go quiet and abort the
      // reply so their new utterance takes over. Threshold (>=5 non-space chars)
      // guards against the speaker→mic echo false-triggering on short blips.
      if (vm && bargeInRef.current && speakingRef.current && heard.replace(/\s+/g, "").length >= 5) {
        stopSpeech();
        if (streamingRef.current) stop(); // barge-in: cancel the generation server-side
        speakingRef.current = "";
      }
      if (!vm) setInput(heard);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    r.onerror = (e: any) => {
      setListening(false);
      if (e?.error === "not-allowed") { setCopied("micdenied"); setTimeout(() => setCopied(""), 3500); }
    };
    r.onend = () => {
      setListening(false);
      recogRef.current = null;
      const t = finalText.trim();
      if (t) send(t, undefined, undefined, vm || undefined); // voice mode speaks the reply
    };
    recogRef.current = r;
    setListening(true);
    r.start();
  };

  // keep the auto-listen loop's refs pointed at live state + the latest startVoice
  voiceModeRef.current = voiceMode;
  listeningRef.current = listening;
  streamingRef.current = streaming;
  bargeInRef.current = bargeIn;
  convoIdRef.current = convoId;
  startVoiceRef.current = startVoice;

  const copyChat = () => {
    if (!messages.length) return;
    const text = messages.map((m) => `${m.role === "user" ? "You" : "Assistant"}: ${m.content}`).join("\n\n");
    copyText(text, "chat");
  };
  const saveEdit = async (i: number) => {
    const text = editText.trim();
    setEditingIdx(null);
    setEditText("");
    if (!text || streaming) return;
    // drop the edited message + everything after, then re-run from here.
    const base = messages.slice(0, i);
    await patchConvo("truncate", i);
    setMessages(base);
    send(text, base);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
  };

  const empty = messages.length === 0;

  // Suggest dropping to a lighter model if the last reply looks like a GPU crash
  // on a heavy model. Non-automatic — a dismissible suggestion (Felipe's ask).
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const crashed = !!lastAssistant && /llama-server|rocm|out of memory|terminated|cuda error|illegal memory/i.test(lastAssistant.content);
  const lightModel = /e4b|e2b|:1b|:2b|:3b/i.test(model);
  const suggestSwitch = crashed && !lightModel && !suggestDismissed && !streaming;

  return (
    <div className="relative flex flex-col h-app-below-nav bg-[var(--bg)] md:pl-64">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-[var(--border-soft)]">
        <button
          onClick={() => { setListOpen((v) => !v); loadConvos(); }}
          className="md:hidden text-[var(--muted)] hover:text-white px-1.5 py-1 -ml-1 inline-flex items-center"
          title="Chats"
          aria-label="Chats"
        >
          <Menu size={18} />
        </button>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:block"><StatsGlance usage={usage} /></div>
          <button
            onClick={() => toggleModes(!webMode, docsMode)}
            title={webMode ? "Web grounding ON — replies use live search" : "Ground replies in live web search"}
            aria-label="Toggle web grounding"
            className={`p-1.5 border rounded-[var(--r-sm)] ${webMode ? "border-[var(--accent-ai)]/50 text-[var(--accent-ai)]" : "border-[var(--border)] text-[var(--muted)] hover:text-white"}`}
          >
            <Globe size={15} />
          </button>
          <button
            onClick={() => toggleModes(webMode, !docsMode)}
            title={docsMode ? "Doc grounding ON — replies use your documents" : "Ground replies in your uploaded documents"}
            aria-label="Toggle document grounding"
            className={`p-1.5 border rounded-[var(--r-sm)] ${docsMode ? "border-[var(--accent-ai)]/50 text-[var(--accent-ai)]" : "border-[var(--border)] text-[var(--muted)] hover:text-white"}`}
          >
            <FileText size={15} />
          </button>
          <button
            onClick={() => { stopSpeech(); setSpeakOn((v) => !v); }}
            title={speakOn ? "Reading replies aloud (tap to mute)" : "Read replies aloud"}
            aria-label="Toggle read-aloud"
            className={`p-1.5 border rounded-[var(--r-sm)] ${speakOn ? "border-[var(--accent-ai)]/50 text-[var(--accent-ai)]" : "border-[var(--border)] text-[var(--muted)] hover:text-white"}`}
          >
            {speakOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>
          <button
            onClick={() => setVoiceMode(true)}
            title="Voice mode (hands-free)"
            aria-label="Voice mode"
            className="p-1.5 border border-[var(--border)] rounded-[var(--r-sm)] text-[var(--muted)] hover:text-[var(--accent-ai)] hover:border-[var(--accent-ai)]/50"
          >
            <AudioLines size={15} />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            title="LLM settings"
            aria-label="LLM settings"
            className="text-[var(--muted)] hover:text-white p-1.5 border border-[var(--border)] rounded-[var(--r-sm)]"
          >
            <SlidersHorizontal size={15} />
          </button>
          <button
            onClick={handoffToCode}
            disabled={!convoId || streaming}
            title="Continue this chat in Code"
            aria-label="Continue this chat in Code"
            className="text-[var(--muted)] hover:text-[var(--accent-ai)] p-1.5 border border-[var(--border)] rounded-[var(--r-sm)] disabled:opacity-40"
          >
            <TerminalSquare size={15} />
          </button>
          <button
            onClick={stopAllAgents}
            title="Stop every active agent run"
            aria-label="Stop every active agent run"
            className="text-[var(--accent-danger)] hover:border-[var(--accent-danger)] p-1.5 border border-[var(--border)] rounded-[var(--r-sm)]"
          >
            <CircleStop size={15} />
          </button>
          <button
            onClick={newChat}
            disabled={streaming}
            className="text-xs text-[var(--muted)] hover:text-white px-2 py-1 disabled:opacity-40"
            title="New chat"
          >
            New
          </button>
        </div>
      </div>

      {copied && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 max-w-[90vw] text-center text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-1.5 shadow-[var(--shadow-bubble)]">
          {copied === "insecure" ? "Mic needs HTTPS — open the app via your Tailscale URL (https://main-pc…ts.net)"
            : copied === "micdenied" ? "Microphone permission denied — allow it in the browser"
            : copied === "nomic" ? "Can't access the microphone on this device/browser"
            : copied === "audioerr" ? "Couldn't process the recording"
            : copied === "handofferr" ? "Couldn't create the coding handoff"
            : copied === "chat" ? "Chat copied" : "Copied"}
        </div>
      )}

      {/* Conversations — persistent column on desktop, drawer on mobile */}
      {listOpen && <div className="md:hidden absolute inset-0 z-10 bg-black/40" onClick={() => setListOpen(false)} />}
      <div className={`${listOpen ? "flex" : "hidden"} md:flex absolute inset-y-0 left-0 z-20 w-64 max-w-[80vw] bg-[var(--surface-1)] border-r border-[var(--border)] flex-col`}>
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center justify-between px-3 h-12 border-b border-[var(--border-soft)]">
              <span className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">Chats</span>
              <div className="flex items-center gap-3">
                <button onClick={copyChat} disabled={!messages.length} title="Copy current chat" className="text-[var(--muted)] hover:text-white disabled:opacity-30"><Copy size={14} /></button>
                <button onClick={newChat} className="text-xs text-[var(--accent-ai)] hover:underline">+ New</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {convos.length === 0 && (
                <p className="text-xs text-[var(--muted)] text-center pt-6">No saved chats yet.</p>
              )}
              {convos.map((c) => (
                <div
                  key={c.id}
                  className={`group flex items-center gap-2 px-2.5 py-2 rounded-[var(--r-md)] cursor-pointer ${
                    c.id === convoId ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]"
                  }`}
                  onClick={() => openConvo(c.id)}
                >
                  <span className="flex-1 text-sm truncate">{c.title || "Untitled"}</span>
                  <span className="text-[10px] text-[var(--muted)] shrink-0">{ago(c.updatedAt)}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteConvo(c.id); }}
                    className="text-[var(--muted)] hover:text-[var(--accent-danger)] opacity-0 group-hover:opacity-100 shrink-0"
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto w-full px-3 py-6 space-y-6">
          {empty ? (
            <div className="pt-[12vh] flex flex-col items-center text-center animate-fade-in">
              <span className="w-10 h-10 rounded-full bg-[var(--accent-ai)]/15 text-[var(--accent-ai)] flex items-center justify-center mb-4"><Sparkles size={18} /></span>
              <p className="text-base font-medium">How can I help?</p>
              <p className="text-sm text-[var(--muted)] mt-1 mb-6">Your own local model. Toggle web or document grounding in the header.</p>
              <div className="w-full max-w-md grid gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="text-left text-sm text-[var(--muted)] hover:text-white border border-[var(--border)] hover:border-[var(--border-loud)] rounded-[var(--r-md)] px-3 py-2.5 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => {
              const isLast = i === messages.length - 1;
              if (m.role === "user") {
                if (editingIdx === i) {
                  return (
                    <div key={i} className="flex justify-end animate-msg-in">
                      <div className="w-full max-w-[85%]">
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={3}
                          autoFocus
                          className="w-full resize-y bg-[var(--surface-1)] border border-[var(--border-loud)] rounded-[var(--r-lg)] px-3.5 py-2 text-[15px] outline-none"
                        />
                        <div className="flex justify-end gap-2 mt-1">
                          <button onClick={cancelEdit} className="text-xs text-[var(--muted)] hover:text-white px-2 py-1">Cancel</button>
                          <button onClick={() => saveEdit(i)} className="text-xs font-semibold bg-white text-black px-3 py-1 rounded-[var(--r-sm)] hover:bg-zinc-200">Save &amp; resend</button>
                        </div>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={i} className="group flex justify-end items-center gap-1.5 animate-msg-in">
                    <div className={`flex flex-col gap-0.5 transition-opacity ${revealedIdx === i ? "opacity-100" : "opacity-0 pointer-events-none [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-hover:pointer-events-auto"}`}>
                      <button onClick={() => startEdit(i)} disabled={streaming} aria-label="Edit & resend" title="Edit & resend" className="p-1.5 text-[var(--muted)] hover:text-white disabled:opacity-30"><Pencil size={14} /></button>
                      <button onClick={() => copyText(m.content)} aria-label="Copy" title="Copy" className="p-1.5 text-[var(--muted)] hover:text-white"><Copy size={14} /></button>
                      <button onClick={() => deleteMessage(i)} disabled={streaming} aria-label="Delete" title="Delete" className="p-1.5 text-[var(--muted)] hover:text-[var(--accent-danger)] disabled:opacity-30"><Trash2 size={14} /></button>
                    </div>
                    <div {...longPress(i)} className="max-w-[85%] bg-[var(--surface-2)] text-white rounded-[var(--r-lg)] rounded-br-sm px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words shadow-[var(--shadow-bubble)] [@media(hover:none)]:select-none [-webkit-touch-callout:none]">
                      {m.images && m.images.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-1.5">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {m.images.map((src, j) => <img key={j} src={src} alt="attachment" className="h-20 w-20 object-cover rounded-[var(--r-sm)] border border-[var(--border)]" />)}
                        </div>
                      )}
                      {m.content}
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="group flex flex-col gap-1.5 animate-msg-in">
                  {m.status && <div className="text-xs text-[var(--accent-ai)] inline-flex items-center gap-1.5"><Brain size={13} />{m.status}</div>}
                  {m.thinking && (
                    <details open={isLast && streaming && !m.content} className="text-xs group">
                      <summary className="cursor-pointer select-none text-[var(--accent-ai)]/80 hover:text-[var(--accent-ai)] list-none flex items-center gap-1.5 transition-colors">
                        <Brain size={13} className="opacity-80" />
                        Thinking
                        {isLast && streaming && !m.content && (
                          <span className="inline-flex gap-0.5 ml-0.5">
                            <span className="thinking-dot">.</span>
                            <span className="thinking-dot" style={{ animationDelay: "0.2s" }}>.</span>
                            <span className="thinking-dot" style={{ animationDelay: "0.4s" }}>.</span>
                          </span>
                        )}
                      </summary>
                      <div className="mt-1.5 ml-1 pl-3 border-l-2 border-[var(--accent-ai)]/25 text-[var(--muted)] italic whitespace-pre-wrap break-words leading-relaxed">
                        {m.thinking}
                      </div>
                    </details>
                  )}
                  {m.visionModel && (
                    <span
                      title={m.visionModel === "gemma4:e4b" ? "5+ images in this turn — routed to the faster, smaller vision model" : "routed to the higher-quality vision model"}
                      className="self-start inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--muted)] border border-[var(--border)] rounded-full px-2 py-0.5 w-fit">
                      <Eye size={10} /> {m.visionModel === "gemma4:e4b" ? "fast" : "quality"} · {m.visionModel.replace("gemma4:", "")}
                    </span>
                  )}
                  <div {...longPress(i)} className="text-[15px] text-zinc-100 break-words leading-relaxed">
                    <AssistantContent text={m.content} priorHtml={priorArtifactAt(messages, i)} />
                    {isLast && streaming && (
                      <SignalTrace size="sm" className="ml-1 align-middle" />
                    )}
                  </div>
                  {!streaming && m.truncated && (
                    <button
                      onClick={() => continueMessage(i)}
                      className="self-start text-xs inline-flex items-center gap-1 border border-[var(--accent-ai)]/40 rounded-[var(--r-sm)] px-2.5 py-1 text-[var(--accent-ai)] hover:bg-[var(--accent-ai)]/10"
                    >
                      ↓ Continue
                    </button>
                  )}
                  {!(isLast && streaming) && (
                    <div className={`flex items-center gap-0.5 self-start transition-opacity ${revealedIdx === i ? "opacity-100" : "opacity-0 pointer-events-none [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-hover:pointer-events-auto"}`}>
                      <button onClick={() => copyText(m.content)} aria-label="Copy" title="Copy" className="p-1.5 -ml-1.5 text-[var(--muted)] hover:text-white"><Copy size={14} /></button>
                      <button onClick={() => deleteMessage(i)} aria-label="Delete" title="Delete" className="p-1.5 text-[var(--muted)] hover:text-[var(--accent-danger)]"><Trash2 size={14} /></button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <LlmSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        model={model}
        models={models}
        onModelChange={changeModel}
        think={think}
        onThinkChange={setThink}
      />

      {/* Voice mode — full-screen hands-free */}
      {voiceMode && (
        <div className="fixed inset-0 z-[60] bg-[var(--bg)] flex flex-col items-center justify-center gap-2 px-6 animate-fade-in">
          <button
            onClick={() => { setVoiceMode(false); stopSpeech(); if (listening) recogRef.current?.stop(); }}
            aria-label="Exit voice mode"
            className="absolute top-4 right-4 text-[var(--muted)] hover:text-white p-2"
          >
            <X size={22} />
          </button>

          <div
            onClick={() => {
              if (listening) { recogRef.current?.stop(); return; } // stop & send
              stopSpeech();                                        // interrupt the voice
              if (streaming) stop();                               // interrupt a reply in progress (server-side)
              startVoice();
            }}
            className="relative flex items-center justify-center w-60 h-60 select-none"
            role="button"
            aria-label={listening ? "Stop and send" : "Tap to talk or interrupt"}
          >
            {(listening || speakingText) && (
              <>
                <span className="absolute w-44 h-44 rounded-full bg-[var(--accent-ai)]/15 animate-ping" />
                <span className="absolute w-60 h-60 rounded-full border border-[var(--accent-ai)]/20 animate-pulse" />
              </>
            )}
            <div
              className={`w-32 h-32 rounded-full bg-gradient-to-br from-[var(--accent-ai)] to-[var(--accent-ai)]/30 shadow-[0_0_70px_-8px_var(--accent-ai)] flex items-center justify-center cursor-pointer transition-transform duration-300 ${
                listening ? "scale-110" : speakingText ? "scale-105 animate-pulse" : streaming ? "animate-pulse" : "hover:scale-105"
              }`}
            >
              <Mic size={40} className="text-white/90" />
            </div>
          </div>

          <p className="mt-6 text-sm text-[var(--muted)]">
            {listening ? "Listening… tap to send" : speakingText ? "" : streaming ? "Thinking…" : "Tap to talk"}
          </p>
          {speakingText && (
            <p className="max-w-md text-center text-[17px] leading-relaxed text-white px-4 animate-fade-in">
              {speakingText}
            </p>
          )}
          <button
            onClick={toggleBargeIn}
            className={`absolute top-4 left-4 px-2.5 py-1 rounded-full border text-[10px] uppercase tracking-wider transition-colors press ${
              bargeIn
                ? "border-[var(--accent-ai)] text-[var(--accent-ai)] bg-[var(--accent-ai)]/10"
                : "border-[var(--border-loud)] text-[var(--muted)]"
            }`}
            title="Experimental: talk over the voice to interrupt it (may echo-trigger on some devices)"
          >
            barge-in {bargeIn ? "on" : "off"}
          </button>
          <p className="absolute bottom-[max(1.5rem,env(safe-area-inset-bottom))] text-[11px] text-[var(--muted)]">
            Hands-free · speaks back with the SAM voice{bargeIn ? " · talk to interrupt" : ""}
          </p>
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 border-t border-[var(--border-soft)] bg-[var(--bg)] px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="max-w-4xl mx-auto">
          {suggestSwitch && (
            <div className="mb-2 flex items-center gap-2 text-xs border border-[var(--accent-warn)]/40 bg-[var(--accent-warn)]/10 rounded-[var(--r-md)] px-3 py-2">
              <span className="flex-1 text-[var(--text-2)]"><span className="font-medium">{model}</span> looks like it crashed the GPU — try lowering GPU layers in settings, or switch to a smaller model.</span>
              <button onClick={() => { setSettingsOpen(true); setSuggestDismissed(true); }} className="font-semibold text-[var(--accent-ai)] whitespace-nowrap">Settings</button>
              <button onClick={() => setSuggestDismissed(true)} className="text-[var(--muted)] hover:text-white">Dismiss</button>
            </div>
          )}
          {attached.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attached.map((a, i) => (
                <div key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.data} alt={a.name} className="h-14 w-14 object-cover rounded-[var(--r-sm)] border border-[var(--border)]" />
                  <button
                    onClick={() => setAttached((p) => p.filter((_, j) => j !== i))}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-black text-white border border-[var(--border-loud)] flex items-center justify-center"
                    aria-label="Remove"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={streaming}
              aria-label="Attach image"
              title="Attach image"
              className="shrink-0 w-10 h-10 rounded-full border border-[var(--border)] text-[var(--muted)] hover:text-white hover:border-[var(--border-loud)] flex items-center justify-center disabled:opacity-40"
            >
              <Paperclip size={17} />
            </button>
            <button
              onClick={startVoice}
              disabled={streaming}
              aria-label={listening ? "Stop listening" : "Voice input"}
              title={listening ? "Listening… tap to stop" : "Speak to it"}
              className={`shrink-0 w-10 h-10 rounded-full border flex items-center justify-center disabled:opacity-40 ${listening ? "border-[var(--accent-danger)] text-[var(--accent-danger)] animate-pulse" : "border-[var(--border)] text-[var(--muted)] hover:text-white hover:border-[var(--border-loud)]"}`}
            >
              <Mic size={17} />
            </button>
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoGrow(); }}
              onKeyDown={onKey}
              placeholder="Message…"
              rows={1}
              disabled={streaming}
              className="flex-1 resize-none bg-[var(--surface-1)] border border-[var(--border)] rounded-[var(--r-lg)] px-3.5 py-2.5 text-sm outline-none focus:border-[var(--border-loud)] disabled:opacity-50 leading-relaxed"
            />
            {streaming ? (
              <button
                onClick={stop}
                aria-label="Stop"
                title="Stop"
                className="shrink-0 w-10 h-10 rounded-full bg-white text-black flex items-center justify-center hover:bg-zinc-200 transition-colors"
              >
                <span className="block w-3 h-3 bg-black rounded-[2px]" />
              </button>
            ) : (
              <button
                onClick={() => send(input)}
                disabled={!input.trim() && attached.length === 0}
                aria-label="Send"
                className="shrink-0 w-10 h-10 rounded-full bg-white text-black font-bold flex items-center justify-center hover:bg-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                ↑
              </button>
            )}
          </div>
        </div>
        <p className="max-w-4xl mx-auto text-[10px] text-[var(--muted)] mt-1.5 px-1">
          Enter to send · Shift+Enter for new line.
        </p>
      </div>
    </div>
  );
}
