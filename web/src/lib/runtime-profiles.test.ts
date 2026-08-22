import assert from "node:assert/strict";
import test from "node:test";
import { llamaServerContextArgs, runtimeProfileForContext } from "./runtime-profiles.ts";

test("runtime profiles make 100K context explicit", () => {
  assert.equal(runtimeProfileForContext(32_768).id, "responsive");
  assert.equal(runtimeProfileForContext(65_536).id, "balanced");
  assert.equal(runtimeProfileForContext(102_400).id, "deep-context");
});

test("long-context llama tuning preserves watchdog-safe batches and prompt reuse", () => {
  assert.deepEqual(llamaServerContextArgs(102_400, 99), ["-b", "256", "-ub", "256", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--cache-prompt", "--cache-reuse", "256"]);
  assert.deepEqual(llamaServerContextArgs(32_768, 99), ["-b", "512", "-ub", "512", "--cache-prompt"]);
  assert.deepEqual(llamaServerContextArgs(102_400, 0), ["-b", "512", "-ub", "512", "--cache-prompt"]);
});
