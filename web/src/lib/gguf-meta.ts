// Reads a GGUF file's header — metadata key/values and the tensor index — without
// touching the weights, and summarizes it into the architecture the 3D model view
// draws. The header of a multi-GB model is a few MB (mostly the tokenizer vocab),
// so this stays cheap enough to run on demand; results are cached by path+mtime.
import fs from "node:fs";

const GGML_TYPES: Record<number, string> = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1", 8: "Q8_0", 9: "Q8_1",
  10: "Q2_K", 11: "Q3_K", 12: "Q4_K", 13: "Q5_K", 14: "Q6_K", 15: "Q8_K", 16: "IQ2_XXS",
  17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ1_S", 20: "IQ4_NL", 21: "IQ3_S", 22: "IQ2_S",
  23: "IQ4_XS", 24: "I8", 25: "I16", 26: "I32", 27: "I64", 28: "F64", 29: "IQ1_M",
  30: "BF16", 34: "TQ1_0", 35: "TQ2_0",
};

// llama.cpp's llama_ftype (general.file_type) — a different numbering from GGML tensor types.
const FILE_TYPES: Record<number, string> = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K",
  11: "Q3_K_S", 12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S",
  17: "Q5_K_M", 18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS", 21: "Q2_K_S", 22: "IQ3_XS",
  23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M", 28: "IQ2_S",
  29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16", 36: "TQ1_0", 37: "TQ2_0",
};

export type GgufValue = string | number | boolean | bigint | { array: string; length: number; head?: GgufValue[] };
export type GgufTensor = { name: string; shape: number[]; type: string; params: number };
export type GgufHeader = { version: number; metadata: Record<string, GgufValue>; tensors: GgufTensor[] };

