#!/usr/bin/env node

/**
 * Executes the supported LAL entrypoint under a test-only egress interceptor.
 * The test makes no network calls: standard Node DNS, socket, HTTP, fetch,
 * and child-process primitives are blocked before reaching the host.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preloadPath = path.join(cliRoot, 'scripts/egress-interception-preload.cjs');
const entrypointPath = path.join(cliRoot, 'scripts/cli-entry.js');

function fail(message) {
  throw new Error(`LAL runtime egress acceptance: ${message}`);
}

function runAudited(args, logPath) {
  return spawnSync(process.execPath, args, {
    cwd: cliRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLI_VERSION: '0.0.0-egress-audit',
      LAL_MANAGED: '0',
      LAL_EGRESS_AUDIT_LOG: logPath,
      NODE_OPTIONS: `--require=${preloadPath}`,
    },
  });
}

async function readEvents(logPath) {
  try {
    return (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

const auditDirectory = await mkdtemp(path.join(tmpdir(), 'lal-egress-audit-'));
try {
  const entryLog = path.join(auditDirectory, 'entrypoint.jsonl');
  const entrypoint = runAudited([entrypointPath, '--version'], entryLog);
  if (entrypoint.error) {
    fail(`could not start intercepted entrypoint: ${entrypoint.error.message}`);
  }
  if (entrypoint.status !== 0) {
    fail(`supported entrypoint failed under interception: ${entrypoint.stderr}`);
  }
  if (entrypoint.stdout.trim() !== '0.0.0-egress-audit') {
    fail(
      `supported entrypoint did not complete its deterministic version path: ${JSON.stringify(entrypoint.stdout)}` +
        ` (status=${entrypoint.status}, stderr=${JSON.stringify(entrypoint.stderr)})`,
    );
  }
  const entryEvents = await readEvents(entryLog);
  if (entryEvents.length !== 0) {
    fail(`supported entrypoint attempted egress: ${JSON.stringify(entryEvents)}`);
  }

  const probeLog = path.join(auditDirectory, 'probe.jsonl');
  const probe = runAudited(
    [
      '--input-type=module',
      '--eval',
      [
        "import dns from 'node:dns';",
        "import net from 'node:net';",
        "import https from 'node:https';",
        "import { spawnSync } from 'node:child_process';",
        'const attempts = [];',
        "dns.lookup('audit.invalid', () => attempts.push('dns.lookup'));",
        "dns.promises.lookup('audit.invalid').catch(() => attempts.push('dns.promises.lookup'));",
        "const socket = net.connect({ host: '198.51.100.1', port: 443 });",
        "socket.on('error', () => attempts.push('net.connect'));",
        "try { https.request('https://audit.invalid'); } catch { attempts.push('https.request'); }",
        "await fetch('https://audit.invalid').catch(() => attempts.push('fetch'));",
        "if (spawnSync('not-a-real-command').error) attempts.push('child_process.spawnSync');",
        'await new Promise((resolve) => setImmediate(resolve));',
        'if (attempts.length !== 6) process.exitCode = 1;',
      ].join(' '),
    ],
    probeLog,
  );
  if (probe.error) fail(`could not start interceptor probe: ${probe.error.message}`);
  if (probe.status !== 0) fail(`interceptor probe did not complete: ${probe.stderr}`);
  const surfaces = new Set((await readEvents(probeLog)).map((event) => event.surface));
  for (const required of [
    'dns.lookup',
    'dns.promises.lookup',
    'net.connect',
    'https.request',
    'fetch',
    'child_process.spawnSync',
  ]) {
    if (!surfaces.has(required)) fail(`interceptor did not record ${required}`);
  }
  console.log('LAL runtime egress acceptance: supported entrypoint made no audited egress attempts.');
} finally {
  await rm(auditDirectory, { recursive: true, force: true });
}
