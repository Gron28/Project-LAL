#!/usr/bin/env node
// PLAN 2.2 — "one registry is the only source of tool identity".
//
// Until that refactor lands, the gateway keeps its own allowlist
// (LAL_TERMINAL_TOOLS in the chat-completions route) and the CLI keeps the real
// tool names. Two hand-maintained lists of the same thing drift, and the drift
// is silent in the worst possible direction: the gateway drops any advertised
// tool whose name it does not recognise, leaving the model holding a capability
// list nobody told it about, which is the leading hypothesis for the Windows
// report of `'agent' is not recognized as a command`.
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
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GATEWAY_ROUTE =
  'web/src/app/api/llm/v1/chat/completions/route.ts';
// Every file that declares canonical tool names the CLI can actually register.
const NAME_SOURCES = [
  'apps/cli/packages/core/src/tools/tool-names.ts',
  'apps/cli/packages/core/src/tools/computer-use/schemas.ts',
];

function read(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) throw new Error(`missing ${relativePath}`);
  return fs.readFileSync(absolute, 'utf8');
}

function parseAllowlist(source) {
  const start = source.indexOf('LAL_TERMINAL_TOOLS = new Set([');
  if (start === -1) {
    throw new Error(`${GATEWAY_ROUTE}: LAL_TERMINAL_TOOLS not found`);
  }
  const end = source.indexOf(']);', start);
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

function collectKnownNames() {
  const known = new Set();
  for (const relativePath of NAME_SOURCES) {
    for (const match of read(relativePath).matchAll(/["']([a-z0-9_]+)["']/g)) {
      known.add(match[1]);
    }
  }
  return known;
}

try {
  const allowlist = parseAllowlist(read(GATEWAY_ROUTE));
  if (allowlist.length === 0) {
    throw new Error(`${GATEWAY_ROUTE}: parsed an empty allowlist`);
  }
  const known = collectKnownNames();
  const unresolvable = allowlist.filter((name) => !known.has(name));

  const duplicates = allowlist.filter(
    (name, index) => allowlist.indexOf(name) !== index,
  );

  const problems = [];
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
  if (problems.length > 0) throw new Error(problems.join('\n  '));

  console.log(
    `tool allowlist: ${allowlist.length} entries, all resolvable against ` +
      `${NAME_SOURCES.length} name sources`,
  );
} catch (error) {
  console.error(`tool allowlist drift: ${error.message}`);
  process.exit(1);
}
