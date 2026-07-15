#!/usr/bin/env node
// Drift check for the LAL run-stream event protocol.
//
// web/src/lib/protocol/index.ts is the source of truth for every event kind that can
// appear on an agent run's SSE stream (see that file's header for the compatibility
// rule). apps/cli/packages/core/src/lal/protocol.ts is a self-contained mirror of it (no
// imports from web/) so the CLI fork can typecheck against the same shapes without
// depending on the Next.js app.
//
// This script REGENERATES the mirror from the three web source files it's assembled
// from (protocol/index.ts, toolloop.ts, deliberate.ts) and either:
//   - writes it to the CLI path (--write), or
//   - diffs the regenerated text against what's on disk and exits nonzero on drift
//     (default — this is the CI-safe mode).
//
// Usage:
//   node scripts/check_protocol_drift.mjs          # check (exits 1 on drift)
//   node scripts/check_protocol_drift.mjs --write  # regenerate the mirror in place
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TOOLLOOP_PATH = path.join(ROOT, "web/src/lib/toolloop.ts");
const DELIBERATE_PATH = path.join(ROOT, "web/src/lib/deliberate.ts");
const RUNS_PATH = path.join(ROOT, "web/src/lib/runs.ts");
const PROTOCOL_PATH = path.join(ROOT, "web/src/lib/protocol/index.ts");
const MIRROR_PATH = path.join(ROOT, "apps/cli/packages/core/src/lal/protocol.ts");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

// Extracts a top-level `export type NAME = ...;` or `export const NAME = ...;`
// declaration by bracket-depth scanning from its `marker` (rather than a regex guess at
// where the statement ends) — robust to the declaration spanning multiple lines with
// nested braces, as the event unions do.
function extractDecl(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${JSON.stringify(marker)}`);
  let i = start;
  let depth = 0;
  let opened = false;
  for (; i < src.length; i++) {
    const c = src[i];
    // Skip `//` line comments and `/* */` block comments untouched — this file's event
    // unions carry a lot of prose commentary, and a stray `;` or bracket inside a comment
    // must never be mistaken for a syntactic terminator.
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") { depth++; opened = true; }
    else if (c === "}" || c === "]" || c === ")") { depth--; }
    else if (c === ";" && (!opened || depth <= 0)) { i++; break; }
  }
  if (i >= src.length) throw new Error(`unterminated declaration: ${JSON.stringify(marker)}`);
  return src.slice(start, i).trim();
}

function generateMirror() {
  const toolloopSrc = read(TOOLLOOP_PATH);
  const deliberateSrc = read(DELIBERATE_PATH);
  const runsSrc = read(RUNS_PATH);
  const protocolSrc = read(PROTOCOL_PATH);

  const toolLoopEvent = extractDecl(toolloopSrc, "export type ToolLoopEvent =");
  // DeliberateEvent's `roles` field is typed `Role[]`, a small supporting alias defined
  // alongside it in deliberate.ts — inline it too so the mirror stays import-free.
  const role = extractDecl(deliberateSrc, "export type Role =");
  const deliberateEvent = extractDecl(deliberateSrc, "export type DeliberateEvent =");
  // RunEnvelopeEvent's `status` field is typed `RunStatus`, defined in runs.ts — inline it
  // for the same reason.
  const runStatus = extractDecl(runsSrc, "export type RunStatus =");

  const protocolVersion = extractDecl(protocolSrc, "export const PROTOCOL_VERSION =");
  const handshake = extractDecl(protocolSrc, "export type ProtocolHandshakeEvent =");
  const runEnvelope = extractDecl(protocolSrc, "export type RunEnvelopeEvent =");
  const hiveWorkflow = extractDecl(protocolSrc, "export type HiveWorkflowEvent =");
  const hiveTagged = extractDecl(protocolSrc, "export type HiveTaggedToolLoopEvent =");
  const additionalRoute = extractDecl(protocolSrc, "export type AdditionalRouteEvent =");
  const knownKinds = extractDecl(protocolSrc, "export const KNOWN_EVENT_KINDS =");

  return `// GENERATED / MIRRORED FILE — do not hand-edit the declarations below.
//
// Mirrored from web/src/lib/protocol/index.ts (the source of truth — read its header for
// the full compatibility rule) by scripts/check_protocol_drift.mjs. Self-contained: no
// imports from web/, so the CLI fork can typecheck against these shapes standalone.
//
// Compatibility rule, summarized (see web/src/lib/protocol/index.ts for the full text):
//   - a new event kind is a minor change — clients must ignore unknown kinds.
//   - a shape change to an existing kind is a version bump (PROTOCOL_VERSION).
//   - no new event kind may be added anywhere except through web/src/lib/protocol/.
//
// To update this file after changing web/src/lib/protocol/index.ts, web/src/lib/toolloop.ts,
// or web/src/lib/deliberate.ts:
//   node scripts/check_protocol_drift.mjs --write
// CI / pre-flight check (no write, exits nonzero on drift):
//   node scripts/check_protocol_drift.mjs

${protocolVersion}

${handshake}

${toolLoopEvent}

${role}

${deliberateEvent}

${runStatus}

${runEnvelope}

${hiveWorkflow}

${hiveTagged}

${additionalRoute}

export type ProtocolEvent =
  | ProtocolHandshakeEvent
  | RunEnvelopeEvent
  | ToolLoopEvent
  | DeliberateEvent
  | HiveWorkflowEvent
  | HiveTaggedToolLoopEvent
  | AdditionalRouteEvent;

${knownKinds}

export function isKnownEventKind(k: string): boolean {
  return KNOWN_EVENT_KINDS.has(k);
}
`;
}

function normalize(s) {
  return s.replace(/\r\n/g, "\n").trimEnd() + "\n";
}

function hash(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function main() {
  const write = process.argv.includes("--write");
  const generated = normalize(generateMirror());

  if (write) {
    fs.mkdirSync(path.dirname(MIRROR_PATH), { recursive: true });
    fs.writeFileSync(MIRROR_PATH, generated);
    console.log(`wrote ${path.relative(ROOT, MIRROR_PATH)} (${hash(generated)})`);
    return;
  }

  let onDisk;
  try {
    onDisk = normalize(read(MIRROR_PATH));
  } catch {
    console.error(`protocol drift: ${path.relative(ROOT, MIRROR_PATH)} does not exist.`);
    console.error(`Run: node scripts/check_protocol_drift.mjs --write`);
    process.exit(1);
  }

  if (onDisk !== generated) {
    console.error(`protocol drift detected between web/src/lib/protocol/ and ${path.relative(ROOT, MIRROR_PATH)}.`);
    console.error(`  on-disk hash:    ${hash(onDisk)}`);
    console.error(`  generated hash:  ${hash(generated)}`);
    console.error(`Run: node scripts/check_protocol_drift.mjs --write   (then review + commit the diff)`);
    process.exit(1);
  }

  console.log(`protocol mirror OK — ${path.relative(ROOT, MIRROR_PATH)} matches web/src/lib/protocol/ (${hash(generated)})`);
}

main();
