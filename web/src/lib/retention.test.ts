import assert from "node:assert/strict";
import test from "node:test";
import { runLedgerEvictionPlan } from "./retention.ts";

const day = 24 * 60 * 60 * 1000;

test("run ledger retention keeps live work and evicts expired terminal pairs", () => {
  const plan = runLedgerEvictionPlan([
    { id: "live", status: "running", updatedAt: 0, bytes: 80 },
    { id: "recent", status: "done", updatedAt: 99 * day, bytes: 10 },
    { id: "old", status: "error", updatedAt: 0, bytes: 10 },
  ], { now: 100 * day, maxAgeMs: 30 * day, maxTotalBytes: 100 });
  assert.deepEqual(plan.keep.map((entry) => entry.id).sort(), ["live", "recent"]);
  assert.deepEqual(plan.evict.map((entry) => entry.id), ["old"]);
  assert.equal(plan.keptBytes, 90);
});

test("run ledger retention evicts oldest terminal ledgers first for the byte cap", () => {
  const plan = runLedgerEvictionPlan([
    { id: "new", status: "done", updatedAt: 30, bytes: 60 },
    { id: "middle", status: "stopped", updatedAt: 20, bytes: 60 },
    { id: "old", status: "interrupted", updatedAt: 10, bytes: 60 },
  ], { now: 40, maxAgeMs: 100, maxTotalBytes: 120 });
  assert.deepEqual(plan.keep.map((entry) => entry.id), ["new", "middle"]);
  assert.deepEqual(plan.evict.map((entry) => entry.id), ["old"]);
  assert.equal(plan.keptBytes, 120);
});
