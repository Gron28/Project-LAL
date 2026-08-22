"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Code2, TerminalSquare } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { ICON_SIZE } from "@/components/ui/icon";
import { LabNav } from "@/components/lab-nav";

const input = "w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--border-loud)]";
const button = "min-h-10 inline-flex items-center justify-center gap-1.5 text-[11px] tracking-wide border border-[var(--border)] text-[var(--text-2)] rounded-[var(--r-md)] px-3 py-2 hover:border-[var(--border-loud)] hover:text-[var(--text)] disabled:opacity-40";
const heading = "px-4 py-3 border-b border-[var(--border-soft)] text-[11px] tracking-widest uppercase text-[var(--text-2)] flex items-center gap-2";

type CliSettings = Record<string, unknown>;

function numberValue(settings: CliSettings, key: string, fallback: number) {
  return typeof settings[key] === "number" ? settings[key] as number : fallback;
}

function boolValue(settings: CliSettings, key: string, fallback: boolean) {
  return typeof settings[key] === "boolean" ? settings[key] as boolean : fallback;
}

export default function CliPage() {
  const [settings, setSettings] = useState<CliSettings>({});
  const [advanced, setAdvanced] = useState("{}");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [advancedError, setAdvancedError] = useState("");

  useEffect(() => {
    fetch("/api/cli/settings", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not load CLI settings");
        setSettings(body.cliSettings || {});
        setAdvanced(JSON.stringify(body.cliSettings || {}, null, 2));
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, []);

  function update(key: string, value: unknown) {
    setSettings((current) => ({ ...current, [key]: value }));
    setAdvancedError("");
  }

  async function save(next: CliSettings = settings) {
    setBusy(true); setStatus("");
    try {
      const response = await fetch("/api/cli/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cliSettings: next }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not save CLI settings");
      setSettings(body.cliSettings || {});
      setAdvanced(JSON.stringify(body.cliSettings || {}, null, 2));
      setStatus("CLI settings saved. Paired terminals pick them up on their next sync.");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function saveAdvanced() {
    try {
      const parsed = JSON.parse(advanced);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Use a JSON object at the top level.");
      setAdvancedError("");
      void save(parsed as CliSettings);
    } catch (error) { setAdvancedError(error instanceof Error ? error.message : String(error)); }
  }

  return <main id="main-content" className="page-shell text-[var(--text)]">
    <div className="page-frame max-w-6xl flex flex-col gap-4">
      <LabNav />
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2"><TerminalSquare size={20} className="text-[var(--accent-ai)]" /> CLI settings</h1>
        <p className="mt-1 text-xs text-[var(--muted)]">Configure the paired terminal agent from the WebUI. These values are stored on this host and synchronized to connected CLI sessions.</p>
      </div>

      <Panel padding="none"><div className={heading}><TerminalSquare size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> RUN CONTROL</div>
        <div className="p-4 grid gap-4 text-[10px] text-[var(--muted)] md:grid-cols-2 xl:grid-cols-4">
          <label>Maximum session turns<input className={`${input} mt-1`} type="number" min={-1} value={numberValue(settings, "maxSessionTurns", -1)} onChange={(event) => update("maxSessionTurns", Number(event.target.value))} /><span className="mt-1 block">-1 means unlimited.</span></label>
          <label>Maximum tool calls per turn<input className={`${input} mt-1`} type="number" min={-1} value={numberValue(settings, "maxToolCallsPerTurn", -1)} onChange={(event) => update("maxToolCallsPerTurn", Number(event.target.value))} /><span className="mt-1 block">-1 disables the cap.</span></label>
          <label>Shell timeout (ms)<input className={`${input} mt-1`} type="number" min={0} value={numberValue(settings, "shellDefaultTimeoutMs", 600000)} onChange={(event) => update("shellDefaultTimeoutMs", Number(event.target.value))} /></label>
          <div><span>Skip broad loop heuristics</span><button type="button" className={`${button} mt-1 w-full ${boolValue(settings, "skipLoopDetection", true) ? "border-[var(--accent-ai)] text-[var(--accent-ai)]" : ""}`} onClick={() => update("skipLoopDetection", !boolValue(settings, "skipLoopDetection", true))}>{boolValue(settings, "skipLoopDetection", true) ? "On" : "Off"}</button><span className="mt-1 block">Exact repeats and provider safety limits remain separate.</span></div>
          <div className="md:col-span-2 xl:col-span-4"><button className={button} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save run control"}</button></div>
        </div>
      </Panel>

      <Panel padding="none"><div className={heading}><Code2 size={ICON_SIZE.sm} className="text-[var(--accent-ai)]" /> ADVANCED CLI JSON</div>
        <div className="p-4 grid gap-3 text-xs"><p className="text-[var(--muted)]">Use this for any other CLI setting supported by its settings schema. The host-managed model catalog, provider credentials, and tool policy cannot be overridden here.</p><textarea aria-label="Advanced CLI settings JSON" className={`${input} min-h-96 font-mono text-[11px]`} value={advanced} onChange={(event) => { setAdvanced(event.target.value); setAdvancedError(""); }} spellCheck={false} />
          {advancedError && <p className="text-[var(--accent-danger)]">{advancedError}</p>}
          <div className="flex flex-wrap items-center gap-2"><button className={button} disabled={busy} onClick={saveAdvanced}>{busy ? "Saving…" : "Save advanced settings"}</button>{status && <span className="text-[11px] text-[var(--text-2)] flex items-center gap-1"><CheckCircle2 size={13} className="text-[var(--accent-success)]" />{status}</span>}</div>
        </div>
      </Panel>
    </div>
  </main>;
}
