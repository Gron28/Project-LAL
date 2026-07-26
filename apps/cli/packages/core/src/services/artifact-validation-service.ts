/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type ArtifactValidationCheck = {
  id: string;
  severity: 'fatal' | 'error' | 'warning' | 'info';
  status: 'passed' | 'failed' | 'not-run';
  message: string;
  evidence?: string;
};

export type ArtifactValidationReport = {
  artifact: string;
  hash: string | null;
  status: 'passed' | 'failed' | 'partial';
  checks: ArtifactValidationCheck[];
};

function check(
  id: string,
  passed: boolean,
  message: string,
  evidence?: string,
): ArtifactValidationCheck {
  return {
    id,
    severity: passed ? 'info' : 'fatal',
    status: passed ? 'passed' : 'failed',
    message,
    ...(evidence ? { evidence } : {}),
  };
}

function nodeSyntaxCheck(
  source: string,
  suffix: '.js' | '.mjs',
): { passed: boolean; evidence?: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-validate-'));
  const target = path.join(directory, `artifact${suffix}`);
  try {
    fs.writeFileSync(target, source, 'utf8');
    const result = spawnSync(process.execPath, ['--check', target], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const evidence = `${result.stderr || result.stdout || ''}`.trim();
    return {
      passed: result.status === 0,
      ...(evidence ? { evidence: evidence.slice(0, 4_000) } : {}),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function validateHtml(content: string): ArtifactValidationCheck[] {
  const checks: ArtifactValidationCheck[] = [];
  const ids = new Set(
    [...content.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(
      (match) => match[1],
    ),
  );
  const referenced = [
    ...content.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  const missing = [...new Set(referenced.filter((id) => !ids.has(id)))];
  checks.push(
    check(
      'html.dom_references',
      missing.length === 0,
      missing.length
        ? `Referenced DOM IDs do not exist: ${missing.join(', ')}`
        : 'Every static getElementById reference has a matching element ID.',
    ),
  );

  const scripts = [
    ...content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
  ].filter(
    (match) =>
      !/\btype\s*=\s*["'](?:application\/json|importmap)["']/i.test(
        match[1] || '',
      ),
  );
  if (!scripts.length) {
    checks.push({
      id: 'html.script_syntax',
      severity: 'info',
      status: 'not-run',
      message: 'No inline JavaScript blocks to parse.',
    });
    return checks;
  }
  const failures: string[] = [];
  scripts.forEach((script, index) => {
    const module = /\btype\s*=\s*["']module["']/i.test(script[1] || '');
    const result = nodeSyntaxCheck(script[2], module ? '.mjs' : '.js');
    if (!result.passed)
      failures.push(
        `script ${index + 1}: ${result.evidence || 'syntax check failed'}`,
      );
  });
  checks.push(
    check(
      'html.script_syntax',
      failures.length === 0,
      failures.length
        ? `${failures.length} inline script block(s) failed JavaScript syntax validation.`
        : `${scripts.length} inline script block(s) passed JavaScript syntax validation.`,
      failures.join('\n').slice(0, 4_000),
    ),
  );
  return checks;
}

/** Cheap deterministic validation that is safe to run after every successful
 * edit/write. It establishes mutation sanity and syntax evidence; project-wide
 * tests and browser interaction remain separate completion requirements. */
export function validateArtifact(filePath: string): ArtifactValidationReport {
  const checks: ArtifactValidationCheck[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      artifact: filePath,
      hash: null,
      status: 'failed',
      checks: [
        check(
          'file.readable',
          false,
          'Mutated artifact is not readable.',
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  }
  const hash = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  checks.push(
    check(
      'file.readable',
      true,
      `Artifact exists and is readable (${Buffer.byteLength(content)} bytes).`,
    ),
  );
  const conflictMarkers = /^(?:<{7}|={7}|>{7})(?: .*)?$/m.test(content);
  checks.push(
    check(
      'file.conflict_markers',
      !conflictMarkers,
      conflictMarkers
        ? 'Unresolved merge-conflict markers remain.'
        : 'No unresolved merge-conflict markers found.',
    ),
  );

  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') {
    try {
      JSON.parse(content);
      checks.push(check('json.syntax', true, 'JSON parsed successfully.'));
    } catch (error) {
      checks.push(
        check(
          'json.syntax',
          false,
          'JSON syntax is invalid.',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  } else if (
    extension === '.js' ||
    extension === '.mjs' ||
    extension === '.cjs'
  ) {
    const result = nodeSyntaxCheck(
      content,
      extension === '.cjs' ? '.js' : '.mjs',
    );
    checks.push(
      check(
        'javascript.syntax',
        result.passed,
        result.passed
          ? 'JavaScript syntax check passed.'
          : 'JavaScript syntax check failed.',
        result.evidence,
      ),
    );
  } else if (extension === '.html' || extension === '.htm') {
    checks.push(...validateHtml(content));
  }
  const failed = checks.some(
    (item) => item.status === 'failed' && item.severity === 'fatal',
  );
  const ranSyntax = checks.some((item) =>
    /syntax|dom_references/.test(item.id),
  );
  return {
    artifact: filePath,
    hash,
    status: failed ? 'failed' : ranSyntax ? 'passed' : 'partial',
    checks,
  };
}

export function formatArtifactValidation(
  report: ArtifactValidationReport,
): string {
  const failures = report.checks.filter((item) => item.status === 'failed');
  const summary = failures.length
    ? failures
        .map(
          (item) =>
            `${item.id}: ${item.message}${item.evidence ? `\n${item.evidence}` : ''}`,
        )
        .join('\n')
    : report.checks.map((item) => `${item.id}: ${item.status}`).join(', ');
  return `[artifact_validation status=${report.status} artifact=${JSON.stringify(report.artifact)} hash=${report.hash || 'unavailable'}]\n${summary}\n[/artifact_validation]`;
}
