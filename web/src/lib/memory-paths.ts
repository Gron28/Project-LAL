// Shared directory conventions for the agent's memory system (Phases 2-6 of the
// memory/delegation plan). Two deliberately separate trees:
//
//   <project-root>/.agent-memory/*.md        — small, always-injected core-memory
//                                               blocks (Phase 3). Lives WITH the repo
//                                               since these are project-standing facts.
//   .data/agent-memory/{sessions,daily,digest}/<slug>/...  — the larger, retrieved-
//                                               on-demand corpus (Phase 5). Lives at the
//                                               app level, mirrors .data/conversations/,
//                                               keyed by a slug so multiple projects
//                                               don't collide.
//
// Don't let these two collapse into one — core-memory blocks are cross-session
// standing knowledge; the sessions/daily/digest tree is retrieved history.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const APP_DATA = path.join(process.cwd(), ".data", "agent-memory");

// Filesystem-safe, human-glanceable, and collision-proof: the sanitized basename plus
// a short hash of the full path (two different projects that happen to share a
// basename after sanitizing must not collide).
export function projectSlug(root: string): string {
  const base = path.basename(root).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "project";
  const hash = crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function projectMemoryDir(root: string): string {
  return ensureDir(path.join(root, ".agent-memory"));
}

export function appMemoryDir(kind: "sessions" | "daily" | "digest", root: string): string {
  return ensureDir(path.join(APP_DATA, kind, projectSlug(root)));
}
