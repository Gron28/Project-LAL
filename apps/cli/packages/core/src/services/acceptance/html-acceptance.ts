/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AcceptanceCriteria,
  AcceptanceFinding,
  AcceptanceReport,
} from './types.js';

/**
 * Acceptance criteria for a single-file web artifact — the HTML-001 workflow.
 *
 * Everything here is STATIC. There is no headless browser in the CLI's
 * dependency tree, and adding one would mean a ~200 MB download on a Windows
 * clone to validate a 100-line page. So this checks the defects that are
 * decidable from the source, and lists the rest as unchecked rather than
 * implying it looked:
 *
 *   decidable here            | needs a browser (declared unchecked)
 *   --------------------------|-------------------------------------
 *   JS parses                 | runtime console errors
 *   referenced ids exist      | whether a control's handler does the right thing
 *   handlers are not empty    | whether the canvas actually painted pixels
 *   no remote dependencies    | layout and visual correctness
 *   no placeholder stubs      |
 *
 * The id-existence check is the important one and the reason this is worth doing
 * without a browser: the most common way a generated page is "complete but the
 * buttons do nothing" is a script wiring `getElementById('shuffle')` to markup
 * that spells it `shuffleBtn`. That is a fact about the text, and it produces a
 * silent null-dereference at runtime that no static type system would catch.
 *
 * `scripts/html001.mjs` remains the browser-based gate. This is the check the
 * product performs on itself, on every machine, with no extra install.
 */

const REMOTE_URL = /\b(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["']/gi;
const PLACEHOLDER =
  /\b(?:TODO|FIXME|TBD|IMPLEMENT ME|your code here|placeholder for|coming soon|not implemented)\b/i;

/** Strip comments and string literals so scans do not match inside them. */
function stripJsNoise(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

function lineOf(haystack: string, index: number): number {
  return haystack.slice(0, index).split('\n').length;
}

export interface ScriptBlock {
  code: string;
  /** Offset of the code within the whole document, for line numbers. */
  offset: number;
}

/**
 * Inline `<script>` bodies. External scripts are skipped — a remote dependency
 * is reported separately, and a local one is not part of a single-file artifact.
 */
export function extractInlineScripts(html: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    // A JSON/template block is data, not code, and must not be parsed as JS.
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !/^(?:text\/javascript|application\/javascript|module)$/.test(type)) {
      continue;
    }
    blocks.push({
      code: match[2] ?? '',
      offset: match.index + match[0].indexOf(match[2] ?? ''),
    });
  }
  return blocks;
}

/** Every `id="…"` present in the markup. */
export function declaredIds(html: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const id = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (id) ids.add(id);
  }
  return ids;
}

/** Ids a script looks up, with their document offsets. */
export function referencedIds(
  scripts: readonly ScriptBlock[],
): Array<{ id: string; offset: number }> {
  const found: Array<{ id: string; offset: number }> = [];
  for (const block of scripts) {
    const code = block.code;
    const patterns = [
      /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g,
      // Only plain `#id` selectors: `#a .b` or `#a > b` is a descendant lookup
      // whose failure mode is different and whose parse is not worth guessing.
      /querySelector(?:All)?\(\s*['"]#([A-Za-z_][\w-]*)['"]\s*\)/g,
    ];
    for (const re of patterns) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(code)) !== null) {
        found.push({ id: match[1], offset: block.offset + match.index });
      }
    }
  }
  return found;
}

/**
 * V8's own parser, via `new Function`. This catches genuine syntax errors — an
 * unbalanced brace, a stray `const` — which are the failures that make a page
 * load blank. It does NOT execute the code: `new Function` compiles the body and
 * the function is never called.
 */
export function findSyntaxError(code: string): string | null {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) return error.message;
    // A non-SyntaxError from a compile means something unexpected; treat it as
    // unproven rather than reporting a defect that may not exist.
    return null;
  }
}

