import assert from "node:assert/strict";
import test from "node:test";
import { LAL_MANAGED_MODEL_POLICY, LAL_MANAGED_SHELL_DEFAULT_TIMEOUT_MS } from "./lal-client-policy.ts";

test("managed LAL sessions do not impose synthetic run limits", () => {
  assert.deepEqual(LAL_MANAGED_MODEL_POLICY, {
    maxSessionTurns: -1,
    skipLoopDetection: true,
    maxToolCallsPerTurn: -1,
  });
});

test("managed shell commands get a practical build/test timeout", () => {
  assert.equal(LAL_MANAGED_SHELL_DEFAULT_TIMEOUT_MS, 600_000);
});
