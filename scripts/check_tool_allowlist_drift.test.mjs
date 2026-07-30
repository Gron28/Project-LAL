import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowlistProblems,
  parseAllowlist,
} from './check_tool_allowlist_drift.mjs';

test('a misspelled or unregistered allowlist entry fails validation', () => {
  const source = `
    export const LAL_TERMINAL_TOOLS: readonly string[] = [
      "read_file",
      "read_flie",
    ];
  `;
  const allowlist = parseAllowlist(source);
  const problems = allowlistProblems(allowlist, new Set(['read_file']));

  assert.equal(problems.length, 1);
  assert.match(problems[0], /read_flie/);
});

test('duplicate allowlist entries fail validation', () => {
  const problems = allowlistProblems(
    ['read_file', 'read_file'],
    new Set(['read_file']),
  );

  assert.equal(problems.length, 1);
  assert.match(problems[0], /duplicate allowlist entries/);
});
