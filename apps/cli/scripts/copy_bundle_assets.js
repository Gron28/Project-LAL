/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(__dirname, '..');
const BUNDLED_SKILL_TEST_FILE_RE =
  /\.(?:test|spec)\.(?:d\.)?[cm]?[jt]sx?(?:\.map)?$/;

export function copyBundleAssets({ root = defaultRoot } = {}) {
  const distDir = join(root, 'dist');
  const coreVendorDir = join(root, 'packages', 'core', 'vendor');

  // Create the dist directory if it doesn't exist
  if (!existsSync(distDir)) {
    mkdirSync(distDir);
  }

  // Find and copy all .sb files from packages to the root of the dist directory
  const sbFiles = glob.sync('packages/**/*.sb', { cwd: root });
  for (const file of sbFiles) {
    copyFileSync(join(root, file), join(distDir, basename(file)));
  }

  console.log('Copied sandbox profiles to dist/');

  // Copy vendor directory (contains ripgrep binaries)
  console.log('Copying vendor directory...');
  if (existsSync(coreVendorDir)) {
    const destVendorDir = join(distDir, 'vendor');
    copyRecursiveSync(coreVendorDir, destVendorDir);
    console.log('Copied vendor directory to dist/');
  } else {
    console.warn(`Warning: Vendor directory not found at ${coreVendorDir}`);
  }

  // Copy bundled skills (e.g. /review) so they are available at runtime.
  // In the esbuild bundle, import.meta.url resolves to dist/cli.js, so
  // SkillManager looks for bundled skills at dist/bundled/.
  const bundledSkillsDir = join(
    root,
    'packages',
    'core',
    'src',
    'skills',
    'bundled',
  );
  if (existsSync(bundledSkillsDir)) {
    const destBundledDir = join(distDir, 'bundled');
    fs.rmSync(destBundledDir, { recursive: true, force: true });
    copyRecursiveSync(bundledSkillsDir, destBundledDir, {
      skipEntry: isBundledSkillTestFile,
    });
    console.log('Copied bundled skills to dist/bundled/');
  } else {
    console.warn(
      `Warning: Bundled skills directory not found at ${bundledSkillsDir}`,
    );
  }

  // Copy builtin locales so bundled dist/cli.js can load UI translations at runtime.
  // Published packages already include these via prepare-package.js; bundle output
  // should mirror that behavior for local `node dist/cli.js` runs.
  const localesDir = join(root, 'packages', 'cli', 'src', 'i18n', 'locales');
  if (existsSync(localesDir)) {
    const destLocalesDir = join(distDir, 'locales');
    copyRecursiveSync(localesDir, destLocalesDir);
    console.log('Copied builtin locales to dist/locales/');
  } else {
    console.warn(`Warning: Locales directory not found at ${localesDir}`);
  }

  // Copy extension templates so bundled dist/cli.js can scaffold
  // `/extensions new` from the runtime examples directory.
  const extensionExamplesDir = join(
    root,
    'packages',
    'cli',
    'src',
    'commands',
    'extensions',
    'examples',
  );
  if (existsSync(extensionExamplesDir)) {
    const destExtensionExamplesDir = join(distDir, 'examples');
    copyRecursiveSync(extensionExamplesDir, destExtensionExamplesDir);
    console.log('Copied extension examples to dist/examples/');
  } else {
    console.warn(
      `Warning: Extension examples directory not found at ${extensionExamplesDir}`,
    );
  }

  // The Web Shell SPA copy used to live here. packages/web-shell does not
  // exist and is not in the build order, so the copy could never succeed — it
  // printed "Warning: Web Shell assets not found" on every bundle, twice per
  // npm install, training everyone to ignore build warnings. `qwen serve` runs
  // API-only, which is what it already did. Removed 2026-07-25 with the other
  // absent-workspace references (PLAN 7.2).

  console.log('\n✅ All bundle assets copied to dist/');
}

if (isDirectRun()) {
  copyBundleAssets();
}

function isDirectRun() {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

/**
 * Recursively copy directory
 */
function copyRecursiveSync(src, dest, options = {}) {
  if (!existsSync(src)) {
    return;
  }

  const stats = statSync(src);

  if (stats.isDirectory()) {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      if (entry === '.DS_Store' || options.skipEntry?.(entry)) {
        continue;
      }

      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      copyRecursiveSync(srcPath, destPath, options);
    }
  } else {
    copyFileSync(src, dest);
    // Preserve execute permissions for binaries
    const srcStats = statSync(src);
    if (srcStats.mode & 0o111) {
      fs.chmodSync(dest, srcStats.mode);
    }
  }
}

function isBundledSkillTestFile(fileName) {
  return BUNDLED_SKILL_TEST_FILE_RE.test(fileName);
}
