import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DurableDagRunner } from "../src/durable-dag.js";

function fixture(name, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dag-${name}-`));
  return { dir, journal: path.join(dir, "run.ndjson"), runner: new DurableDagRunner({ journalPath: path.join(dir, "run.ndjson"), runId: name, ...options }) };
}

test("rejects duplicate IDs, missing dependencies, and cycles before side effects", async () => {
  for (const nodes of [
    [{ id: "a", run() {} }, { id: "a", run() {} }],
    [{ id: "a", dependsOn: ["missing"], run() {} }],
    [{ id: "a", dependsOn: ["b"], run() {} }, { id: "b", dependsOn: ["a"], run() {} }],
  ]) {
    let calls = 0;
    nodes.forEach((n) => { n.run = () => { calls++; }; });
    const { runner } = fixture("invalid");
    await assert.rejects(() => runner.run(nodes));
    assert.equal(calls, 0);
  }
});

test("runs a branching graph in deterministic ready order", async () => {
  const order = [];
  const { runner } = fixture("order");
  const result = await runner.run([
    { id: "root", run: async () => order.push("root") },
    { id: "left", dependsOn: ["root"], run: async () => order.push("left") },
    { id: "right", dependsOn: ["root"], run: async () => order.push("right") },
    { id: "join", dependsOn: ["left", "right"], run: async () => order.push("join") },
  ]);
  assert.deepEqual(order, ["root", "left", "right", "join"]);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.completed, ["root", "left", "right", "join"]);
});

test("retries within node and global limits with stable attempt keys", async () => {
  const keys = [];
  const { runner } = fixture("retry", { maxAttempts: 3 });
  const result = await runner.run([{ id: "flaky", retries: 2, run: async ({ attempt, idempotencyKey }) => {
    keys.push(idempotencyKey);
    if (attempt < 3) throw new Error("transient");
  } }]);
  assert.equal(result.status, "succeeded");
  assert.equal(result.attempts.flaky, 3);
  assert.equal(new Set(keys).size, 3);
  assert.ok(keys.every((key, i) => key.includes("retry") && key.includes("flaky") && key.endsWith(String(i + 1))));
});

test("fails explicitly when global attempt budget is exhausted", async () => {
  const { runner } = fixture("attempt-budget", { maxAttempts: 2 });
  const result = await runner.run([{ id: "bad", retries: 9, run: async () => { throw new Error("still bad"); } }]);
  assert.equal(result.status, "failed");
  assert.equal(result.attempts.bad, 2);
  assert.match(result.errors[0], /attempt budget|still bad/i);
});

test("recovers succeeded nodes without repeating their side effects", async () => {
  const state = { a: 0, b: 0 };
  const f = fixture("recover");
  const nodes = [
    { id: "a", run: async () => { state.a++; } },
    { id: "b", dependsOn: ["a"], run: async () => { state.b++; } },
  ];
  const first = await f.runner.run(nodes);
  assert.equal(first.status, "succeeded");
  const second = await new DurableDagRunner({ journalPath: f.journal, runId: "recover" }).run(nodes);
  assert.equal(second.status, "succeeded");
  assert.deepEqual(state, { a: 1, b: 1 });
  assert.deepEqual(second.completed, ["a", "b"]);
});

test("ignores a truncated tail but rejects corruption in the middle", async () => {
  const f = fixture("corruption");
  await f.runner.run([{ id: "a", run: async () => {} }]);
  fs.appendFileSync(f.journal, '{"seq":999');
  const recovered = await new DurableDagRunner({ journalPath: f.journal, runId: "corruption" }).run([{ id: "a", run: async () => { throw new Error("must not repeat"); } }]);
  assert.equal(recovered.status, "succeeded");

  const lines = fs.readFileSync(f.journal, "utf8").split("\n").filter(Boolean);
  fs.writeFileSync(f.journal, [lines[0], "not-json", ...lines.slice(1)].join("\n") + "\n");
  await assert.rejects(() => new DurableDagRunner({ journalPath: f.journal, runId: "corruption" }).run([{ id: "a", run: async () => {} }]), /corrupt/i);
});

test("cancellation is durable and prevents downstream starts", async () => {
  const controller = new AbortController();
  const calls = [];
  const f = fixture("cancel");
  const result = await f.runner.run([
    { id: "first", run: async () => { calls.push("first"); controller.abort(); } },
    { id: "second", dependsOn: ["first"], run: async () => calls.push("second") },
  ], { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, ["first"]);
  assert.match(fs.readFileSync(f.journal, "utf8"), /cancel/i);
});

test("wall-time exhaustion prevents false completion", async () => {
  const f = fixture("wall", { wallTimeMs: 5 });
  const result = await f.runner.run([
    { id: "slow", run: async () => new Promise((resolve) => setTimeout(resolve, 15)) },
    { id: "later", dependsOn: ["slow"], run: async () => {} },
  ]);
  assert.equal(result.status, "failed");
  assert.ok(!result.completed.includes("later"));
  assert.match(result.errors.join(" "), /wall|time|budget/i);
});

test("journal records are monotonic, complete, and newline delimited", async () => {
  const f = fixture("journal");
  const result = await f.runner.run([{ id: "a", run: async () => {} }, { id: "b", dependsOn: ["a"], run: async () => {} }]);
  const raw = fs.readFileSync(f.journal, "utf8");
  assert.ok(raw.endsWith("\n"));
  const records = raw.trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map((r) => r.seq), records.map((_, i) => i + 1));
  assert.ok(records.every((r) => r.ts && r.runId === "journal" && r.type));
  assert.equal(result.journalSeq, records.at(-1).seq);
  assert.ok(records.some((r) => r.nodeId === "a" && r.attempt === 1));
});
