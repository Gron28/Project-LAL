import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { completionReserveTokens } from "./toolloop.ts";

test("whole-file mutation keeps a large completion reserve", () => {
  assert.equal(completionReserveTokens({ canWrite: true, wroteFiles: false, forceMutationTool: false, requestedMaxTokens: 50_000 }), 40_960);
});

test("bounded follow-up uses a smaller reserve", () => {
  const reserve = completionReserveTokens({ canWrite: true, wroteFiles: true, forceMutationTool: false, requestedMaxTokens: 50_000 });
  assert.equal(reserve, 8_192);
  assert.ok(29_000 + reserve + 1_024 < 65_536);
});

test("reserve never exceeds the configured output allowance", () => {
  assert.equal(completionReserveTokens({ canWrite: true, wroteFiles: false, forceMutationTool: true, requestedMaxTokens: 6_000 }), 6_000);
});

test("the tool loop source no longer carries the legacy 8K generation default", async () => {
  const source = await readFile(new URL("./toolloop.ts", import.meta.url), "utf8");
  assert.match(source, /opts\.maxTokens \?\? 40_960/);
  assert.doesNotMatch(source, /opts\.maxTokens \?\? 8192/);
});
