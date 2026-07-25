#!/usr/bin/env node
// PLAN 2.1, hypothesis 2 — as a check instead of a hypothesis.
//
// The plan wrote it down on 2026-07-24: "the model chooses run_shell_command on
// its own because a tool it was told about in the system prompt is absent from
// the actual payload (the prompt and the allowlist are separately maintained —
// verify they agree)". Nobody verified. On 2026-07-25 that exact drift cost two
// full research sessions: `web_search` and `web_fetch` were registered with
// `shouldDefer: true`, which hides a tool until `tool_search` reveals it, while
// the system prompt instructed the model to use them by name. Told to use a tool
// it could not see, the model passed the name to the shell.
//
// The failure is silent in the worst way. Nothing throws. No test fails. The only
// symptom is a model that "keeps using the shell wrong", which reads as a bad
// model rather than a bad tool list.
//
// So this makes the agreement mechanical: a tool named imperatively in a prompt
// must not be deferred. Runs in `npm test`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = path.join(root, 'apps/cli/packages/core/src/tools');

// Files that build the model-facing system prompt, plus the injected controller
// instructions. Anything here that names a tool is a promise to the model.
const PROMPT_SOURCES = [
  'apps/cli/packages/core/src/core/prompts.ts',
  'apps/cli/packages/core/src/services/research-controller.ts',
  'apps/cli/packages/core/src/subagents/builtin-agents.ts',
  'apps/cli/packages/core/src/agents/team/promptAddendum.ts',
];

/**
 * Read every tool's `shouldDefer` flag.
 *
 * `shouldDefer` is the 8th positional argument to BaseDeclarativeTool's
 * constructor, which cannot be parsed reliably by regex. Instead each tool file
 * is matched for an explicit `shouldDefer` marker — the codebase comments the
 * argument in every case — and falls back to the positional literal block when it
 * does not. Ambiguity is reported, never assumed to be false: a tool this script
 * cannot classify is exactly the case that hid for months.
 */
function deferredTools() {
  const deferred = new Set();
  const unknown = [];
  for (const file of fs.readdirSync(TOOLS_DIR)) {
    if (!file.endsWith('.ts') || /\.test\.ts$/.test(file)) continue;
    const source = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf8');
    // The tool's registered name, e.g. `static readonly Name = 'web_search'` or
    // `ToolNames.WEB_SEARCH`.
    const nameMatch =
      /static\s+(?:readonly\s+)?Name\s*(?::\s*string\s*)?=\s*['"]([a-z0-9_]+)['"]/i.exec(
        source,
      ) ?? /static\s+(?:readonly\s+)?Name\s*=\s*ToolNames\.([A-Z0-9_]+)/.exec(source);
    if (!nameMatch) continue;
    const toolName = nameMatch[1].includes('_')
      ? nameMatch[1].toLowerCase()
      : nameMatch[1];
    const marker = /(\w+),\s*\/\/\s*shouldDefer/.exec(source);
    if (marker) {
      if (marker[1] === 'true') deferred.add(toolName);
      continue;
    }
    if (/shouldDefer/.test(source)) unknown.push(`${file} (${toolName})`);
  }
  return { deferred, unknown };
}

/** Tool names a prompt tells the model to use. */
function promptedTools(deferred) {
  const prompted = new Map();
  for (const relative of PROMPT_SOURCES) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, 'utf8');
    for (const name of deferred) {
      // Only an imperative mention counts. "call web_search", "use web_fetch",
      // "web_search for internet queries" are promises; a mention inside a
      // sentence explaining that a tool must be LOADED first is not.
      const imperative = new RegExp(
        `(?:use|call|via|through|with|prefer|run)\\s+\\\`?${name}\\\`?|\\\`?${name}\\\`?\\s+(?:for|to)\\s`,
        'i',
      );
      const loadFirst = new RegExp(
        `tool_search[^.\\n]{0,80}${name}|${name}[^.\\n]{0,80}(?:is deferred|must be loaded|load it first|after loading)`,
        'i',
      );
      if (imperative.test(source) && !loadFirst.test(source)) {
        prompted.set(name, relative);
      }
    }
  }
  return prompted;
}

const { deferred, unknown } = deferredTools();
const violations = promptedTools(deferred);

if (unknown.length) {
  console.error(
    `\n!!! ${unknown.length} tool(s) mention shouldDefer in a form this check cannot read:`,
  );
  for (const item of unknown) console.error(`      ${item}`);
  console.error(
    '    Add a `// shouldDefer` trailing comment to the argument so its value is checkable.\n',
  );
}

if (violations.size > 0) {
  console.error(
    `\n!!! ${violations.size} tool(s) are DEFERRED (hidden from the model) but a prompt tells the model to use them:\n`,
  );
  for (const [name, source] of violations) {
    console.error(`      ${name} — advertised in ${source}`);
  }
  console.error(
    `\n    A deferred tool is absent from the model's tool list until tool_search\n` +
      `    reveals it. A model told to use a tool it cannot see passes the name to\n` +
      `    the shell instead ("'${[...violations.keys()][0]}' is not recognized as a command").\n` +
      `    Fix by setting shouldDefer:false on the tool, or by removing the\n` +
      `    instruction that promises it.\n`,
  );
  process.exit(1);
}

// The same defect class in the web stack (PLAN 2.4's duplication).
//
// `web/src/lib/tools.ts` and `agent-tools.ts` each hold a list of advertised tool
// definitions AND a dispatch switch that implements them. Two hand-maintained
// lists of the same names, in one file, is the identical failure shape: a name
// advertised to the model with no implementation behind it is a tool call that can
// only fail, and a name implemented but never advertised is dead code the model
// can never reach. Currently in agreement at 26/26 — this keeps it that way.
function webToolDrift() {
  const advertised = new Set();
  const implemented = new Set();
  for (const relative of ['web/src/lib/tools.ts', 'web/src/lib/agent-tools.ts']) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, 'utf8');
    for (const m of source.matchAll(/name:\s*"([a-z0-9_]+)"/g)) advertised.add(m[1]);
    for (const m of source.matchAll(/case\s*"([a-z0-9_]+)"\s*:/g)) implemented.add(m[1]);
  }
  return {
    advertised,
    implemented,
    missing: [...advertised].filter((n) => !implemented.has(n)),
    unreachable: [...implemented].filter((n) => !advertised.has(n)),
  };
}

const web = webToolDrift();
if (web.missing.length || web.unreachable.length) {
  console.error('\n!!! web tool definitions and their dispatch disagree:');
  if (web.missing.length) {
    console.error(
      `      advertised to the model with no implementation: ${web.missing.join(', ')}`,
    );
    console.error('      → every call to these can only fail.');
  }
  if (web.unreachable.length) {
    console.error(
      `      implemented but never advertised: ${web.unreachable.join(', ')}`,
    );
    console.error('      → the model cannot reach these; either advertise or delete.');
  }
  console.error('');
  process.exit(1);
}

console.log(
  `prompt/tool visibility: ${deferred.size} deferred tool(s), none advertised imperatively by a prompt; ` +
    `web tools ${web.advertised.size} advertised / ${web.implemented.size} implemented, in agreement` +
    (unknown.length ? ` (${unknown.length} unreadable — see above)` : ''),
);
process.exit(unknown.length ? 1 : 0);