/** Buffered forward-only reader over a file descriptor (or an in-memory buffer). */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;
  private filePos = 0;
  private readonly fd: number | null;
  constructor(fd: number | null, src?: Buffer) {
    this.fd = fd;
    if (src) this.buf = src;
  }
  private ensure(n: number) {
    if (this.buf.length - this.pos >= n) return;
    if (this.fd == null) throw new Error("unexpected end of GGUF header");
    const rest = this.buf.subarray(this.pos);
    const chunk = Buffer.alloc(Math.max(n, 1 << 20));
    const read = fs.readSync(this.fd, chunk, 0, chunk.length, this.filePos);
    this.filePos += read;
    this.buf = Buffer.concat([rest, chunk.subarray(0, read)]);
    this.pos = 0;
    if (this.buf.length < n) throw new Error("unexpected end of GGUF header");
  }
  u8() { this.ensure(1); return this.buf.readUInt8(this.pos++); }
  i8() { this.ensure(1); return this.buf.readInt8(this.pos++); }
  u16() { this.ensure(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  i16() { this.ensure(2); const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }
  u32() { this.ensure(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32() { this.ensure(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  f32() { this.ensure(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  f64() { this.ensure(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  u64() { this.ensure(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return v; }
  i64() { this.ensure(8); const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return v; }
  str() {
    const n = Number(this.u64());
    if (n > 1 << 26) throw new Error("GGUF string length is implausible");
    this.ensure(n); const v = this.buf.toString("utf8", this.pos, this.pos + n); this.pos += n; return v;
  }
}

const TYPE_NAMES = ["u8", "i8", "u16", "i16", "u32", "i32", "f32", "bool", "string", "array", "u64", "i64", "f64"];

function readValue(r: Reader, type: number): GgufValue {
  switch (type) {
    case 0: return r.u8(); case 1: return r.i8(); case 2: return r.u16(); case 3: return r.i16();
    case 4: return r.u32(); case 5: return r.i32(); case 6: return r.f32(); case 7: return r.u8() !== 0;
    case 8: return r.str(); case 10: return toNum(r.u64()); case 11: return toNum(r.i64()); case 12: return r.f64();
    case 9: {
      const itemType = r.u32();
      const length = Number(r.u64());
      // Keep only a short head of big arrays (the vocab is ~150k strings).
      const head: GgufValue[] = [];
      for (let i = 0; i < length; i++) { const v = readValue(r, itemType); if (i < 16) head.push(v); }
      return { array: TYPE_NAMES[itemType] ?? String(itemType), length, head };
    }
    default: throw new Error(`unknown GGUF value type ${type}`);
  }
}

function toNum(v: bigint): number | bigint {
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function parse(r: Reader): GgufHeader {
  if (r.u32() !== 0x46554747) throw new Error("not a GGUF file"); // "GGUF" little-endian
  const version = r.u32();
  if (version < 2) throw new Error(`GGUF v${version} is not supported`);
  const tensorCount = Number(r.u64());
  const kvCount = Number(r.u64());
  const metadata: Record<string, GgufValue> = {};
  for (let i = 0; i < kvCount; i++) {
    const key = r.str();
    metadata[key] = readValue(r, r.u32());
  }
  const tensors: GgufTensor[] = [];
  for (let i = 0; i < tensorCount; i++) {
    const name = r.str();
    const nDims = r.u32();
    const shape: number[] = [];
    for (let d = 0; d < nDims; d++) shape.push(Number(r.u64()));
    const type = r.u32();
    r.u64(); // data offset — not needed, weights are never read
    tensors.push({ name, shape, type: GGML_TYPES[type] ?? `type${type}`, params: shape.reduce((a, b) => a * b, 1) });
  }
  return { version, metadata, tensors };
}

export function parseGgufHeaderBuffer(buf: Buffer): GgufHeader { return parse(new Reader(null, buf)); }

export function readGgufHeader(file: string): GgufHeader {
  const fd = fs.openSync(file, "r");
  try { return parse(new Reader(fd)); } finally { fs.closeSync(fd); }
}

// ---- architecture summary --------------------------------------------------

export type LayerKind = "attention" | "linear-attention" | "ssm" | "other";
export type LayerSummary = {
  index: number;
  kind: LayerKind;
  params: number;
  moe: boolean;
  /** Parameter count per module (attn_q, ffn_up, ssm_in…), for the per-layer breakdown. */
  modules: Record<string, number>;
  quant: string;
  /** The layer's weight matrices with their real shapes (1-D norms/biases omitted). */
  tensors: { module: string; shape: number[]; type: string }[];
};
export type ModelArchitecture = {
  architecture: string;
  name: string | null;
  layers: LayerSummary[];
  embedding: number | null;
  feedForward: number | null;
  heads: number | null;
  kvHeads: number | null;
  context: number | null;
  vocab: number | null;
  experts: number | null;
  expertsUsed: number | null;
  totalParams: number;
  embeddingParams: number;
  outputParams: number;
  quantMix: Record<string, number>;
  fileType: string | null;
};

const num = (v: GgufValue | undefined): number | null => typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null;
const first = (v: GgufValue | undefined): number | null => {
  if (v && typeof v === "object" && "head" in v) return num(v.head?.[0]);
  return num(v);
};

export function summarizeArchitecture(h: GgufHeader): ModelArchitecture {
  const m = h.metadata;
  const arch = typeof m["general.architecture"] === "string" ? (m["general.architecture"] as string) : "unknown";
  const k = (suffix: string) => m[`${arch}.${suffix}`];
  const layersByIndex = new Map<number, LayerSummary>();
  const quantMix: Record<string, number> = {};
  let embeddingParams = 0, outputParams = 0, totalParams = 0;
  for (const t of h.tensors) {
    totalParams += t.params;
    quantMix[t.type] = (quantMix[t.type] ?? 0) + t.params;
    const blk = /^blk\.(\d+)\.(.+?)(\.weight|\.bias)?$/.exec(t.name);
    if (!blk) {
      if (t.name.startsWith("token_embd")) embeddingParams += t.params;
      else if (t.name.startsWith("output")) outputParams += t.params;
      continue;
    }
    const index = Number(blk[1]);
    const moduleName = blk[2];
    const layer = layersByIndex.get(index) ?? { index, kind: "other" as LayerKind, params: 0, moe: false, modules: {}, quant: t.type, tensors: [] };
    layer.params += t.params;
    if (t.shape.length >= 2 && !blk[3]?.includes("bias")) layer.tensors.push({ module: moduleName, shape: t.shape, type: t.type });
    layer.modules[moduleName] = (layer.modules[moduleName] ?? 0) + t.params;
    if (moduleName.includes("_exps") || moduleName.includes("ffn_gate_inp")) layer.moe = true;
    layersByIndex.set(index, layer);
  }
  const layers = [...layersByIndex.values()].sort((a, b) => a.index - b.index);
  for (const layer of layers) {
    const mods = Object.keys(layer.modules);
    layer.kind = mods.some((x) => x.startsWith("ssm_")) ? (mods.some((x) => x.startsWith("attn_q")) ? "linear-attention" : "ssm")
      : mods.some((x) => x.startsWith("attn_q") || x === "attn_qkv") ? "attention" : "other";
    // Dominant quant type = the type holding most of this layer's parameters.
    const byType: Record<string, number> = {};
    for (const t of h.tensors) if (t.name.startsWith(`blk.${layer.index}.`)) byType[t.type] = (byType[t.type] ?? 0) + t.params;
    layer.quant = Object.entries(byType).sort((a, b) => b[1] - a[1])[0]?.[0] ?? layer.quant;
  }
  const vocabMeta = m["tokenizer.ggml.tokens"];
  const vocab = num(k("vocab_size")) ?? (vocabMeta && typeof vocabMeta === "object" && "length" in vocabMeta ? vocabMeta.length : null);
  return {
    architecture: arch,
    name: typeof m["general.name"] === "string" ? (m["general.name"] as string) : null,
    layers,
    embedding: num(k("embedding_length")),
    feedForward: first(k("feed_forward_length")),
    heads: first(k("attention.head_count")),
    kvHeads: first(k("attention.head_count_kv")),
    context: num(k("context_length")),
    vocab,
    experts: num(k("expert_count")),
    expertsUsed: num(k("expert_used_count")),
    totalParams, embeddingParams, outputParams, quantMix,
    fileType: num(m["general.file_type"]) != null ? FILE_TYPES[num(m["general.file_type"])!] ?? null : null,
  };
}

const cache = new Map<string, { mtimeMs: number; arch: ModelArchitecture }>();

export function readModelArchitecture(file: string): ModelArchitecture {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.arch;
  const arch = summarizeArchitecture(readGgufHeader(file));
  cache.set(file, { mtimeMs: st.mtimeMs, arch });
  return arch;
}
