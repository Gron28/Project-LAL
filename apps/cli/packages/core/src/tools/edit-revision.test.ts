/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  assessReplaceAllBlastRadius,
  detectEditRegression,
  findWhitespaceDriftedMatch,
  MAX_SHORT_ANCHOR_OCCURRENCES,
  MAX_UNREVIEWED_REPLACE_ALL_OCCURRENCES,
  replaceSpan,
} from './edit-revision.js';

describe('whitespace-drifted anchors (PLAN 3.3)', () => {
  const file = ['function a() {', '    const x = 1;', '    return x;', '}', ''].join(
    '\n',
  );

  it('matches an anchor whose indentation drifted', () => {
    // Two spaces in the anchor, four in the file.
    const match = findWhitespaceDriftedMatch(
      file,
      ['  const x = 1;', '  return x;'].join('\n'),
    );
    expect(match).not.toBeNull();
    expect(match?.matched).toBe(['    const x = 1;', '    return x;'].join('\n'));
  });

  it('replaces exactly the matched span and nothing else', () => {
    const match = findWhitespaceDriftedMatch(file, '  const x = 1;\n  return x;')!;
    const next = replaceSpan(file, match, '    return 42;');
    expect(next).toBe(['function a() {', '    return 42;', '}', ''].join('\n'));
  });

  it('refuses an ambiguous drifted match — editing an unlooked-at place is worse', () => {
    const twice = ['if (a) {', '  go();', '}', 'if (b) {', '  go();', '}'].join(
      '\n',
    );
    expect(findWhitespaceDriftedMatch(twice, '        go();')).toBeNull();
  });

  it('refuses a single short line as too weak an anchor', () => {
    expect(findWhitespaceDriftedMatch(file, '}')).toBeNull();
    expect(findWhitespaceDriftedMatch(file, '  return x;')).toBeNull();
  });

  it('accepts a single long line', () => {
    expect(
      findWhitespaceDriftedMatch(file, 'const x = 1;'),
    ).not.toBeNull();
  });

  it('returns null for an empty or whitespace-only anchor', () => {
    expect(findWhitespaceDriftedMatch(file, '')).toBeNull();
    expect(findWhitespaceDriftedMatch(file, '   \n  ')).toBeNull();
  });
});

describe('damaging-patch rejection (PLAN 3.3)', () => {
  const good = `<html><body>
<button id="shuffle">go</button>
<div id="out"></div>
<script>
document.getElementById('shuffle').addEventListener('click', () => {
  document.getElementById('out').textContent = 'x';
});
</script>
</body></html>`;

  it('rejects an edit that deletes a control the script still uses', async () => {
    const damaged = good.replace('<button id="shuffle">go</button>\n', '');
    const regression = await detectEditRegression('/x/index.html', good, damaged);
    expect(regression).not.toBeNull();
    expect(regression?.findings.map((f) => f.code)).toContain('missing-element');
    expect(regression?.message).toContain('UNCHANGED');
  });

  it('rejects an edit that breaks the script syntax', async () => {
    const damaged = good.replace("=> {", "=> {{");
    const regression = await detectEditRegression('/x/index.html', good, damaged);
    expect(regression?.findings.map((f) => f.code)).toContain('js-syntax-error');
  });

  it('rejects an edit that deletes a closing </script> tag', async () => {
    // This case produced NO findings at all before 2026-07-25: the script
    // extractor requires a closing tag, so an unterminated script was invisible
    // while the page was completely broken.
    const damaged = good.replace('</script>', '');
    const regression = await detectEditRegression('/x/index.html', good, damaged);
    expect(regression?.findings.map((f) => f.code)).toContain(
      'unterminated-script',
    );
  });

  it('allows a harmless edit', async () => {
    const fine = good.replace(">go<", ">Shuffle<");
    expect(await detectEditRegression('/x/index.html', good, fine)).toBeNull();
  });

  it('does not hold a PRE-EXISTING defect against the edit', async () => {
    // Already broken: the script references an id that does not exist.
    const broken = `<html><body><script>document.getElementById('ghost').focus();</script></body></html>`;
    const stillBroken = broken.replace('.focus()', '.blur()');
    // Refusing here would make repairing an already-broken file impossible.
    expect(await detectEditRegression('/x/index.html', broken, stillBroken)).toBeNull();
  });

  it('allows an edit that REMOVES a pre-existing defect', async () => {
    const broken = `<html><body><script>document.getElementById('ghost').focus();</script></body></html>`;
    const fixed = broken.replace(
      '<script>',
      '<div id="ghost"></div><script>',
    );
    expect(await detectEditRegression('/x/index.html', broken, fixed)).toBeNull();
  });

  it('stays silent for file types no criteria covers', async () => {
    expect(await detectEditRegression('/x/main.py', 'a = 1', 'a = ')).toBeNull();
  });
});

describe('replace_all blast radius (PLAN 3.3)', () => {
  it('refuses a tiny anchor across multiple locations', () => {
    const refusal = assessReplaceAllBlastRadius('x', 30);
    expect(refusal).toContain('1-character anchor');
    expect(refusal).toContain('30 locations');
  });

  it('allows a tiny anchor when it matches exactly once', () => {
    expect(assessReplaceAllBlastRadius('x', 1)).toBeNull();
  });

  it('allows a short anchor across a handful of sites — that is ordinary work', () => {
    // Renaming a three-letter variable in three places is legitimate and all
    // three fit on one screen. An earlier bound of >1 here failed a real test.
    expect(assessReplaceAllBlastRadius('foo', 3)).toBeNull();
    expect(assessReplaceAllBlastRadius('foo', MAX_SHORT_ANCHOR_OCCURRENCES)).toBeNull();
    expect(
      assessReplaceAllBlastRadius('foo', MAX_SHORT_ANCHOR_OCCURRENCES + 1),
    ).not.toBeNull();
  });

  it('allows a substantial anchor across a few locations', () => {
    expect(assessReplaceAllBlastRadius('const oldName = require', 5)).toBeNull();
  });

  it('caps the number of unreviewed rewrites even with a good anchor', () => {
    const many = MAX_UNREVIEWED_REPLACE_ALL_OCCURRENCES + 1;
    expect(assessReplaceAllBlastRadius('a fairly long anchor string', many)).toContain(
      `${many} locations`,
    );
  });
});
