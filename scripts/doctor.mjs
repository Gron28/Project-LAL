#!/usr/bin/env node
// Cross-platform preflight: `npm run doctor`.
//
// Written for the fresh-clone-on-Windows case. The repo grew up on one Linux box
// and its setup knowledge lived in start.sh (bash, four systemctl calls) plus the
// operator's head, so a clone on another machine had no way to find out what was
// missing except by running things until they failed.
//
// This reports three separate things, and keeping them separate is the point:
//   REQUIRED      — without it nothing runs, on any platform.
//   OPTIONAL      — enables a capability; absence degrades, does not break.
//   PLATFORM-ONLY — genuinely tied to this Linux host. On Windows these are
//                   EXPECTED to be absent and must not read as failures.
//
// Pure Node, no shell: it has to run identically under PowerShell, cmd and bash.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const results = [];

function have(command, args = ["--version"]) {
  try {
    const out = execFileSync(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      // Windows resolves .cmd/.exe shims only through the shell.
      shell: isWindows,
    });
    return String(out).trim().split("\n")[0].slice(0, 60);
  } catch {
    return null;
  }
}

function check(tier, name, detail, fix) {
  results.push({ tier, name, ok: Boolean(detail), detail: detail || null, fix });
}

// ── REQUIRED ────────────────────────────────────────────────────────────────
const node = process.version;
const nodeMajor = Number(node.replace(/^v/, "").split(".")[0]);
check(
  "required",
  "Node >= 20",
  nodeMajor >= 20 ? node : null,
  "Install Node 20+ from nodejs.org (the web app targets modern Next.js).",
);
check("required", "npm", have("npm"), "Ships with Node.");
check(
  "required",
  "git",
  have("git"),
  "Install Git. On Windows, Git for Windows also provides the bash LAL prefers for run_shell_command.",
);
check(
  "required",
  "web/ dependencies installed",
  fs.existsSync(path.join(root, "web", "node_modules")) ? "present" : null,
  "Run: npm --prefix web install",
);
check(
  "required",
  "apps/cli dependencies installed",
  fs.existsSync(path.join(root, "apps", "cli", "node_modules")) ? "present" : null,
  "Run: npm --prefix apps/cli install",
);

// ── OPTIONAL ────────────────────────────────────────────────────────────────
check(
  "optional",
  "ollama (serves gemma4 and other ollama models)",
  have("ollama"),
  "Install from ollama.com. Without it, ollama-sourced models are unavailable; local GGUF via llama-server still works.",
);
check(
  "optional",
  "python3 (training + release verification)",
  have(isWindows ? "python" : "python3"),
  "Install Python 3.10+. Only needed for scripts/finetune_hqq.py and the release unittest.",
);
check(
  "optional",
  "llama-server binary",
  fs.existsSync(path.join(root, "llama")) ? "llama/ present" : null,
  "Only needed to serve local GGUF files. See README; this is a build artifact, not tracked in git.",
);
check(
  "optional",
  "models directory",
  fs.existsSync(path.join(root, "models")) ? "models/ present" : null,
  "Created on first model download. 34G on the development host — never cloned.",
);
check(
  "optional",
  "bash on PATH (better shell for the agent than cmd.exe)",
  have("bash", ["--version"]),
  "Git for Windows provides it. LAL prefers bash automatically when present; set LAL_SHELL=cmd to override.",
);

// ── PLATFORM-ONLY ───────────────────────────────────────────────────────────
// Absent on Windows BY DESIGN. Listed so a Windows operator can see they are
// missing on purpose rather than wondering what broke.
check(
  "platform-linux",
  "systemctl (--user service management)",
  isWindows ? "n/a on Windows" : have("systemctl"),
  "Linux only: project-lal.service runs the web host. On Windows, start it with `npm --prefix web run dev` or `npm run build && npm --prefix web start`.",
);
check(
  "platform-linux",
  "AMD ROCm / HSA override",
  isWindows
    ? "n/a on Windows"
    : process.env["HSA_OVERRIDE_GFX_VERSION"]
      ? `HSA_OVERRIDE_GFX_VERSION=${process.env["HSA_OVERRIDE_GFX_VERSION"]}`
      : null,
  "Linux+AMD only. The development host is gfx1032 presenting as gfx1030. NVIDIA machines need none of this and should NOT copy it.",
);
check(
  "platform-linux",
  "tailscale (remote access)",
  isWindows ? "n/a on Windows" : have("tailscale"),
  "Optional everywhere: only needed to reach this host from another device.",
);

// ── report ──────────────────────────────────────────────────────────────────
const ICON = { ok: "  ok  ", bad: " MISS ", na: "  --  " };
const TIER_TITLE = {
  required: "REQUIRED — nothing runs without these",
  optional: "OPTIONAL — each enables a capability; absence degrades, not breaks",
  "platform-linux": "LINUX-ONLY — absent on Windows by design, not a failure",
};

console.log(`\nLAL doctor — ${process.platform}/${process.arch}, node ${node}, ${os.cpus().length} cpu, ${Math.round(os.totalmem() / 1e9)}GB ram\n`);

let missingRequired = 0;
for (const tier of ["required", "optional", "platform-linux"]) {
  console.log(TIER_TITLE[tier]);
  for (const r of results.filter((x) => x.tier === tier)) {
    const na = tier === "platform-linux" && isWindows;
    const icon = na ? ICON.na : r.ok ? ICON.ok : ICON.bad;
    console.log(`  [${icon}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (!r.ok && !na) {
      console.log(`           ${r.fix}`);
      if (tier === "required") missingRequired += 1;
    }
  }
  console.log("");
}

if (missingRequired > 0) {
  console.log(`${missingRequired} required item(s) missing — fix those first.\n`);
  process.exit(1);
}
console.log("All required items present. Start the web host:");
console.log(
  isWindows
    ? "  npm --prefix web run build && npm --prefix web start\n"
    : "  bash scripts/rebuild-local-ai-lab.sh   (or: npm --prefix web run dev)\n",
);
