/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatArtifactValidation,
  validateArtifact,
} from './artifact-validation-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function file(name: string, content: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-artifact-test-'));
  roots.push(root);
  const target = path.join(root, name);
  fs.writeFileSync(target, content);
  return target;
}

describe('artifact validation', () => {
  it('rejects invalid inline JavaScript and missing DOM references', () => {
    const report = validateArtifact(
      file(
        'index.html',
        '<div id="ok"></div><script>document.getElementById("missing"); const x = ;</script>',
      ),
    );
    expect(report.status).toBe('failed');
    expect(
      report.checks.find((item) => item.id === 'html.dom_references')?.status,
    ).toBe('failed');
    expect(
      report.checks.find((item) => item.id === 'html.script_syntax')?.status,
    ).toBe('failed');
    expect(formatArtifactValidation(report)).toContain('status=failed');
  });

  it('records a hash and passes coherent HTML', () => {
    const report = validateArtifact(
      file(
        'index.html',
        '<button id="go">go</button><script>document.getElementById("go").click();</script>',
      ),
    );
    expect(report.status).toBe('passed');
    expect(report.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('reports non-parser source files as partially validated', () => {
    const report = validateArtifact(
      file('thing.ts', 'export const value = 1;'),
    );
    expect(report.status).toBe('partial');
    expect(report.checks.every((item) => item.status === 'passed')).toBe(true);
  });

  it('parses JavaScript modules without treating imports as CommonJS errors', () => {
    const report = validateArtifact(
      file('module.js', "import fs from 'node:fs'; export { fs };"),
    );
    expect(report.status).toBe('passed');
  });
});
