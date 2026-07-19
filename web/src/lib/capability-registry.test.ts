import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCapabilityRegistrySnapshot, CapabilityRegistryRepository, findCatalogModel } from "./capability-registry.ts";
import type { ModelProfile } from "./hive/contracts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-capability-registry-"));
  const file = path.join(root, "model.gguf");
  fs.writeFileSync(file, "model-bytes");
  return { root, file, digest: crypto.createHash("sha256").update("model-bytes").digest("hex") };
}

test("inventory records bytes as stable artifact IDs and keeps names as aliases", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const snapshot = await buildCapabilityRegistrySnapshot([{ name: "demo", source: "local", path: f.file }], [], "2026-07-19T00:00:00.000Z");
  assert.equal(snapshot.artifacts[0]?.id, `artifact:sha256:${f.digest}`);
  assert.equal(snapshot.models[0]?.aliases[0], "local:demo");
  assert.equal(snapshot.runtimes[0]?.backend, "llama.cpp");
  assert.equal(findCatalogModel(snapshot, "local:demo")?.artifactId, `artifact:sha256:${f.digest}`);
});

test("repeated discovery deduplicates aliases for one byte-identical artifact", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const snapshot = await buildCapabilityRegistrySnapshot([
    { name: "first", source: "local", path: f.file }, { name: "second", source: "local", path: f.file },
  ], [], "2026-07-19T00:00:00.000Z");
  assert.equal(snapshot.artifacts.length, 1); assert.equal(snapshot.models.length, 1);
  assert.deepEqual(snapshot.models[0]?.aliases, ["local:first", "local:second"]);
});

test("HIVE profiles create exact, separately-addressed runtime records", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const profile: ModelProfile = { id: "local:demo", provider: "llama.cpp", model: "demo", versionHash: "legacy-observation", capabilities: [], structuredOutput: "none", contextCeiling: 8192, backendCompatible: false, probeStatus: "discovered" };
  const snapshot = await buildCapabilityRegistrySnapshot([{ name: "demo", source: "local", path: f.file }], [profile], "2026-07-19T00:00:00.000Z");
  assert.equal(snapshot.runtimes[0]?.profileId, "local:demo");
  assert.match(snapshot.runtimes[0]?.id ?? "", /^runtime:sha256:[a-f0-9]{64}$/);
});

test("repository atomically retains a valid versioned snapshot", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const repository = new CapabilityRegistryRepository(path.join(f.root, "state", "registry.json"));
  const snapshot = await repository.refresh([{ name: "demo", source: "local", path: f.file }], []);
  assert.equal(repository.read()?.models[0]?.id, snapshot.models[0]?.id);
  assert.equal(repository.read()?.apiVersion, "v1");
});
