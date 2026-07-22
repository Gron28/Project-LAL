"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Download, FolderSearch, RefreshCw, Search, Square, Trash2 } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { ICON_SIZE } from "@/components/ui/icon";

type ContextProfile = {
  requestedTokens: number;
  activeTokens: number;
  verifiedTokens: number;
  modelMaxTokens: number | null;
  verification: string;
  reason?: string;
};
type ModelRuntimeSettings = {
  contextTokens: number;
  maxOutputTokens: number;
  gpuLayers: number | null;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  thinking: boolean;
  updatedAt: string | null;
};
type Model = { name: string; source: "local" | "ollama"; path: string; gb: number };
type ScanRoot = { kind: "gguf" | "ollama"; path: string; exists: boolean; readable: boolean; detail?: string };
type Inventory = {
  state: "loading" | "ready" | "empty" | "failed";
  models: Model[];
  current: string;
  scannedAt?: string;
  roots: ScanRoot[];
  diagnostics: string[];
  backend?: { serving: string | null; llamaServer: string; ollamaStore: string };
  server?: { origin: string; buildId: string };
};
type InventoryEnvelope = { inventory?: Inventory; contextProfiles?: Record<string, ContextProfile | null>; modelSettings?: Record<string, ModelRuntimeSettings>; settingsRevision?: string; error?: string };
type SearchResult = { id: string; revision: string; licenseName?: string };
type CandidateFile = { path: string; sizeBytes: number; sha256: string };
type DownloadJob = { id: string; state: string; progress: { phase: string; completed: number; total?: number }; error?: { message: string }; checkpoint?: { modelName?: string } };

const button = "inline-flex items-center justify-center gap-1.5 text-[11px] tracking-wide border border-[var(--border)] text-[var(--text-2)] rounded-[var(--r-md)] px-2.5 py-1.5 hover:border-[var(--border-loud)] hover:text-[var(--text)] disabled:opacity-40 disabled:cursor-not-allowed";
const input = "w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--border-loud)]";
const heading = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";

async function jsonResponse<T>(response: Response, subject: string): Promise<T> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error(`${subject} returned ${response.status} ${response.statusText || ""} instead of JSON. This usually means the Web service or build assets are stale.`.trim());
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || body?.detail || `${subject} failed with HTTP ${response.status}`);
  return body as T;
}

