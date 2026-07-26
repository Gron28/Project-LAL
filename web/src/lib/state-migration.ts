import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { PlatformDirectories } from "./host-profile.ts";

export const MIGRATABLE_STATE_SEAMS = ["data", "state", "cache"] as const;
export type MigratableStateSeam = typeof MIGRATABLE_STATE_SEAMS[number];
export type MigrationAction = "copy" | "already-present" | "conflict" | "skip-symlink" | "missing-source";
export type StateMigrationEntry = Readonly<{ seam: MigratableStateSeam; relativePath: string; source: string; target: string; bytes: number; sha256?: string; action: MigrationAction; reason?: string }>;
export type StateMigrationDryRun = Readonly<{ mode: "dry-run"; entries: readonly StateMigrationEntry[]; totals: Readonly<Record<MigrationAction, number>>; bytesToCopy: number; conflicts: number }>;

function hashFile(file: string): string { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function inside(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)); }
function emptyTotals(): Record<MigrationAction, number> { return { copy: 0, "already-present": 0, conflict: 0, "skip-symlink": 0, "missing-source": 0 }; }
function scanSource(seam: MigratableStateSeam, sourceRoot: string, targetRoot: string, current: string, entries: StateMigrationEntry[]): void {
  const relativePath = path.relative(sourceRoot, current) || ".";
  const stat = fs.lstatSync(current);
  const target = path.resolve(targetRoot, relativePath);
  if (!inside(targetRoot, target)) throw new Error("state migration generated an unsafe target path");
  if (stat.isSymbolicLink()) { entries.push(Object.freeze({ seam, relativePath, source: current, target, bytes: 0, action: "skip-symlink", reason: "symlinks require an explicit, separately reviewed migration" })); return; }
  if (stat.isDirectory()) { for (const name of fs.readdirSync(current)) scanSource(seam, sourceRoot, targetRoot, path.join(current, name), entries); return; }
  if (!stat.isFile()) { entries.push(Object.freeze({ seam, relativePath, source: current, target, bytes: 0, action: "skip-symlink", reason: "non-regular files require an explicit migration" })); return; }
  const sha256 = hashFile(current);
  let action: MigrationAction = "copy";
  let reason: string | undefined;
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) { action = "conflict"; reason = "target exists but is not a regular file"; }
    else if (targetStat.size === stat.size && hashFile(target) === sha256) action = "already-present";
    else { action = "conflict"; reason = "target bytes differ; dry run will never overwrite"; }
  }
  entries.push(Object.freeze({ seam, relativePath, source: current, target, bytes: stat.size, sha256, action, ...(reason === undefined ? {} : { reason }) }));
}

/**
 * Read-only inventory for a seam-by-seam state migration. It never creates,
 * copies, overwrites, moves, or deletes anything. Callers must present this
 * result and obtain an explicit later apply operation.
 */
export function createStateMigrationDryRun(input: { sources: Partial<Record<MigratableStateSeam, string>>; destinations: Pick<PlatformDirectories, MigratableStateSeam> }): StateMigrationDryRun {
  const entries: StateMigrationEntry[] = [];
  for (const seam of MIGRATABLE_STATE_SEAMS) {
    const source = input.sources[seam];
    if (!source) continue;
    const sourceRoot = path.resolve(source);
    const targetRoot = path.resolve(input.destinations[seam]);
    if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(targetRoot)) throw new Error("state migration requires absolute source and destination roots");
    if (!fs.existsSync(sourceRoot)) { entries.push(Object.freeze({ seam, relativePath: ".", source: sourceRoot, target: targetRoot, bytes: 0, action: "missing-source", reason: "source root does not exist" })); continue; }
    const sourceStat = fs.lstatSync(sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) { entries.push(Object.freeze({ seam, relativePath: ".", source: sourceRoot, target: targetRoot, bytes: 0, action: "skip-symlink", reason: "source root must be a real directory" })); continue; }
    scanSource(seam, sourceRoot, targetRoot, sourceRoot, entries);
  }
  const totals = emptyTotals();
  let bytesToCopy = 0;
  for (const entry of entries) { totals[entry.action] += 1; if (entry.action === "copy") bytesToCopy += entry.bytes; }
  return Object.freeze({ mode: "dry-run", entries: Object.freeze(entries), totals: Object.freeze(totals), bytesToCopy, conflicts: totals.conflict });
}
