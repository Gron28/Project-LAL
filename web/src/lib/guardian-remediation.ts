import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { authorizeDefensiveAction, type DefensiveEngagement } from "./defensive-engagement.ts";

const QUARANTINE_DIR = path.join(process.cwd(), ".data", "guardian", "quarantine");
const LEDGER_FILE = path.join(QUARANTINE_DIR, "ledger.json");
export type GuardianQuarantineRecord = { id: string; operation: "quarantined" | "restored"; originalPath: string; quarantinePath: string; quarantinedAt: number; restoredAt: number | null; size: number; dev: number; ino: number; relatedId: string | null; previousHash: string; hash: string };
type QuarantineLedger = { version: 1; records: GuardianQuarantineRecord[] };
const stable = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort());
const digest = (value: unknown) => crypto.createHash("sha256").update(stable(value)).digest("hex");

function ledgerFile(directory?: string) { return directory ? path.join(directory, "ledger.json") : LEDGER_FILE; }
function read(file = LEDGER_FILE): QuarantineLedger {
  try { const ledger = JSON.parse(fs.readFileSync(file, "utf8")) as QuarantineLedger; return ledger.version === 1 && Array.isArray(ledger.records) ? ledger : { version: 1, records: [] }; } catch { return { version: 1, records: [] }; }
}
function verify(records: readonly GuardianQuarantineRecord[]) {
  let previousHash = "genesis";
  for (const record of records) { const { hash, ...base } = record; if (record.previousHash !== previousHash || hash !== digest(base)) return false; previousHash = hash; }
  return true;
}
function write(ledger: QuarantineLedger, file = LEDGER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ledger, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); fs.chmodSync(file, 0o600);
}
function localTarget(target: string): string | null {
  if (!target.startsWith("host:")) return null;
  const raw = target.slice("host:".length);
  if (!path.isAbsolute(raw) || raw === path.parse(raw).root) return null;
  try { const stat = fs.lstatSync(raw); return stat.isFile() && !stat.isSymbolicLink() ? fs.realpathSync(raw) : null; } catch { return null; }
}
function action(engagement: DefensiveEngagement, target: string, technique: "quarantine_file" | "restore_file", now: number, priorActions: number) {
  return authorizeDefensiveAction(engagement, { id: crypto.randomUUID(), target, technique, contactsTarget: false, mutatesTarget: true, approved: true, at: now }, priorActions);
}
export function readGuardianQuarantine(directory?: string): { records: GuardianQuarantineRecord[]; integrity: boolean } { const ledger = read(ledgerFile(directory)); return { records: [...ledger.records].reverse(), integrity: verify(ledger.records) }; }

/** Moves a specifically approved regular file into LAL's private quarantine.
 * A rename is atomic and reversible; cross-device copies are intentionally not
 * attempted, because copy/delete could leave the owner with ambiguous state. */
export function quarantineGuardianFile(input: { engagement: DefensiveEngagement; target: string; now?: number; directory?: string }): { state: "completed" | "blocked" | "failed"; record: GuardianQuarantineRecord | null; error: string | null } {
  const now = input.now ?? Date.now(), directory = input.directory ?? QUARANTINE_DIR, ledger = read(ledgerFile(directory));
  if (!verify(ledger.records)) return { state: "blocked", record: null, error: "quarantine ledger integrity failed" };
  const verdict = action(input.engagement, input.target, "quarantine_file", now, 0);
  if (!verdict.allowed) return { state: "blocked", record: null, error: verdict.reason || "quarantine is outside the engagement" };
  const source = localTarget(input.target);
  if (!source) return { state: "blocked", record: null, error: "target must be an existing non-root regular host file; symlinks are refused" };
  let stat: fs.Stats; try { stat = fs.statSync(source); } catch { return { state: "blocked", record: null, error: "target is not readable" }; }
  const id = `q_${crypto.randomUUID().replace(/-/g, "")}`, destination = path.join(directory, `${id}-${path.basename(source).replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.renameSync(source, destination); }
  catch (error) { return { state: "failed", record: null, error: error instanceof Error ? error.message : "quarantine move failed" }; }
  const base = { id, operation: "quarantined" as const, originalPath: source, quarantinePath: destination, quarantinedAt: now, restoredAt: null, size: stat.size, dev: stat.dev, ino: stat.ino, relatedId: null, previousHash: ledger.records.at(-1)?.hash ?? "genesis" };
  const record = { ...base, hash: digest(base) }; ledger.records.push(record); write(ledger, ledgerFile(directory)); return { state: "completed", record, error: null };
}
export function restoreGuardianFile(input: { engagement: DefensiveEngagement; id: string; now?: number; directory?: string }): { state: "completed" | "blocked" | "failed"; record: GuardianQuarantineRecord | null; error: string | null } {
  const now = input.now ?? Date.now(), directory = input.directory ?? QUARANTINE_DIR, ledger = read(ledgerFile(directory));
  if (!verify(ledger.records)) return { state: "blocked", record: null, error: "quarantine ledger integrity failed" };
  const record = ledger.records.find((entry) => entry.id === input.id && entry.operation === "quarantined");
  if (!record || ledger.records.some((entry) => entry.operation === "restored" && entry.relatedId === input.id)) return { state: "blocked", record: null, error: "quarantine record is not restorable" };
  const target = `host:${record.originalPath}`, verdict = action(input.engagement, target, "restore_file", now, 0);
  if (!verdict.allowed) return { state: "blocked", record: null, error: verdict.reason || "restore is outside the engagement" };
  if (fs.existsSync(record.originalPath)) return { state: "blocked", record: null, error: "original path now exists; refusing to overwrite it" };
  try { fs.renameSync(record.quarantinePath, record.originalPath); }
  catch (error) { return { state: "failed", record: null, error: error instanceof Error ? error.message : "restore move failed" }; }
  const original = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "hash")) as Omit<GuardianQuarantineRecord, "hash">;
  const base = { ...original, id: `r_${crypto.randomUUID().replace(/-/g, "")}`, operation: "restored" as const, restoredAt: now, relatedId: record.id, previousHash: ledger.records.at(-1)?.hash ?? "genesis" };
  const restored = { ...base, hash: digest(base) }; ledger.records.push(restored); write(ledger, ledgerFile(directory)); return { state: "completed", record: restored, error: null };
}
