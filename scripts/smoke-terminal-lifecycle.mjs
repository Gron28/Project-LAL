#!/usr/bin/env node
// Guarded vertical smoke for the host-to-terminal lifecycle bridge. It creates
// a short-lived client-owned run, asks the real local model one tiny question
// with native-agent tool definitions, and proves that the host wrote
// model_loading + model_ready into that run's durable ledger. The tool schema
// guards llama.cpp's stream-with-tools compatibility; tokens never leave this
// process or appear in output.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const base = (process.env.LAL_SMOKE_URL || "http://127.0.0.1:8770").replace(/\/$/, "");
const model = process.env.LAL_SMOKE_MODEL || "qwen3-4b-stock";
// The deployed Next service runs with web/ as its working directory. Keep a
// root fallback for a future launcher that deliberately changes that contract.
const tokenPath = [
  path.join(process.cwd(), "web", ".data", "cli-token"),
  path.join(process.cwd(), ".data", "cli-token"),
].find((candidate) => fs.existsSync(candidate));
if (!tokenPath) throw new Error("LAL CLI pairing token is unavailable; start the host once before this smoke.");
const token = fs.readFileSync(tokenPath, "utf8").trim();
const deviceId = `smoke-terminal-${crypto.randomUUID()}`;
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-lal-device-id": deviceId,
  "x-lal-device-name": "LAL lifecycle smoke",
  "x-lal-platform": process.platform,
  "x-lal-client-version": "smoke",
};

async function request(pathname, init = {}) {
  const response = await fetch(base + pathname, init);
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${await response.text()}`);
  return response;
}

const status = await request("/api/sysinfo").then((response) => response.json());
if (status.runLive || status.runtime?.activeRuns?.length || status.runtime?.serving?.alive) {
  throw new Error("Refusing terminal lifecycle smoke: Project-LAL is not idle.");
}

let runId = "";
let ingestToken = "";
try {
  const registered = await request("/api/lal/runs", {
    method: "POST", headers,
    body: JSON.stringify({ kind: "code", projectLabel: "LAL lifecycle smoke", model }),
  }).then((response) => response.json());
  runId = registered.run?.id;
  ingestToken = registered.ingestToken;
  if (!runId || !ingestToken) throw new Error("client run registration returned no capability");

  const completion = await request("/api/llm/v1/chat/completions", {
    method: "POST", headers,
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 12,
      messages: [{ role: "user", content: "Reply with exactly: lifecycle smoke passed. Do not call tools." }],
      tools: [{
        type: "function",
        function: {
          name: "smoke_noop",
          description: "A smoke-test-only placeholder. Do not call it.",
          parameters: { type: "object", properties: {} },
        },
      }],
    }),
  });
  await completion.text();

  const inspection = await request(`/api/agent/runs/${encodeURIComponent(runId)}?trace=1`).then((response) => response.json());
  const events = inspection.trace?.events || [];
  const kinds = new Set(events.map((event) => event.k));
  if (!kinds.has("model_loading") || !kinds.has("model_ready")) {
    throw new Error(`terminal lifecycle events missing: ${[...kinds].join(", ") || "none"}`);
  }
  const usage = events.find((event) => event.k === "usage")?.detail || "";
  if (!/32768/.test(usage)) throw new Error(`host usage telemetry missing actual context: ${usage || "none"}`);
  const confidenceCount = events.filter((event) => event.k === "token_confidence").length;
  console.log(`==> Token-certainty frames: ${confidenceCount}${confidenceCount ? " (backend logprobs available)" : " (backend did not return logprobs)"}`);
  console.log("==> Terminal lifecycle verified: host model events and usage reached the durable client run");
} finally {
  if (runId && ingestToken) {
    await fetch(`${base}/api/lal/runs/${encodeURIComponent(runId)}/finish`, {
      method: "POST",
      headers: { ...headers, "x-lal-run-token": ingestToken },
      body: JSON.stringify({ status: "done" }),
    }).catch(() => {});
  }
  await fetch(`${base}/api/sysinfo`, { method: "DELETE" }).catch(() => {});
}

const final = await request("/api/sysinfo").then((response) => response.json());
if (final.runLive || final.runtime?.activeRuns?.length || final.runtime?.serving?.alive) {
  throw new Error("Terminal lifecycle cleanup failed: run or model is still live.");
}
console.log("==> Cleanup verified: no active run or model process remains");
