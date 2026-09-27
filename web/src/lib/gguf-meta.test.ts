import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGgufHeaderBuffer, summarizeArchitecture } from "./gguf-meta.ts";

// Builds a minimal GGUF v3 header: metadata + tensor index, no weight data.
function gguf(kv: [string, number, Buffer][], tensors: [string, number[], number][]) {
  const parts: Buffer[] = [];
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(u32(0x46554747), u32(3), u64(tensors.length), u64(kv.length));
  for (const [k, type, value] of kv) parts.push(str(k), u32(type), value);
  for (const [name, shape, type] of tensors) parts.push(str(name), u32(shape.length), ...shape.map(u64), u32(type), u64(0));
  return { buf: Buffer.concat(parts), u32, str };
}

test("parses metadata and summarizes a hybrid layer stack", () => {
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const s = (x: string) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Buffer.byteLength(x))); return Buffer.concat([b, Buffer.from(x)]); };
  const vocab = Buffer.concat([u32(8), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(3)); return b; })(), s("a"), s("b"), s("c")]);
  const { buf } = gguf(
    [["general.architecture", 8, s("demo")], ["demo.embedding_length", 4, u32(64)], ["demo.attention.head_count", 4, u32(4)], ["general.file_type", 4, u32(15)], ["tokenizer.ggml.tokens", 9, vocab]],
    [["token_embd.weight", [64, 3], 0], ["blk.0.attn_q.weight", [64, 64], 12], ["blk.0.ffn_up.weight", [64, 128], 12], ["blk.1.ssm_in.weight", [64, 64], 14], ["output.weight", [64, 3], 14]],
  );
  const a = summarizeArchitecture(parseGgufHeaderBuffer(buf));
  assert.equal(a.architecture, "demo");
  assert.equal(a.embedding, 64);
  assert.equal(a.heads, 4);
  assert.equal(a.vocab, 3);
  assert.equal(a.fileType, "Q4_K_M");
  assert.deepEqual(a.layers.map((l) => l.kind), ["attention", "ssm"]);
  assert.equal(a.layers[0].params, 64 * 64 + 64 * 128);
  assert.equal(a.layers[0].quant, "Q4_K");
  assert.equal(a.embeddingParams, 192);
  assert.deepEqual(a.layers[0].tensors.map((x) => [x.module, x.shape]), [["attn_q", [64, 64]], ["ffn_up", [64, 128]]]);
});

test("rejects a non-GGUF file", () => {
  assert.throws(() => parseGgufHeaderBuffer(Buffer.from("not a model at all")), /not a GGUF/);
});