function tokens(value: number | null | undefined) { return value ? `${Math.round(value / 1024)}K` : "unknown"; }
function bytes(value: number) { return value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${Math.round(value / 1e6)} MB`; }

export default function ModelsPage() {
  const [inventory, setInventory] = useState<Inventory>({ state: "loading", models: [], current: "", roots: [], diagnostics: [] });
  const [profiles, setProfiles] = useState<Record<string, ContextProfile | null>>({});
  const [modelSettings, setModelSettings] = useState<Record<string, ModelRuntimeSettings>>({});
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState("");
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [files, setFiles] = useState<CandidateFile[]>([]);
  const [filePath, setFilePath] = useState("");
  const [localName, setLocalName] = useState("");
  const [license, setLicense] = useState("");
  const [accepted, setAccepted] = useState(false);
  const observedSucceededJobs = useRef(new Set<string>());

  const load = useCallback(async (rescan = false) => {
    setInventory((value) => ({ ...value, state: "loading" }));
    try {
      const response = await fetch("/api/agent/models", rescan ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "rescan" }) } : undefined);
      const body = await jsonResponse<InventoryEnvelope>(response, "Model inventory");
      if (!body.inventory) throw new Error("Model inventory response is missing its typed inventory snapshot.");
      setInventory(body.inventory);
      setProfiles(body.contextProfiles || {});
      setModelSettings(body.modelSettings || {});
      setStatus(rescan ? `Scan complete: ${body.inventory.models.length} model${body.inventory.models.length === 1 ? "" : "s"} found.` : "");
    } catch (error) {
      setInventory((value) => ({ ...value, state: "failed", models: [], diagnostics: [error instanceof Error ? error.message : String(error)] }));
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try { const body = await jsonResponse<{ jobs: DownloadJob[] }>(await fetch("/api/v1/model-acquisitions"), "Download jobs"); setJobs(body.jobs || []); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void loadJobs();
    const timer = window.setInterval(() => void loadJobs(), 2_000);
    return () => window.clearInterval(timer);
  }, [loadJobs]);

  useEffect(() => {
    const newlySucceeded = jobs.filter((job) => job.state === "succeeded" && !observedSucceededJobs.current.has(job.id));
    for (const job of jobs) if (job.state === "succeeded") observedSucceededJobs.current.add(job.id);
    if (newlySucceeded.length) void load();
  }, [jobs, load]);

  async function mutateModel(operation: "default" | "use" | "delete" | "probe", model: Model) {
    if (operation === "delete" && !window.confirm(`Delete ${model.name}?`)) return;
    setBusy(`${operation}:${model.name}`); setStatus("");
    try {
      const response = operation === "default"
        ? await fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultModel: model.name }) })
        : operation === "use"
        ? await fetch("/api/agent/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: model.name }) })
        : operation === "probe"
          ? await fetch("/api/agent/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: model.name }) })
          : await fetch(`/api/agent/models?name=${encodeURIComponent(model.name)}&source=${model.source}`, { method: "DELETE" });
      const body = await jsonResponse<{ contextProfile?: ContextProfile }>(response, `${operation} model`);
      if (body.contextProfile) setProfiles((value) => ({ ...value, [model.name]: body.contextProfile! }));
      setStatus(operation === "probe" ? `${model.name}: verified ${tokens(body.contextProfile?.verifiedTokens)} active context.` : `${model.name}: ${operation} completed.`);
      await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  }

  function editModelSettings(model: string, patch: Partial<ModelRuntimeSettings>) {
    setModelSettings((current) => current[model] ? ({ ...current, [model]: { ...current[model], ...patch } }) : current);
  }

  async function saveModelSettings(model: Model, patch?: Partial<ModelRuntimeSettings>) {
    const values = { ...modelSettings[model.name], ...(patch || {}) };
    setBusy(`settings:${model.name}`); setStatus("");
    try {
      const body = await jsonResponse<{ modelSettings: ModelRuntimeSettings }>(await fetch("/api/agent/models", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelSettings: { model: model.name, values } }),
      }), "Save model settings");
      setModelSettings((current) => ({ ...current, [model.name]: body.modelSettings }));
      setStatus(`${model.name}: settings synchronized for Web and CLI.`);
      await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  }

  async function search() {
    setBusy("search"); setStatus("Searching Hugging Face metadata…"); setResults([]); setFiles([]);
    try {
      const body = await jsonResponse<{ results: SearchResult[] }>(await fetch(`/api/v1/model-sources/huggingface?query=${encodeURIComponent(query)}`), "Hugging Face search");
      setResults(body.results || []); setStatus(`${body.results?.length || 0} GGUF repositories found. Select one to inspect exact files and hashes.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  }

  async function inspect(candidate: SearchResult) {
    setBusy(`inspect:${candidate.id}`); setSelected(candidate); setAccepted(false); setFiles([]); setStatus(`Inspecting pinned commit ${candidate.revision}…`);
    try {
      const body = await jsonResponse<{ model: { files: CandidateFile[]; license: { name: string } } }>(await fetch(`/api/v1/model-sources/huggingface?inspect=1&id=${encodeURIComponent(candidate.id)}&revision=${encodeURIComponent(candidate.revision)}`), "Model inspection");
      setFiles(body.model.files); setFilePath(body.model.files[0]?.path || ""); setLicense(body.model.license.name); setLocalName(candidate.id.split("/").pop()?.replace(/-gguf$/i, "").toLowerCase() || "");
      setStatus(`${body.model.files.length} verified GGUF candidate${body.model.files.length === 1 ? "" : "s"}. Choose a quantization and review the license.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  }

  async function download() {
    const file = files.find((candidate) => candidate.path === filePath);
    if (!selected || !file) return;
    setBusy("download"); setStatus("Creating verified download job…");
    try {
      const body = await jsonResponse<{ job: DownloadJob }>(await fetch("/api/v1/model-acquisitions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelName: localName, modelId: selected.id, revision: selected.revision, filePath: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes, licenseName: license, acceptedLicense: accepted }) }), "Model download");
      setStatus(`Download accepted as ${body.job.id}. Progress remains visible below.`); await loadJobs();
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  }

  async function cancel(job: DownloadJob) {
    try { await jsonResponse(await fetch(`/api/v1/model-acquisitions?id=${encodeURIComponent(job.id)}`, { method: "DELETE" }), "Cancel download"); await loadJobs(); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  }

  return <main className="min-h-dvh bg-[var(--bg)] text-[var(--text)] px-3 py-4 pb-20">
    <div className="max-w-6xl mx-auto flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-xl font-semibold">Models</h1><p className="mt-1 text-xs text-[var(--muted)]">Discover, download, verify, activate, and inspect local model runtimes.</p></div>
        <button className={button} onClick={() => void load(true)} disabled={inventory.state === "loading"}><RefreshCw size={ICON_SIZE.sm} className={inventory.state === "loading" ? "animate-spin" : ""} /> Rescan</button>
      </header>

      {inventory.state === "failed" && <Panel><div className="flex gap-3"><AlertTriangle className="text-[var(--accent-danger)] shrink-0" size={20} /><div><div className="text-sm font-medium">Model inventory failed</div>{inventory.diagnostics.map((item) => <p key={item} className="mt-1 text-xs text-[var(--muted)] break-all">{item}</p>)}<button className={`${button} mt-3`} onClick={() => void load(true)}>Try again</button></div></div></Panel>}
      {inventory.state === "empty" && <Panel><div className="text-center py-6"><FolderSearch className="mx-auto text-[var(--accent-ai)]" size={32} /><h2 className="mt-3 text-base font-medium">No usable models found yet</h2><p className="mt-2 text-xs text-[var(--muted)]">Search below to download a verified GGUF, or place a <code>*-q4.gguf</code> / <code>*-f16.gguf</code> file in one of the scanned folders.</p></div></Panel>}

      {inventory.state !== "failed" && <Panel padding="none">
        <div className={heading}><Cpu size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> INSTALLED MODELS <span className="ml-auto normal-case tracking-normal text-[var(--muted)]">{inventory.models.length} found</span></div>
        {inventory.state === "loading" ? <div className="p-6 text-xs text-[var(--muted)]">Scanning model roots…</div> : inventory.models.map((model) => {
          const profile = profiles[model.name];
          const settings = modelSettings[model.name];
          const isDefault = model.name === inventory.current;
          const isActive = model.name === inventory.backend?.serving;
          return <div key={`${model.source}:${model.name}`} className="px-4 py-4 border-b border-[var(--border-soft)] last:border-0 grid gap-3">
            <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm" style={{ color: isDefault ? "var(--accent-ai)" : undefined }}>{model.name}</span>{isDefault && <span className="text-[9px] border border-[var(--accent-ai)] text-[var(--accent-ai)] rounded-full px-1.5 py-0.5">DEFAULT</span>}{isActive && <span className="text-[9px] border border-[var(--accent-success)] text-[var(--accent-success)] rounded-full px-1.5 py-0.5">RESIDENT</span>}</div>
                <div className="mt-1 text-[10px] text-[var(--muted)]">{model.source} · {model.gb} GB · requested {tokens(profile?.requestedTokens)}, active {tokens(profile?.activeTokens)}, verified {tokens(profile?.verifiedTokens)}, native max {tokens(profile?.modelMaxTokens)}</div>
                {profile?.reason && <div className="mt-1 text-[10px] text-[var(--muted)]">{profile.reason}</div>}
              </div>
              <div className="flex flex-wrap gap-1.5">{!isDefault && <button className={button} disabled={!!busy} onClick={() => void mutateModel("default", model)}>Set default</button>}<button className={button} disabled={!!busy} onClick={() => void mutateModel("use", model)}>Load now</button><button className={button} disabled={!!busy} title="Probe 32K, 64K, and 128K context allocations with real inference" onClick={() => void mutateModel("probe", model)}>{busy === `probe:${model.name}` ? "Optimizing…" : "Optimize context"}</button>{model.source === "local" && <a className={button} href={`/api/download?model=${encodeURIComponent(model.name)}`}><Download size={12} /> Export</a>}<button className={button} disabled={!!busy} onClick={() => void mutateModel("delete", model)}><Trash2 size={12} /></button></div>
            </div>
            {settings && <div className="grid gap-3 rounded-[var(--r-md)] border border-[var(--border-soft)] bg-[var(--surface-2)] p-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="text-[10px] text-[var(--muted)]">Maximum context
                <input className={`${input} mt-1`} type="number" min={2048} max={profile?.modelMaxTokens ?? 1048576} step={1024} value={settings.contextTokens} onChange={(event) => editModelSettings(model.name, { contextTokens: Number(event.target.value) })} />
                <span className="mt-1 block">Tokens requested on the next load. Tested shortcuts:</span>
                <span className="mt-1 flex flex-wrap gap-1">{[32768, 65536, 100000, 131072].filter((value) => !profile?.modelMaxTokens || value <= profile.modelMaxTokens).map((value) => <button type="button" key={value} className={button} onClick={() => editModelSettings(model.name, { contextTokens: value })}>{tokens(value)}</button>)}</span>
              </label>
              <label className="text-[10px] text-[var(--muted)]">Temperature
                <input className={`${input} mt-1`} type="number" min={0} max={2} step={0.05} value={settings.temperature} onChange={(event) => editModelSettings(model.name, { temperature: Number(event.target.value) })} />
                <span className="mt-1 block">0 is deterministic; higher values add variation.</span>
              </label>
              <div className="text-[10px] text-[var(--muted)]">Thinking
                <button type="button" className={`${button} mt-1 w-full ${settings.thinking ? "border-[var(--accent-ai)] text-[var(--accent-ai)]" : ""}`} onClick={() => editModelSettings(model.name, { thinking: !settings.thinking })}>{settings.thinking ? "On" : "Off"}</button>
                <span className="mt-1 block">Default for Chat, Agent, and CLI requests.</span>
              </div>
              <div className="flex flex-col justify-between gap-2">
                <div className="grid grid-cols-2 gap-2 text-[10px] text-[var(--muted)]"><label>Top P<input className={`${input} mt-1`} type="number" min={0} max={1} step={0.05} value={settings.topP} onChange={(event) => editModelSettings(model.name, { topP: Number(event.target.value) })} /></label><label>Max output<input className={`${input} mt-1`} type="number" min={-1} step={1024} value={settings.maxOutputTokens} onChange={(event) => editModelSettings(model.name, { maxOutputTokens: Number(event.target.value) })} /></label></div>
                <button className={button} disabled={!!busy} onClick={() => void saveModelSettings(model)}>{busy === `settings:${model.name}` ? "Saving…" : "Save and sync"}</button>
              </div>
            </div>}
          </div>;
        })}
      </Panel>}

      <Panel padding="none">
        <div className={heading}><Search size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> FIND AND DOWNLOAD A GGUF</div>
        <div className="p-4 grid gap-3 text-xs">
          <p className="text-[var(--muted)]">Search reads Hugging Face metadata only. A transfer starts only after you select a pinned commit and exact SHA-256-addressed file, then accept its license.</p>
          <div className="flex gap-2"><input className={input} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void search(); }} placeholder="Try: Qwen 3 GGUF, Gemma GGUF, coding GGUF…" /><button className={button} disabled={query.trim().length < 2 || !!busy} onClick={() => void search()}><Search size={12} /> Search</button></div>
          {results.length > 0 && <div className="grid gap-1 sm:grid-cols-2">{results.map((candidate) => <button key={`${candidate.id}:${candidate.revision}`} className="text-left p-2 rounded border border-[var(--border)] hover:border-[var(--border-loud)]" onClick={() => void inspect(candidate)}><div>{candidate.id}</div><div className="mt-1 text-[10px] text-[var(--muted)]">commit {candidate.revision.slice(0, 12)} · {candidate.licenseName || "license inspect required"}</div></button>)}</div>}
          {selected && files.length > 0 && <div className="grid gap-2 border-t border-[var(--border-soft)] pt-3">
            <div className="grid gap-2 sm:grid-cols-2"><label>Local name<input className={`${input} mt-1`} value={localName} onChange={(event) => setLocalName(event.target.value)} /></label><label>Exact GGUF<select className={`${input} mt-1`} value={filePath} onChange={(event) => setFilePath(event.target.value)}>{files.map((file) => <option key={file.path} value={file.path}>{file.path} · {bytes(file.sizeBytes)}</option>)}</select></label></div>
            <div className="text-[10px] text-[var(--muted)] break-all">Pinned {selected.id}@{selected.revision}. SHA-256 {files.find((file) => file.path === filePath)?.sha256}</div>
            <label className="flex items-center gap-2"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> I reviewed and accept: {license}</label>
            <button className={`${button} justify-self-start`} disabled={!accepted || !localName.trim() || !!busy} onClick={() => void download()}><Download size={12} /> Download and verify</button>
          </div>}
          {status && <div className="text-[11px] text-[var(--text-2)]">{status}</div>}
        </div>
      </Panel>

      {jobs.length > 0 && <Panel padding="none"><div className={heading}><Download size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> DOWNLOAD JOBS</div>{jobs.slice(0, 20).map((job) => <div key={job.id} className="px-4 py-3 border-b border-[var(--border-soft)] last:border-0"><div className="flex items-center gap-2 text-xs">{job.state === "succeeded" ? <CheckCircle2 size={14} className="text-[var(--accent-success)]" /> : <Download size={14} className="text-[var(--accent-ai)]" />}<span className="truncate">{job.checkpoint?.modelName || job.id}</span><span className="ml-auto text-[10px] text-[var(--muted)]">{job.state} · {job.progress.phase}</span>{["queued", "running"].includes(job.state) && <button className={button} onClick={() => void cancel(job)}><Square size={10} /> Stop</button>}</div>{job.progress.total && <div className="mt-2 h-1 bg-[var(--surface-3)] rounded overflow-hidden"><div className="h-full bg-[var(--accent-ai)]" style={{ width: `${Math.min(100, job.progress.completed / job.progress.total * 100)}%` }} /></div>}{job.error && <div className="mt-1 text-[10px] text-[var(--accent-danger)]">{job.error.message}</div>}</div>)}</Panel>}

      <Panel padding="none"><div className={heading}><FolderSearch size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> DISCOVERY DIAGNOSTICS</div><div className="p-4 grid gap-2 text-[10px] text-[var(--muted)]">{inventory.roots.map((root) => <div key={root.path} className="flex gap-2"><span className={root.readable ? "text-[var(--accent-success)]" : "text-[var(--accent-danger)]"}>{root.exists ? root.readable ? "readable" : "blocked" : "not created"}</span><code className="break-all">{root.path}</code></div>)}{inventory.server && <div>Server {inventory.server.origin} · build {inventory.server.buildId} · scanned {inventory.scannedAt ? new Date(inventory.scannedAt).toLocaleString() : "not yet"}</div>}{inventory.backend && <div>llama.cpp {inventory.backend.llamaServer} · Ollama store {inventory.backend.ollamaStore} · resident {inventory.backend.serving || "none"}</div>}</div></Panel>
    </div>
  </main>;
}
