import test from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactAcceptanceRegistry,
  evaluateResearchCollection,
  evaluateResearchCoverage,
  evaluateSharedCompletion,
  validateStaticHtmlDocument,
} from "./agent-runtime.js";

test("shared completion never upgrades unknown acceptance to complete", () => {
  assert.equal(evaluateSharedCompletion({
    unresolvedWorkIds: [],
    criteria: [{ id: "c", text: "works", state: "unknown", evidenceIds: [] }],
    requiredVerificationPassed: true,
  }).outcome, "incomplete");
});

test("shared research collection and HTML validation are deterministic", () => {
  assert.equal(evaluateResearchCollection({
    queries: ["one", "two", "three"],
    sources: ["https://a.example/x", "https://b.example/y"],
  }).passed, true);
  const html = validateStaticHtmlDocument("<html><body><button id='go'>go</button><script>document.getElementById('go').onclick=()=>{}</script></body></html>");
  assert.equal(html.passed, true);
  assert.equal(html.checks.find((check) => check.code === "element-references")?.passed, true);
  assert.equal(validateStaticHtmlDocument("<html><body><script>document.getElementById('missing')</script></body></html>").passed, false);
});

test("shared research coverage and acceptance registry are surface-neutral", () => {
  assert.deepEqual(evaluateResearchCoverage([{ id: "q", evidenceIds: ["e"], unresolved: false, contradictory: true }], new Set(["e"])), {
    complete: true, uncoveredIds: [], contradictionIds: ["q"],
  });
  const registry = new ArtifactAcceptanceRegistry();
  registry.register({ id: "html", mediaTypes: ["text/html"], validate: async () => ({ passed: true, checks: [], uncheckedProperties: [] }) });
  assert.equal(registry.resolve("text/html")?.id, "html");
});
