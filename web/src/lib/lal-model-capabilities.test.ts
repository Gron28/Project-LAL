import assert from "node:assert/strict";
import test from "node:test";
import { isNativeGemma4VisionModel, recommendedGemma4Sampling } from "./lal-model-capabilities.ts";

test("marks only the installed native multimodal Gemma 4 artifacts as vision", () => {
  assert.equal(isNativeGemma4VisionModel("gemma4:12b"), true);
  assert.equal(isNativeGemma4VisionModel("gemma4:e4b"), true);
  assert.equal(isNativeGemma4VisionModel("gemma4-agentic-v2:q4"), false);
  assert.equal(isNativeGemma4VisionModel("gemma-4-12B-agentic-GGUF:Q4_K_M"), false);
});

test("uses the documented Gemma 4 sampler without changing other families", () => {
  const expected = { temperature: 1, topP: 0.95, topK: 64, repeatPenalty: 1.1 };
  assert.deepEqual(recommendedGemma4Sampling("gemma4:12b"), expected);
  assert.deepEqual(recommendedGemma4Sampling("gemma4-agentic-v2:q4"), expected);
  assert.deepEqual(recommendedGemma4Sampling("gemma4-agentic-v2-heretic:q4"), expected);
  assert.equal(recommendedGemma4Sampling("qwen35-9b"), null);
});
