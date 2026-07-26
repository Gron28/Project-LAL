// Conformance check for the run-stream event protocol (see packages/protocol for the
// compatibility rule this enforces). Two real, unedited run ledgers — one code-kind, one
// hive-kind — are replayed line by line and every event's `k` must be a kind this module
// knows about. If this test fails after a legitimate new event kind was added, the fix is
// to add that kind to packages/protocol/src/index.ts, not to loosen this test.
//
// Run directly with Node's native TypeScript support + built-in test runner:
//   node --test web/src/lib/protocol/protocol.conformance.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Node 24 deliberately refuses native TypeScript stripping inside node_modules.
// Exercise the canonical workspace source here; check_protocol_drift separately
// proves that the Web and CLI runtime consumers use the package boundary.
import { KNOWN_EVENT_KINDS } from "../../../../packages/protocol/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

// Legacy kinds a real on-disk ledger may still contain that are intentionally NOT part of
// the closed KNOWN_EVENT_KINDS set going forward (none currently — kept as an explicit,
// named escape hatch per the task brief rather than a silent allow-list).
const LEGACY_KINDS = new Set<string>([]);

type ParsedLine = { lineNo: number; raw: string; k: string };

function parseLedger(file: string): ParsedLine[] {
  const text = fs.readFileSync(file, "utf8");
  const out: ParsedLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      assert.fail(`${path.basename(file)}:${i + 1} is not valid JSON: ${(e as Error).message}`);
    }
    const k = (parsed as { k?: unknown }).k;
    assert.equal(typeof k, "string", `${path.basename(file)}:${i + 1} has no string \`k\` field`);
    out.push({ lineNo: i + 1, raw, k: k as string });
  }
  return out;
}

function assertAllKindsKnown(file: string) {
  const lines = parseLedger(file);
  assert.ok(lines.length > 0, `${path.basename(file)} is empty`);
  for (const { lineNo, k } of lines) {
    const known = KNOWN_EVENT_KINDS.has(k) || LEGACY_KINDS.has(k);
    assert.ok(known, `${path.basename(file)}:${lineNo} has unknown event kind "${k}" — ` +
      `add it to packages/protocol/src/index.ts, or list it in LEGACY_KINDS if it's a retired kind.`);
  }
}

test("code-kind run ledger: every event kind is known to the protocol module", () => {
  assertAllKindsKnown(path.join(FIXTURES_DIR, "run-code-sample.ndjson"));
});

test("hive-kind run ledger: every event kind is known to the protocol module", () => {
  assertAllKindsKnown(path.join(FIXTURES_DIR, "run-hive-sample.ndjson"));
});

test("KNOWN_EVENT_KINDS is non-empty and contains the run-envelope kinds from the plan", () => {
  for (const k of ["run", "turn", "usage", "status", "approval_needed", "approval_result"]) {
    assert.ok(KNOWN_EVENT_KINDS.has(k), `expected run-envelope kind "${k}" in KNOWN_EVENT_KINDS`);
  }
});
