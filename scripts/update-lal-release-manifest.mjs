#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!version || !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) {
  throw new Error('Usage: update-lal-release-manifest.mjs VERSION');
}

const manifestPath = path.join(root, 'web', 'public', 'lal', 'manifest.json');
const archiveRelative = `/lal/releases/${version}/lal-cli-win-x64.zip`;
const archivePath = path.join(root, 'web', 'public', archiveRelative);
if (!fs.existsSync(archivePath)) {
  throw new Error(`Windows archive not found: ${archivePath}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.lalRuntimeVersion = version;
manifest.windowsArchive = archiveRelative;
manifest.windowsSha256 = crypto
  .createHash('sha256')
  .update(fs.readFileSync(archivePath))
  .digest('hex');

const temporary = `${manifestPath}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
fs.renameSync(temporary, manifestPath);
console.log(`Pinned LAL ${version} (${manifest.windowsSha256})`);
