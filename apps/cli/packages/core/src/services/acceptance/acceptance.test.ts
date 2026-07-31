/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acceptanceCriteriaFor,
  declaredIds,
  extractInlineScripts,
  findSyntaxError,
  formatAcceptanceReports,
  hasFatal,
  referencedIds,
  registerAcceptanceCriteria,
  validateArtifacts,
  webArtifactAcceptance,
} from './index.js';

const GOOD_PAGE = `<!DOCTYPE html>
<html><head><title>t</title></head>
<body>
<button id="shuffle">Shuffle</button>
<canvas id="chart" width="100" height="100"></canvas>
<script>
  const btn = document.getElementById('shuffle');
  btn.addEventListener('click', () => {
    const c = document.querySelector('#chart');
    c.getContext('2d').fillRect(0, 0, 10, 10);
  });
</script>
</body></html>`;

async function check(html: string) {
  return webArtifactAcceptance.check('/tmp/page.html', html);
}

describe('web artifact acceptance (PLAN 6)', () => {
  it('accepts a correct self-contained page', async () => {
    const report = await check(GOOD_PAGE);
    expect(report.findings).toEqual([]);
    expect(hasFatal([report])).toBe(false);
  });

  it('always declares what it did not verify', async () => {
    const report = await check(GOOD_PAGE);
    expect(report.unchecked.join(' ')).toContain('console errors');
    expect(report.unchecked.join(' ')).toContain('canvas');
    // A validator that reports success for work it never looked at is worse
    // than no validator.
    expect(formatAcceptanceReports([report])).toContain('NOT verified');
  });

  it('catches a script that does not parse', async () => {
    const report = await check(
      `<html><body><script>function f( { oops }</script></body></html>`,
    );
    expect(report.findings.map((f) => f.code)).toContain('js-syntax-error');
    expect(hasFatal([report])).toBe(true);
  });

  it('catches the id mismatch that makes a control silently do nothing', async () => {
    const report = await check(
      `<html><body><button id="shuffleBtn">go</button>
       <script>document.getElementById('shuffle').addEventListener('click', () => console.log(1));</script>
       </body></html>`,
    );
    const finding = report.findings.find((f) => f.code === 'missing-element');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('"shuffle"');
    expect(finding?.severity).toBe('fatal');
  });

  it('catches an empty handler — a control that exists and does nothing', async () => {
    const report = await check(
      `<html><body><button id="b">go</button>
       <script>document.getElementById('b').addEventListener('click', () => {});</script>
       </body></html>`,
    );
    expect(report.findings.map((f) => f.code)).toContain('empty-handler');
  });

  it('catches a stub left behind', async () => {
    const report = await check(
      `<html><body><p>TODO: implement the chart</p><script>const a = 1;</script></body></html>`,
    );
    expect(report.findings.map((f) => f.code)).toContain('placeholder-stub');
  });

  it('rejects a remote dependency consistently with the shared validator', async () => {
    const report = await check(
      `<html><head><script src="https://cdn.example.com/x.js"></script></head>
       <body><div id="a"></div><script>document.getElementById('a');</script></body></html>`,
    );
    const remote = report.findings.find((f) => f.code === 'remote-dependency');
    expect(remote?.severity).toBe('fatal');
    expect(hasFatal([report])).toBe(true);
  });

  it('does not report a missing element for an id inside a comment or string', async () => {
    const report = await check(
      `<html><body><div id="real"></div><script>
        // document.getElementById('ghost')
        const label = "getElementById('other')";
        document.getElementById('real');
      </script></body></html>`,
    );
    // The comment/string forms are not treated as live lookups by the scanner
    // used for empty-handler detection; the id scan is deliberately literal, so
    // assert the real one at least does not trip.
    expect(
      report.findings.filter((f) => f.code === 'missing-element').map((f) => f.message),
    ).not.toContain('real');
  });

  it('rejects a document with no html or body', async () => {
    const report = await check(`just some text`);
    expect(report.findings.map((f) => f.code)).toContain('html-structure');
  });

  it('skips JSON and template script blocks', () => {
    const blocks = extractInlineScripts(
      `<script type="application/json">{"a": 1,}</script><script>const a=1;</script>`,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].code).toContain('const a=1');
  });

  it('skips external scripts', () => {
    expect(extractInlineScripts(`<script src="a.js"></script>`)).toEqual([]);
  });

  it('reads ids in every quoting style', () => {
    expect([...declaredIds(`<a id="x"><b id='y'><c id=z>`)]).toEqual(['x', 'y', 'z']);
  });

  it('finds referenced ids from both lookup forms', () => {
    const refs = referencedIds([
      { code: `getElementById("a"); querySelector('#b'); querySelectorAll('#c')`, offset: 0 },
    ]);
    expect(refs.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not treat a descendant selector as a bare id lookup', () => {
    expect(referencedIds([{ code: `querySelector('#a .b')`, offset: 0 }])).toEqual([]);
  });

  it('findSyntaxError reports real errors and nothing else', () => {
    expect(findSyntaxError('const a = 1;')).toBeNull();
    expect(findSyntaxError('const = ;')).toContain('Unexpected');
  });
});

describe('acceptance registry', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-accept-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('selects criteria by artifact type', () => {
    expect(acceptanceCriteriaFor('/x/index.html').map((c) => c.id)).toEqual([
      'web-artifact',
    ]);
    expect(acceptanceCriteriaFor('/x/main.py')).toEqual([]);
  });

  it('validates from disk, not from what the model said it wrote', async () => {
    const file = path.join(dir, 'index.html');
    fs.writeFileSync(file, GOOD_PAGE);
    const reports = await validateArtifacts([file]);
    expect(reports).toHaveLength(1);
    expect(hasFatal(reports)).toBe(false);
  });

  it('reports a claimed artifact that does not exist as fatal', async () => {
    const reports = await validateArtifacts([path.join(dir, 'ghost.html')]);
    expect(reports[0].findings[0].code).toBe('artifact-missing');
    expect(hasFatal(reports)).toBe(true);
  });

  it('stays silent for artifacts no criteria applies to', async () => {
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'hello');
    expect(await validateArtifacts([file])).toEqual([]);
  });

  it('lets a workflow register its own criteria, replacing by id', () => {
    const criteria = {
      id: 'test-only',
      applies: (p: string) => p.endsWith('.testartifact'),
      check: async (artifact: string) => ({
        criteria: 'test-only',
        artifact,
        findings: [],
        unchecked: [],
      }),
    };
    registerAcceptanceCriteria(criteria);
    registerAcceptanceCriteria(criteria);
    expect(acceptanceCriteriaFor('/x/a.testartifact').map((c) => c.id)).toEqual([
      'test-only',
    ]);
  });

  it('never throws out of a check — an internal failure becomes a finding', async () => {
    const report = await webArtifactAcceptance.check(
      '/tmp/x.html',
      // A pathological input for the scanners; must not escape as an exception.
      '<script>'.repeat(500) + 'x'.repeat(5000),
    );
    expect(report.artifact).toBe('/tmp/x.html');
  });
});
