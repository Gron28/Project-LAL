#!/usr/bin/env node

/**
 * Deterministic Gate B acceptance check for inherited CLI startup egress.
 *
 * It does not open sockets. Instead it proves the supported package entry
 * applies its managed-runtime policy before loading the CLI, verifies the
 * default posture, and fails when the source or outbound inventory drifts from
 * that contract. Network interception for every CLI lifecycle phase remains a
 * later, broader acceptance layer.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyLalManagedRuntimePolicy,
  defaultLalStartupEgress,
  LAL_MANAGED_ENV,
  LAL_MANAGED_VALUE,
} from './lal-runtime-policy.mjs';

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function fail(message) {
  throw new Error(`LAL egress acceptance: ${message}`);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

async function readCliFile(relativePath) {
  return readFile(path.join(cliRoot, relativePath), 'utf8');
}

async function assertSourceEvidence(entry) {
  for (const evidence of entry.source_evidence ?? []) {
    const source = await readCliFile(evidence.path.replace(/^apps\/cli\//, ''));
    expect(
      source.includes(evidence.needle),
      `${entry.id} inventory evidence drifted: ${evidence.path}`,
    );
  }
}

const environment = { [LAL_MANAGED_ENV]: '0' };
applyLalManagedRuntimePolicy(environment);
expect(
  environment[LAL_MANAGED_ENV] === LAL_MANAGED_VALUE,
  'the package policy must override a caller-supplied unmanaged marker',
);

const defaultEgress = defaultLalStartupEgress();
expect(
  defaultEgress.inheritedRum === false,
  'default startup must disable RUM',
);
expect(
  defaultEgress.inheritedUpdateCheck === false,
  'default startup must disable inherited update checks',
);

const [
  entrypoint,
  config,
  startup,
  rumLogger,
  packageContents,
  inventoryContents,
] = await Promise.all([
  readCliFile('scripts/cli-entry.js'),
  readCliFile('packages/cli/src/config/config.ts'),
  readCliFile('packages/cli/src/startup/startup-prefetch.ts'),
  readCliFile('packages/core/src/telemetry/qwen-logger/qwen-logger.ts'),
  readCliFile('package.json'),
  readCliFile('provenance/outbound-inventory.json'),
]);

expect(
  entrypoint.includes(
    "import { applyLalManagedRuntimePolicy } from './lal-runtime-policy.mjs';",
  ) && entrypoint.includes('applyLalManagedRuntimePolicy(process.env);'),
  'the supported lal entrypoint must apply its managed runtime policy before loading CLI code',
);
expect(
  JSON.parse(packageContents).files.includes('scripts/lal-runtime-policy.mjs'),
  'the published lal package must include its runtime policy module',
);
expect(
  config.includes('usageStatisticsEnabled: false,'),
  'the supported CLI entrypoint must keep inherited usage statistics disabled',
);
expect(
  rumLogger.includes(
    'if (config === undefined || !config?.getUsageStatisticsEnabled())',
  ),
  'RUM logger must remain gated by usage statistics',
);
expect(
  startup.includes("process.env['LAL_MANAGED'] !== '1'") &&
    startup.includes('settings.merged.general?.enableAutoUpdate === true'),
  'inherited update checks must require both unmanaged execution and explicit opt-in',
);

const inventory = JSON.parse(inventoryContents);
expect(
  inventory.schema_version === 1,
  'outbound inventory must use schema version 1',
);
const expectedForbidden = new Map([
  ['inherited-alibaba-rum', 'gb4w8c3ygj-default-sea.rum.aliyuncs.com'],
  [
    'inherited-npm-update-check',
    'npm registry selected by update-notifier; no fixed host is declared in this source',
  ],
]);
for (const [id, destination] of expectedForbidden) {
  const entry = inventory.entries?.find((candidate) => candidate.id === id);
  expect(entry, `outbound inventory must include ${id}`);
  expect(
    entry.classification === 'forbidden_upstream_phone_home',
    `${id} must remain forbidden_upstream_phone_home`,
  );
  expect(entry.destination === destination, `${id} destination drifted`);
  expect(
    String(entry.acceptance_status).includes('blocked'),
    `${id} must be marked blocked by the egress acceptance contract`,
  );
  await assertSourceEvidence(entry);
}

console.log(
  'LAL egress acceptance: managed startup blocks inherited RUM and update paths.',
);