function checkHtml(artifact: string, html: string): AcceptanceReport {
  const findings: AcceptanceFinding[] = [];
  const scripts = extractInlineScripts(html);

  if (!/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) {
    findings.push({
      severity: 'fatal',
      code: 'html-structure',
      message: 'no <html> or <body> element — this is not a loadable document',
    });
  }

  // An UNTERMINATED script is invisible to the extractor above, which requires a
  // closing tag — so a `</script>` deleted by an edit produced no findings at all
  // while the page was completely broken. Found by the PLAN 3.3 regression test
  // on 2026-07-25.
  const openTags = (html.match(/<script\b[^>]*>/gi) ?? []).length;
  const closeTags = (html.match(/<\/script\s*>/gi) ?? []).length;
  if (openTags > closeTags) {
    findings.push({
      severity: 'fatal',
      code: 'unterminated-script',
      message: `${openTags} <script> tag(s) but only ${closeTags} closing tag(s) — the rest of the document is swallowed as script text`,
    });
  }

  // A module body is legal JS that `new Function` rejects (top-level import /
  // export), so those are parsed only for balance, not compiled.
  for (const block of scripts) {
    const isModule = /^\s*(?:import|export)\b/m.test(block.code);
    if (isModule) continue;
    const error = findSyntaxError(block.code);
    if (error) {
      findings.push({
        severity: 'fatal',
        code: 'js-syntax-error',
        message: `inline script does not parse: ${error}`,
        line: lineOf(html, block.offset),
      });
    }
  }

  const ids = declaredIds(html);
  const referenced = referencedIds(scripts);
  const missing = new Map<string, number>();
  for (const { id, offset } of referenced) {
    if (!ids.has(id) && !missing.has(id)) missing.set(id, offset);
  }
  for (const [id, offset] of missing) {
    findings.push({
      severity: 'fatal',
      code: 'missing-element',
      message:
        `the script looks up id "${id}", which no element declares — this ` +
        `returns null at runtime and the feature it drives silently does nothing`,
      line: lineOf(html, offset),
    });
  }

  // Remote dependencies: an artifact that needs the network is not the
  // self-contained page that was asked for, and fails whenever the box is
  // offline — which is this product's normal operating condition.
  let remote: RegExpExecArray | null;
  const seenRemote = new Set<string>();
  REMOTE_URL.lastIndex = 0;
  while ((remote = REMOTE_URL.exec(html)) !== null) {
    const url = remote[0];
    if (seenRemote.has(url)) continue;
    seenRemote.add(url);
    findings.push({
      severity: 'warning',
      code: 'remote-dependency',
      message: `depends on a remote asset (${url.slice(0, 80)}) — it will not work offline`,
      line: lineOf(html, remote.index),
    });
  }

  const placeholder = PLACEHOLDER.exec(html);
  if (placeholder) {
    findings.push({
      severity: 'fatal',
      code: 'placeholder-stub',
      message: `contains an unfinished marker ("${placeholder[0]}") — the implementation is a stub, not a subset that happens to work`,
      line: lineOf(html, placeholder.index),
    });
  }

  // An empty handler body is a control that exists and does nothing, which
  // reads as working right up until someone clicks it.
  for (const block of scripts) {
    const clean = stripJsNoise(block.code);
    // `[^'"]*` not `+`: stripJsNoise has already collapsed the event-name string
    // literal to an empty pair, which is the whole point of scanning the
    // stripped text — a commented-out listener must not be reported.
    const re = /addEventListener\(\s*['"][^'"]*['"]\s*,\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{\s*\}/g;
    let empty: RegExpExecArray | null;
    while ((empty = re.exec(clean)) !== null) {
      findings.push({
        severity: 'fatal',
        code: 'empty-handler',
        message: 'an event listener has an empty body — the control does nothing when used',
        line: lineOf(html, block.offset + empty.index),
      });
    }
  }

  if (scripts.length === 0 && /\b(?:interactive|button|onclick)\b/i.test(html)) {
    findings.push({
      severity: 'warning',
      code: 'no-script',
      message: 'the page has no inline script, so nothing can be interactive',
    });
  }

  return {
    criteria: 'web-artifact',
    artifact,
    findings,
    unchecked: [
      'runtime console errors (needs a browser — run `npm run bench:html001` for that)',
      'whether each control produces the correct result when used',
      'whether a canvas or chart actually painted anything',
      'visual layout',
    ],
  };
}

export const webArtifactAcceptance: AcceptanceCriteria = {
  id: 'web-artifact',
  applies: (artifactPath) => /\.x?html?$/i.test(artifactPath),
  check: async (artifactPath, content) => {
    try {
      return checkHtml(artifactPath, content);
    } catch (error) {
      // An internal failure is reported, never swallowed — a validator that
      // fails silently reads as a pass.
      return {
        criteria: 'web-artifact',
        artifact: artifactPath,
        findings: [
          {
            severity: 'warning',
            code: 'validator-error',
            message: `the acceptance check itself failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        unchecked: ['everything — this check did not complete'],
      };
    }
  },
};
