#!/usr/bin/env node
// Produce a redacted, reproducible snapshot of the source seams that currently
// assume this Linux/ROCm host. The output is runtime state, not source: it records
// no host name, account name, paths, tokens, environment values, or command output.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.join(root, '.data', 'diagnostics', 'host-assumptions.json');
const sourceFiles = [
  'PORTING.md',
  'start.sh',
  'update-all.sh',
  'web/run_web.sh',
  'web/src/lib/lab.ts',
  'web/src/lib/runtime-status.ts',
  'web/src/lib/sysinfo.ts',
  'scripts/fakebin/rocminfo',
  'scripts/install-project-lal-service.sh',
  'deploy/systemd/project-lal.service',
  'scripts/finetune.py',
  'scripts/finetune_hqq.py',
  'scripts/finetune_qlora.py',
  'scripts/finetune_sft_offload.py',
  'scripts/lens.py',
];

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function tags(contents) {
  const patterns = [
    ['amd-rocm', /ROCm|HSA_OVERRIDE_GFX_VERSION|rocminfo|rocm-smi/i],
    ['cuda-device', /cuda:0/i],
    ['linux-proc-sys', /\/proc\/|\/sys\//],
    ['systemd', /systemd|systemctl/i],
    ['tailscale', /tailscale/i],
    ['ollama', /ollama/i],
    ['llama-cpp', /llama\.cpp|llama-server/i],
    ['repository-state', /process\.cwd\(\)|\.data|\.venv|\/models\//],
    ['external-download', /resolve\/main|huggingface\.co|https?:\/\//i],
  ];
  return patterns.flatMap(([tag, pattern]) => pattern.test(contents) ? [tag] : []);
}

function revision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function commandAvailable(name) {
  return process.env.PATH?.split(path.delimiter).some((directory) => {
    try {
      return fs.statSync(path.join(directory, name)).isFile();
    } catch {
      return false;
    }
  }) ?? false;
}

function parseOutputArgument(argv) {
  const index = argv.indexOf('--output');
  if (index === -1) return defaultOutput;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--output requires a path');
  return path.resolve(value);
}

function main() {
  const output = parseOutputArgument(process.argv.slice(2));
  const assumptions = sourceFiles.map((relativePath) => {
    const absolutePath = path.join(root, relativePath);
    const contents = fs.readFileSync(absolutePath, 'utf8');
    return {
      path: relativePath,
      sha256: sha256(contents),
      bytes: Buffer.byteLength(contents),
      tags: tags(contents),
    };
  });
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRevision: revision(),
    host: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      node: process.version,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      commands: Object.fromEntries(
        ['ollama', 'rocm-smi', 'systemctl', 'tailscale'].map((name) => [name, commandAvailable(name)]),
      ),
    },
    assumptions,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`wrote redacted host-assumption snapshot: ${output}\n`);
}

main();
