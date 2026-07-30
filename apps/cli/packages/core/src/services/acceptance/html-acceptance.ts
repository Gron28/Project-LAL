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
import { validateStaticHtmlDocument } from '@lal/protocol/agent-runtime';

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
  const shared = validateStaticHtmlDocument(html);
  const codeMap: Record<string, string> = {
    'script-balance': 'unterminated-script',
    'javascript-syntax': 'js-syntax-error',
    'element-references': 'missing-element',
    'self-contained': 'remote-dependency',
    'no-placeholder': 'placeholder-stub',
    'nonempty-handlers': 'empty-handler',
    'interactive-script': 'no-script',
  };
  const findings: AcceptanceFinding[] = shared.checks
    .filter((check) => !check.passed)
    .map((check) => ({
      severity: 'fatal',
      code: codeMap[check.code] || check.code,
      message: check.detail,
    }));

  return {
    criteria: 'web-artifact',
    artifact,
    findings,
    unchecked: shared.uncheckedProperties,
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
