#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.LAL_BASE_URL || "http://127.0.0.1:8770";
const mode = process.argv.includes("--weekly") ? "weekly" : "daily";

async function getJson(route) {
  const response = await fetch(`${BASE_URL}${route}`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${route} returned HTTP ${response.status}`);
  return response.json();
}

function checkStateFiles() {
  const directory = path.join(REPO, "web", ".data");
  if (!fs.existsSync(directory)) return 0;
  let checked = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    checked++;
  }
  return checked;
}

async function main() {
  const stat = fs.statfsSync(REPO);
  const freeBytes = stat.bavail * stat.bsize;
  if (freeBytes < 2 * 1024 ** 3) throw new Error(`storage headroom is low: ${freeBytes} bytes free`);
  const [system, jobs] = await Promise.all([getJson("/api/sysinfo"), getJson("/api/v1/jobs?limit=200")]);
  const activeJobs = (jobs.jobs || []).filter((job) => ["queued", "running", "paused", "awaiting_approval"].includes(job.status));
  const result = { ok: true, mode, freeBytes, stateFiles: checkStateFiles(), runLive: !!system.runLive, activeJobs: activeJobs.length, weeklySkipped: false };
  if (mode === "weekly") {
    if (system.runLive || activeJobs.length || system.training?.running || system.lens?.running) {
      result.weeklySkipped = true;
    } else {
      const test = spawnSync("npm", ["test"], { cwd: REPO, encoding: "utf8", timeout: 15 * 60_000 });
      if (test.status !== 0) throw new Error(`weekly repository smoke failed:\n${(test.stdout + test.stderr).slice(-8_000)}`);
    }
  }
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, mode, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
