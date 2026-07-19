#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const inventoryPaths = [
  'apps/cli/provenance/initial-ledger.json',
  'apps/cli/provenance/outbound-inventory.json',
];

function fail(message) {
  throw new Error(`CLI audit inventory: ${message}`);
}

async function readJson(relativePath) {
  const contents = await readFile(path.join(root, relativePath), 'utf8');
  try {
    return JSON.parse(contents);
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

async function verifyEvidence(inventoryPath, entry) {
  if (!entry.id || !Array.isArray(entry.source_evidence)) {
    fail(`${inventoryPath} has an entry without id or source_evidence`);
  }
  for (const evidence of entry.source_evidence) {
    if (!evidence.path || !evidence.needle) {
      fail(`${inventoryPath}:${entry.id} has incomplete source evidence`);
    }
    const evidencePath = path.join(root, evidence.path);
    try {
      await access(evidencePath);
    } catch {
      fail(`${inventoryPath}:${entry.id} references missing ${evidence.path}`);
    }
    const source = await readFile(evidencePath, 'utf8');
    if (!source.includes(evidence.needle)) {
      fail(
        `${inventoryPath}:${entry.id} source anchor no longer matches ${evidence.path}`,
      );
    }
  }
}

for (const inventoryPath of inventoryPaths) {
  const inventory = await readJson(inventoryPath);
  if (inventory.schema_version !== 1 || !Array.isArray(inventory.entries)) {
    fail(`${inventoryPath} must declare schema_version 1 and entries[]`);
  }
  const ids = new Set();
  for (const entry of inventory.entries) {
    if (ids.has(entry.id))
      fail(`${inventoryPath} repeats entry id ${entry.id}`);
    ids.add(entry.id);
    await verifyEvidence(inventoryPath, entry);
  }
}

console.log('CLI audit inventories: source anchors verified.');
