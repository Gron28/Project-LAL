// Eviction policy for workspace/_deliberation/ run artifacts (open-inquiry-protocol.md
// Section 6). The 2026-07-14 disk-full incident made this section blocking: no data
// generation or training starts before it exists, and Layer A (deliberate.ts) must
// call it right after every run finishes writing.
//
// evictionPlan is the pure, deterministic core: given a run listing and options, it
// decides what survives, with no fs/model calls, so it's unit-testable with plain
// in-memory fixtures. listRunEntries/protectedRunNames/runRetention are the thin
// fs-touching wrappers around it — deliberate.ts only ever calls runRetention.
import fs from "node:fs";
import path from "node:path";

export type RunEntry = { name: string; path: string; mtimeMs: number; bytes: number };

export type RetentionOptions = {
  maxRuns?: number;             // keep at most this many non-protected runs, newest first (default 20)
  maxTotalBytes?: number;       // total size budget across every kept run (default 512 MiB)
  protectedNames?: Set<string>; // run dir names that must never be evicted (referenced by a dataset manifest)
};

export type EvictionReason = "recent" | "protected" | "size-budget";
export type RetentionPlan = {
  keep: RunEntry[];
  evict: RunEntry[];
  keptBytes: number;
  reasons: Record<string, EvictionReason>;
};

export const DEFAULT_MAX_RUNS = 20;
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export type RunLedgerEntry = { id: string; status: string; updatedAt: number; bytes: number };
export type RunLedgerRetentionOptions = { now?: number; maxAgeMs?: number; maxTotalBytes?: number };

export const DEFAULT_MAX_RUN_LEDGER_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_RUN_LEDGER_BYTES = 256 * 1024 * 1024;

// A run's metadata and NDJSON ledger are one paired resource. Live runs are
// never candidates; recoverable work is worth more than the size budget.
export function runLedgerEvictionPlan(entries: RunLedgerEntry[], opts: RunLedgerRetentionOptions = {}) {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_RUN_LEDGER_AGE_MS;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_RUN_LEDGER_BYTES;
  const terminal = entries.filter((entry) => entry.status !== "running");
  const live = entries.filter((entry) => entry.status === "running");
  const expired = terminal.filter((entry) => now - entry.updatedAt > maxAgeMs);
  const eligible = terminal.filter((entry) => now - entry.updatedAt <= maxAgeMs)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const keep = [...live];
  const evict = [...expired];
  let keptBytes = live.reduce((total, entry) => total + entry.bytes, 0);
  for (const entry of eligible) {
    if (keptBytes + entry.bytes <= maxTotalBytes) { keep.push(entry); keptBytes += entry.bytes; }
    else evict.push(entry);
  }
  return { keep, evict, keptBytes };
}

// Precedence: (1) protected runs always survive, unconditionally — a manifest that
// points at bytes retention silently deleted would corrupt provenance, which is worse
// than the disk cost of keeping a few extra runs; (2) among the rest, the maxRuns most
// recent survive the count gate; (3) the size budget is then enforced oldest-first
// against whatever survived (1)+(2), never touching a protected run.
export function evictionPlan(entries: RunEntry[], opts: RetentionOptions = {}): RetentionPlan {
  const maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const protectedNames = opts.protectedNames ?? new Set<string>();

  const newestFirst = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const reasons: Record<string, EvictionReason> = {};

  const protectedEntries = newestFirst.filter((e) => protectedNames.has(e.name));
  const unprotected = newestFirst.filter((e) => !protectedNames.has(e.name));
  for (const e of protectedEntries) reasons[e.name] = "protected";

  const recentSurvivors = unprotected.slice(0, maxRuns);
  for (const e of recentSurvivors) reasons[e.name] = "recent";
  const evictedByCount = unprotected.slice(maxRuns);

  // Size budget: walk survivors newest-first, keep while under budget; once the
  // budget is exceeded, everything remaining (the oldest of the survivors) is evicted
  // for size, protected entries excepted.
  const survivors = [...protectedEntries, ...recentSurvivors].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep: RunEntry[] = [];
  const evictedBySize: RunEntry[] = [];
  let total = 0;
  for (const e of survivors) {
    if (protectedNames.has(e.name)) { keep.push(e); total += e.bytes; continue; }
    if (total + e.bytes <= maxTotalBytes) { keep.push(e); total += e.bytes; }
    else { evictedBySize.push(e); reasons[e.name] = "size-budget"; }
  }

  return { keep, evict: [...evictedByCount, ...evictedBySize], keptBytes: total, reasons };
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(p);
    else { try { total += fs.statSync(p).size; } catch { /* raced deletion, ignore */ } }
  }
  return total;
}

// Lists immediate subdirectories of a `_deliberation` dir as run entries (one per
// timestamp-stamped run — see deliberate.ts's `path.join(project, "_deliberation", stamp)`).
export function listRunEntries(deliberationDir: string): RunEntry[] {
  if (!fs.existsSync(deliberationDir)) return [];
  const names = fs.readdirSync(deliberationDir).filter((name) => {
    try { return fs.statSync(path.join(deliberationDir, name)).isDirectory(); } catch { return false; }
  });
  return names.map((name) => {
    const p = path.join(deliberationDir, name);
    const st = fs.statSync(p);
    return { name, path: p, mtimeMs: st.mtimeMs, bytes: dirSizeBytes(p) };
  });
}

const DEFAULT_MANIFEST_DIR = path.join(process.cwd(), ".data", "hive", "datasets");

// Scans dataset manifests (web/src/lib/hive/provenance.ts's DatasetManifest JSON files)
// for any reference to a `_deliberation/<run-name>` path and protects that run name.
// Deliberately a text scan rather than a typed field walk: DatasetManifest doesn't (yet)
// carry a dedicated "source run" field, and any current or future place a manifest might
// embed a deliberation artifact path (sourcePath, an example's provenance string, a
// generator tag) is covered without needing to keep this in lockstep with that schema.
export function protectedRunNames(manifestDir: string = DEFAULT_MANIFEST_DIR): Set<string> {
  const names = new Set<string>();
  if (!fs.existsSync(manifestDir)) return names;
  let files: string[];
  try { files = fs.readdirSync(manifestDir).filter((f) => f.endsWith(".json")); } catch { return names; }
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(path.join(manifestDir, file), "utf8"); } catch { continue; }
    for (const m of text.matchAll(/_deliberation[/\\]([^"'\\/\s]+)/g)) names.add(m[1]);
  }
  return names;
}

export type RunRetentionResult = { evicted: string[]; kept: number; keptBytes: number };

// The one fs-mutating entry point. Never throws — a retention failure must not turn
// a successful deliberation into a reported error; best-effort per-directory removal.
export function runRetention(deliberationDir: string, opts: RetentionOptions = {}): RunRetentionResult {
  const entries = listRunEntries(deliberationDir);
  const protectedNames = opts.protectedNames ?? protectedRunNames();
  const plan = evictionPlan(entries, { ...opts, protectedNames });
  const evicted: string[] = [];
  for (const e of plan.evict) {
    try { fs.rmSync(e.path, { recursive: true, force: true }); evicted.push(e.name); } catch { /* best-effort */ }
  }
  return { evicted, kept: plan.keep.length, keptBytes: plan.keptBytes };
}
