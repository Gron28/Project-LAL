#!/usr/bin/env node
// Copy packages/protocol into web/node_modules/@lal/protocol.
//
// Why a copy and not a link: `@lal/protocol` is declared as a `file:`
// dependency, and npm resolves those by copying on some installs. A symlink is
// the obvious fix and does not work here — Turbopack cannot resolve a module
// outside the project root, so `next build` fails with "Can't resolve
// '@lal/protocol'" the moment the directory becomes a link.
//
// So the copy stays, and this makes it deterministic. A stale copy is the
// dangerous state: the gateway would enforce the tool allowlist (PLAN 2.2) from
// whenever the copy was last made, which is exactly the drift a single registry
// exists to end — and it fails silently, because a stale copy compiles fine.
//
// Runs from web's `prebuild`/`predev` and from scripts/rebuild-local-ai-lab.sh.
// Pure Node, no shell: it has to work identically on Windows.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "protocol");
const target = path.join(root, "web", "node_modules", "@lal", "protocol");

if (!fs.existsSync(source)) {
  console.error(`[sync-protocol] missing ${source}`);
  process.exit(1);
}

// Remove the whole target first. Copying over it leaves behind files that were
// DELETED from the source — a removed module keeps resolving from the stale copy,
// which is the same silent-wrongness this script exists to prevent, just
// inverted. Also disposes of a previous manual symlink.
try {
  fs.rmSync(target, { recursive: true, force: true });
} catch {
  // Not present at all — the normal first-install case.
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, {
  recursive: true,
  // Never copy the dependency's own node_modules or build output into a
  // node_modules subtree; it has none today and this keeps it that way.
  filter: (entry) => !/node_modules|[\\/]\.git([\\/]|$)/.test(entry),
});

const files = fs
  .readdirSync(path.join(target, "src"))
  .filter((f) => f.endsWith(".ts"));
console.log(`[sync-protocol] synced ${files.length} source file(s): ${files.join(", ")}`);
