import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function requireFile(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  if (!fs.existsSync(filePath)) {
    errors.push(`Missing required release file: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

function requireText(label, contents, text) {
  if (!contents.includes(text)) {
    errors.push(`${label} must contain ${JSON.stringify(text)}`);
  }
}

function requirePackageFile(packageJson, packageLabel, fileName) {
  if (!packageJson.files?.includes(fileName)) {
    errors.push(`${packageLabel} must package ${fileName}`);
  }
}

const license = requireFile('LICENSE');
const notice = requireFile('NOTICE-LAL.md');
requireText('LICENSE', license, 'Apache License');
requireText('LICENSE', license, 'Copyright 2025 Google LLC');
requireText('LICENSE', license, 'Copyright 2025 Qwen');
requireText(
  'NOTICE-LAL.md',
  notice,
  'Apache-2.0-derived portions of both Qwen Code and Gemini',
);
requireText(
  'NOTICE-LAL.md',
  notice,
  'exact Qwen and Gemini base commits are not\nrecorded in the available local history',
);

const rootPackageJson = JSON.parse(requireFile('package.json'));
requirePackageFile(rootPackageJson, 'apps/cli/package.json', 'LICENSE');
requirePackageFile(rootPackageJson, 'apps/cli/package.json', 'NOTICE-LAL.md');

const preparePackageSource = requireFile('scripts/prepare-package.js');
requireText(
  'scripts/prepare-package.js',
  preparePackageSource,
  "['NOTICE-LAL.md', 'NOTICE-LAL.md']",
);
requireText('scripts/prepare-package.js', preparePackageSource, "'NOTICE-LAL.md'");

const standaloneSource = requireFile('scripts/create-standalone-package.js');
requireText('scripts/create-standalone-package.js', standaloneSource, "'NOTICE-LAL.md'");
requireText(
  'scripts/create-standalone-package.js',
  standaloneSource,
  'for (const fileName of ROOT_REQUIRED_PATHS)',
);
requireText(
  'scripts/create-standalone-package.js',
  standaloneSource,
  'path.join(packageRoot, fileName)',
);

const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(distDir)) {
  const distPackageJson = JSON.parse(
    fs.readFileSync(path.join(distDir, 'package.json'), 'utf8'),
  );
  requirePackageFile(distPackageJson, 'prepared dist/package.json', 'LICENSE');
  requirePackageFile(distPackageJson, 'prepared dist/package.json', 'NOTICE-LAL.md');
  for (const fileName of ['LICENSE', 'NOTICE-LAL.md']) {
    if (!fs.existsSync(path.join(distDir, fileName))) {
      errors.push(`Prepared dist package is missing ${fileName}`);
    }
  }
}

if (errors.length > 0) {
  console.error('Release attribution check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Release attribution: source and prepared package notices verified.');
}
