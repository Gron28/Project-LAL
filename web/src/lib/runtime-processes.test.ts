import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRuntimeProcess, parseRuntimeProcesses } from "./runtime-processes.ts";

test("runtime inventory classifies known executable processes", () => {
  assert.equal(classifyRuntimeProcess("/opt/llama/llama-server -m model.gguf"), "llama-server");
  assert.equal(classifyRuntimeProcess("python3 /srv/finetune_lora.py --model base"), "finetune");
  assert.equal(classifyRuntimeProcess("ollama serve"), "ollama");
  assert.equal(classifyRuntimeProcess("node ./node_modules/next/dist/bin/next start -p 8770"), "other");
  assert.equal(classifyRuntimeProcess("vite --host 0.0.0.0"), "preview");
});

test("runtime inventory ignores shell commands that only mention managed process names", () => {
  const diagnostic = "/bin/bash -c ps -eo args= | rg 'llama-server|finetune'";
  assert.equal(classifyRuntimeProcess(diagnostic), "other");
  assert.deepEqual(parseRuntimeProcesses(`116800 19415 00:03 SNs 3620 ${diagnostic}`, new Set()), []);
});

test("runtime inventory preserves ownership only for registered PIDs", () => {
  const raw = [
    "101 1 00:01 Sl 405236 /opt/llama/llama-server -m model.gguf",
    "202 1 00:02 S 1000 ollama serve",
  ].join("\n");
  assert.deepEqual(parseRuntimeProcesses(raw, new Set([101])), [
    { pid: 101, ppid: 1, elapsed: "00:01", state: "Sl", rssKb: 405236, command: "/opt/llama/llama-server -m model.gguf", kind: "llama-server", ownership: "managed" },
    { pid: 202, ppid: 1, elapsed: "00:02", state: "S", rssKb: 1000, command: "ollama serve", kind: "ollama", ownership: "external" },
  ]);
});

test("runtime inventory identifies the host web process only from its service ownership", () => {
  const raw = [
    "303 1 00:03 Sl 200000 next-server (v16.2.9)",
    "304 303 00:02 Sl 400000 /opt/llama/llama-server -m model.gguf",
    "404 1 00:04 S 1000 sh -c next start -H 0.0.0.0 -p 3000",
  ].join("\n");
  assert.deepEqual(parseRuntimeProcesses(raw, new Set(), new Set([303, 304])), [
    { pid: 303, ppid: 1, elapsed: "00:03", state: "Sl", rssKb: 200000, command: "next-server (v16.2.9)", kind: "lal-web", ownership: "managed" },
    { pid: 304, ppid: 303, elapsed: "00:02", state: "Sl", rssKb: 400000, command: "/opt/llama/llama-server -m model.gguf", kind: "llama-server", ownership: "managed" },
  ]);
});
