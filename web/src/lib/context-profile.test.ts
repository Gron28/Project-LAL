import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContextProfileStore, contextCandidates, makeContextProfile, readGgufContextLength } from "./context-profile.ts";

function string(value: string): Buffer {
  const bytes = Buffer.from(value);
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([size, bytes]);
}

test("context candidates prefer the largest supported verified tier", () => {
  assert.deepEqual(contextCandidates(70_000), [65_536, 32_768, 16_384, 8_192]);
  assert.deepEqual(contextCandidates(20_000), [16_384, 8_192]);
});

test("reads native context length from GGUF metadata without tensor data", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-gguf-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "demo.gguf");
  const header = Buffer.alloc(24);
  header.write("GGUF", 0, "ascii"); header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(BigInt(0), 8); header.writeBigUInt64LE(BigInt(2), 16);
  const archType = Buffer.alloc(4); archType.writeUInt32LE(8);
  const ctxType = Buffer.alloc(4); ctxType.writeUInt32LE(4);
  const ctx = Buffer.alloc(4); ctx.writeUInt32LE(262_144);
  fs.writeFileSync(file, Buffer.concat([header, string("general.architecture"), archType, string("qwen35"), string("qwen35.context_length"), ctxType, ctx]));
  assert.equal(readGgufContextLength(file), 262_144);
});

test("profile cache is atomic and distinguishes requested from active", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lal-context-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ContextProfileStore(path.join(root, "profiles.json"));
  const profile = makeContextProfile({ model: "demo", backend: "llama.cpp", modelMaxTokens: 131_072, requestedTokens: 65_536, activeTokens: 32_768, verifiedTokens: 32_768, fingerprint: "abc" });
  assert.equal(profile.verification, "degraded");
  store.put(profile);
  assert.deepEqual(store.get("abc"), profile);
});
