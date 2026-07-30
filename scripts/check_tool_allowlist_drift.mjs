#!/usr/bin/env node
// PLAN 2.2 — "one registry is the only source of tool identity".
//
// The registry now exists: `packages/protocol/src/index.ts` declares the terminal
// allowlist and the computer-use prefix rule ONCE, and the gateway imports it, so
// the two-hand-maintained-lists failure mode is gone by construction.
//
// What this check still guards is the direction a single registry cannot fix on
// its own: a name in the registry that resolves to no real tool. That admits
// nothing while reading as though the capability existed — how "screenshot" sat
// in the allowlist for months (found here 2026-07-24; screen capture is actually
// delivered by get_window_state's PNG).
//
// Found by this check on first run (2026-07-24): "screenshot" was in the
// allowlist and is not a tool. It is delivered by get_window_state's PNG.
//
// This guards the direction that actually breaks the product — a name in the
// allowlist that resolves to nothing. It deliberately does NOT require the
// reverse (every tool present in the allowlist): the allowlist is a product
// boundary and excluding tools is its job.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The one registry (PLAN 2.2). Previously the gateway route's inline copy.
const GATEWAY_ROUTE = 'packages/protocol/src/index.ts';
// Every file that declares canonical tool names the CLI can actually register.
const NAME_SOURCES = ['apps/cli/packages/core/src/tools/tool-names.ts'];

function read(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) throw new Error(`missing ${relativePath}`);
  return fs.readFileSync(absolute, 'utf8');
}

export function parseAllowlist(source) {
  const start = source.indexOf('LAL_TERMINAL_TOOLS: readonly string[] = [');
  if (start === -1) {
    throw new Error(`${GATEWAY_ROUTE}: LAL_TERMINAL_TOOLS not found`);
  }
  const end = source.indexOf('];', start);
  if (end === -1) {
    throw new Error(`${GATEWAY_ROUTE}: LAL_TERMINAL_TOOLS is unterminated`);
  }
  const body = source.slice(start, end);
  // Strip comments first: the block is heavily commented and the prose mentions
  // tool names that are not entries.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return [...code.matchAll(/["']([a-z0-9_]+)["']/g)].map((m) => m[1]);
}

export function collectKnownNames() {
  const known = new Set();
  for (const relativePath of NAME_SOURCES) {
    for (const match of read(relativePath).matchAll(/["']([a-z0-9_]+)["']/g)) {
      known.add(match[1]);
    }
  }
  return known;
}

export function allowlistProblems(allowlist, known) {
  const problems = [];
  const unresolvable = allowlist.filter((name) => !known.has(name));
  const duplicates = allowlist.filter(
    (name, index) => allowlist.indexOf(name) !== index,
  );

  if (unresolvable.length > 0) {
    problems.push(
      `${GATEWAY_ROUTE} allows ${unresolvable.length} name(s) that are not ` +
        `declared in any tool-name source: ${unresolvable.join(', ')}.\n` +
        `    Either correct the spelling or drop the entry — an allowlist entry ` +
        `that matches no tool admits nothing and hides the real gap.`,
    );
  }
  if (duplicates.length > 0) {
    problems.push(`duplicate allowlist entries: ${duplicates.join(', ')}`);
  }
  return problems;
}

export function checkCurrentAllowlist() {
  const allowlist = parseAllowlist(read(GATEWAY_ROUTE));
  if (allowlist.length === 0) {
    throw new Error(`${GATEWAY_ROUTE}: parsed an empty allowlist`);
  }
  const known = collectKnownNames();
  const problems = allowlistProblems(allowlist, known);
  if (problems.length > 0) throw new Error(problems.join('\n  '));

  return { allowlist, sources: NAME_SOURCES.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = checkCurrentAllowlist();
    console.log(
      `tool allowlist: ${result.allowlist.length} entries, all resolvable ` +
        `against ${result.sources} name source(s)`,
    );
  } catch (error) {
    console.error(`tool allowlist drift: ${error.message}`);
    process.exit(1);
  }
}
