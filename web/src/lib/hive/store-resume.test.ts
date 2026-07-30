import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("side effects replay exactly once and unknown events stay visible", async (t) => {
  const original = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-hive-store-"));
  process.chdir(root);
  const store = await import(`./store.ts?resume-test=${Date.now()}`);
  t.after(() => {
    store.hiveDb.close();
    delete (globalThis as { __hive_db?: unknown }).__hive_db;
    process.chdir(original);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const budget = { name: "normal" as const, cycles: 1, inferenceTokens: 10, contextTokens: 10, modelSwaps: 1, retries: 1, researchCalls: 1 };
  store.createWorkflow({
    id: "resume", kind: "coding", templateId: "fixture", status: "paused",
    envelope: { version: 1, objective: "x", constraints: [], artifactRefs: [], requiredOutput: "x", definitionOfDone: ["works"] },
    spec: { version: 1, id: "fixture", kind: "coding", name: "fixture", nodes: [{ id: "write", label: "write", role: "coder", action: "worker_tools", dependsOn: [], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } }], allowedFollowupActions: [], budget },
    budget, working: {}, createdAt: 1, updatedAt: 1,
  });
  const first = store.beginSideEffect("resume", "write", "write_file", { path: "x" });
  assert.equal(first.action, "execute");
  store.finishSideEffect("resume", "write", first.fingerprint, "ok", true);
  assert.deepEqual(store.beginSideEffect("resume", "write", "write_file", { path: "x" }), { action: "replay", fingerprint: first.fingerprint, output: "ok" });
  store.appendHiveEvent("resume", { schemaVersion: 99, kind: "future_event", payload: { preserved: true } });
  const event = store.getHiveEvents("resume")[0];
  assert.equal(event.schemaKnown, false);
  assert.equal(event.kind, "future_event");
});

test("pause, cancellation, approval, interruption, and backend recovery are deterministic", async (t) => {
  const original = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-hive-recovery-"));
  process.chdir(root);
  const store = await import(`./store.ts?recovery-matrix=${Date.now()}`);
  t.after(() => {
    store.hiveDb.close();
    delete (globalThis as { __hive_db?: unknown }).__hive_db;
    process.chdir(original);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const budget = { name: "normal" as const, cycles: 1, inferenceTokens: 10, contextTokens: 10, modelSwaps: 1, retries: 1, researchCalls: 1 };
  const create = (id: string) => store.createWorkflow({
    id, kind: "coding" as const, templateId: "fixture", status: "paused" as const,
    envelope: { version: 1, objective: id, constraints: [], artifactRefs: [], requiredOutput: "x", definitionOfDone: ["works"] },
    spec: {
      version: 1, id: "fixture", kind: "coding" as const, name: "fixture",
      nodes: [
        { id: "done", label: "done", role: "coder", action: "worker_tools", dependsOn: [], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
        { id: "active", label: "active", role: "coder", action: "worker_tools", dependsOn: ["done"], retry: { maxAttempts: 1, backoffMs: 0, retryOn: [] } },
      ],
      allowedFollowupActions: [], budget,
    },
    budget, working: {}, createdAt: 1, updatedAt: 1,
  });

  create("pause");
  store.updateNode("pause", "done", { status: "succeeded", finishedAt: 2 });
  store.updateNode("pause", "active", { status: "running", startedAt: 2 });
  assert.equal(store.resetInterruptedNodes("pause"), 1);
  assert.deepEqual(store.getWorkflowNodes("pause").map((node: { nodeId: string; status: string }) => [node.nodeId, node.status]), [["done", "succeeded"], ["active", "pending"]]);

  create("cancel");
  store.updateNode("cancel", "active", { status: "cancelled", finishedAt: 2 });
  assert.equal(store.resetInterruptedNodes("cancel"), 1);
  assert.equal(store.getWorkflowNodes("cancel").find((node: { nodeId: string }) => node.nodeId === "active")?.status, "pending");

  create("approval");
  store.createApproval("approval-1", "approval", "active", "tool", { consequence: "writes a fixture file" });
  assert.equal(store.resolveStoredApproval("approval-1", false), true);
  assert.equal(store.resolveStoredApproval("approval-1", true), false, "a durable decision cannot be resolved twice");
  const approval = store.hiveDb.prepare("SELECT status,resolved_at FROM approvals WHERE id=?").get("approval-1");
  assert.equal(approval.status, "denied");
  assert.equal(Number(approval.resolved_at) > 0, true);

  create("interrupt");
  const uncertain = store.beginSideEffect("interrupt", "active", "write_file", { path: "x" });
  assert.equal(store.beginSideEffect("interrupt", "active", "write_file", { path: "x" }).action, "uncertain");
  store.finishSideEffect("interrupt", "active", uncertain.fingerprint, "backend disconnected", false);
  assert.equal(store.beginSideEffect("interrupt", "active", "write_file", { path: "x" }).action, "execute");
  store.finishSideEffect("interrupt", "active", uncertain.fingerprint, "ok", true);
  assert.equal(store.beginSideEffect("interrupt", "active", "write_file", { path: "x" }).action, "replay");
});
