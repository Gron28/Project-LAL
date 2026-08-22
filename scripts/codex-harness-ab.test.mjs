import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertFixtureCatalog, listFixtures, writeFixture } from '../benchmarks/codex-harness-ab/fixtures.mjs';
import { gateVerdict, isMutation, isVerification, parityReport, referenceArgs, referenceEnv, REFERENCE_SCRUBBED_ENV, schedule, summarizeTrace, TAXONOMY, workspaceViolations } from './codex-harness-ab.mjs';

test('fixture catalog is complete and disposable setup writes every task', () => {
  assertFixtureCatalog();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lal-harness-fixtures-'));
  try {
    for (const fixture of listFixtures()) {
      const repo = path.join(root, fixture.id);
      writeFixture(fixture.id, repo);
      assert.ok(fs.existsSync(path.join(repo, 'AGENTS.md')));
      assert.ok(fs.existsSync(path.join(repo, 'TASK.md')));
      assert.ok(fs.existsSync(path.join(repo, 'package.json')));
    }
    assert.equal(fs.readdirSync(path.join(root, '04-context-selection/src/domains')).length, 72);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('schedule alternates harness and fixture ordering while remaining serial', () => {
  const entries = schedule(['a', 'b'], ['qwen', 'codex'], 2);
  assert.equal(entries.length, 8);
  assert.deepEqual(entries.slice(0, 2).map((entry) => entry.engine).sort(), ['codex', 'qwen']);
  assert.deepEqual(entries.slice(4, 6).map((entry) => entry.engine).sort(), ['codex', 'qwen']);
  assert.notEqual(entries[0].fixture, entries[4].fixture);
});

test('trace summary measures tools, repetitions, errors, tokens, and post-edit verification', () => {
  const observed = [
    { at: 110, event: { type: 'system', subtype: 'init', model: 'demo' } },
    { at: 120, event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'read_file', input: { file_path: 'x' } }] } } },
    { at: 130, event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'edit', input: { file_path: 'x' } }] } } },
    { at: 140, event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'edit', input: { file_path: 'x' } }] } } },
    { at: 150, event: { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'bad' }] } } },
    { at: 160, event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'run_shell_command', input: { command: 'npm test' } }] } } },
    { at: 170, event: { type: 'result', num_turns: 4, usage: { input_tokens: 10, output_tokens: 5 }, result: 'done' } },
  ];
  const summary = summarizeTrace(observed, 100);
  assert.equal(summary.firstToolLatencyMs, 20);
  assert.equal(summary.firstMutationLatencyMs, 30);
  assert.equal(summary.repeatedToolCalls, 1);
  assert.equal(summary.toolErrors, 1);
  assert.equal(summary.verificationAfterMutation, true);
  assert.equal(summary.totalTokens, 15);
  assert.equal(summary.modelCalls, 4);
});

test('tool classifiers distinguish inspection, mutation, and verification', () => {
  assert.equal(isMutation({ name: 'edit', input: {} }), true);
  assert.equal(isMutation({ name: 'run_shell_command', input: { command: 'git status --short' } }), false);
  assert.equal(isMutation({ name: 'run_shell_command', input: { command: 'git add -A && git commit -m done' } }), false);
  assert.equal(isVerification({ name: 'run_shell_command', input: { command: 'npm run typecheck' } }), true);
});

test('workspace safety catches mutations outside the fixture and permits reads', () => {
  const repo = '/bench/repo';
  assert.deepEqual(workspaceViolations([
    { name: 'edit', input: { file_path: '/bench/repo/src/a.mjs' } },
    { name: 'run_shell_command', input: { command: 'cat /tmp/reference.txt' } },
  ], repo), []);
  assert.deepEqual(workspaceViolations([
    { name: 'run_shell_command', input: { command: 'cp /bench/repo/src/a.mjs /tmp/a.mjs' } },
  ], repo), [{ tool: 'run_shell_command', path: '/tmp/a.mjs' }]);
});

test('balanced gate implements quality and speed win paths', () => {
  const make = (engine, pass, wallMs, score = 90, safety = true) => ({ engine, pass, wallMs, score, hardGates: { safety } });
  const quality = gateVerdict([
    ...Array.from({ length: 5 }, (_, index) => make('qwen', index < 3, 1000)),
    ...Array.from({ length: 5 }, (_, index) => make('codex', index < 4, 1100)),
  ], ['qwen', 'codex']);
  assert.equal(quality.verdict, 'codex-wins');
  const unsafe = gateVerdict([make('qwen', true, 1000), make('codex', true, 500, 90, false)], ['qwen', 'codex']);
  assert.equal(unsafe.verdict, 'codex-does-not-win');
});

test('reference taxonomy classifies the frontier harness tool vocabulary', () => {
  const reference = TAXONOMY.reference;
  assert.equal(isMutation({ name: 'Edit', input: { file_path: 'x' } }, reference), true);
  assert.equal(isMutation({ name: 'Write', input: { file_path: 'x' } }, reference), true);
  assert.equal(isMutation({ name: 'Bash', input: { command: 'rm -rf src' } }, reference), true);
  assert.equal(isMutation({ name: 'Bash', input: { command: 'git status --short' } }, reference), false);
  assert.equal(isMutation({ name: 'Read', input: { file_path: 'x' } }, reference), false);
  assert.equal(isVerification({ name: 'Bash', input: { command: 'npm test' } }, reference), true);
  // The regression this guards: under the LAL vocabulary a frontier trace
  // reports no mutations and no verification at all.
  assert.equal(isMutation({ name: 'Bash', input: { command: 'rm -rf src' } }), false);
  assert.equal(isVerification({ name: 'Bash', input: { command: 'npm test' } }), false);
});

test('workspace safety is enforced for reference mutations outside the fixture', () => {
  const repo = '/bench/repo';
  assert.deepEqual(workspaceViolations([
    { name: 'Write', input: { file_path: '/bench/repo/src/a.mjs' } },
    { name: 'Bash', input: { command: 'cat /tmp/reference.txt' } },
  ], repo, TAXONOMY.reference), []);
  assert.deepEqual(workspaceViolations([
    { name: 'Write', input: { file_path: '/etc/passwd' } },
  ], repo, TAXONOMY.reference), [{ tool: 'Write', path: '/etc/passwd' }]);
  assert.deepEqual(workspaceViolations([
    { name: 'Bash', input: { command: 'cp /bench/repo/src/a.mjs /tmp/a.mjs' } },
  ], repo, TAXONOMY.reference), [{ tool: 'Bash', path: '/tmp/a.mjs' }]);
});

test('reference traces earn post-edit verification credit', () => {
  const observed = [
    { at: 110, event: { type: 'system', subtype: 'init', model: 'claude-opus-5' } },
    { at: 120, event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'x' } }] } } },
    { at: 130, event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } } },
    { at: 140, event: { type: 'result', num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  assert.equal(summarizeTrace(observed, 100, null, TAXONOMY.reference).verificationAfterMutation, true);
  assert.equal(summarizeTrace(observed, 100).verificationAfterMutation, false);
});

test('schedule stays balanced with three engines and unchanged with two', () => {
  const two = schedule(['a', 'b'], ['qwen', 'codex'], 2);
  assert.equal(two[0].engine, 'qwen');
  assert.equal(two[1].engine, 'codex');
  const three = schedule(['a', 'b'], ['qwen', 'codex', 'reference'], 2);
  assert.equal(three.length, 12);
  for (let index = 0; index < three.length; index += 3) {
    assert.deepEqual(three.slice(index, index + 3).map((entry) => entry.engine).sort(), ['codex', 'qwen', 'reference']);
    assert.equal(new Set(three.slice(index, index + 3).map((entry) => entry.fixture)).size, 1);
  }
  assert.notEqual(three[0].engine, three[3].engine);
});

test('parity reports a per-fixture gap and flags a saturated battery', () => {
  const make = (engine, fixture, pass, score, wallMs) => ({ engine, fixture, pass, score, wallMs, hardGates: { safety: true } });
  const results = [
    make('reference', 'a', true, 100, 1000),
    make('reference', 'b', true, 100, 1000),
    make('qwen', 'a', true, 90, 2000),
    make('qwen', 'b', false, 40, 2000),
  ];
  const parity = parityReport(results, ['qwen', 'reference']);
  assert.equal(parity.status, 'complete');
  assert.equal(parity.saturated, true);
  assert.match(parity.saturationNote, /Harder fixtures/);
  const gap = parity.gaps[0];
  assert.equal(gap.balanced, true);
  assert.equal(gap.passRateGap, 0.5);
  assert.equal(gap.medianScoreGap, 35);
  assert.equal(gap.medianWallRatio, 0.5);
  assert.deepEqual(gap.byFixture.b.reference, { runs: 1, passes: 1, medianScore: 100, medianWallMs: 1000 });
  assert.deepEqual(gap.byFixture.b.local, { runs: 1, passes: 0, medianScore: 40, medianWallMs: 2000 });
  assert.equal(parityReport(results, ['qwen']).status, 'pending');
  const unsaturated = parityReport([...results.slice(1), make('reference', 'a', false, 60, 1000)], ['qwen', 'reference']);
  assert.equal(unsaturated.saturated, false);
});

test('reference launch isolates configuration and never forwards the gateway credential', () => {
  const args = referenceArgs({ prompt: 'do the task', repo: '/bench/repo', model: 'opus' });
  assert.deepEqual(args.slice(0, 2), ['-p', 'do the task']);
  assert.equal(args[args.indexOf('--add-dir') + 1], '/bench/repo');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  // Network tools would give the reference arm a capability the local arms
  // do not have, which turns a parity number into an unfair comparison.
  assert.ok(args.includes('--disallowed-tools') && args.includes('WebSearch') && args.includes('WebFetch'));
  // Operator settings, MCP servers and skills must not change its tool surface.
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.ok(args.includes('--strict-mcp-config'));

  const base = { PATH: '/usr/bin', LAL_API_KEY: 'secret-token', LAL_GATEWAY_URL: 'http://127.0.0.1:8770', LAL_HOME: '/tmp/lal', HOME: '/home/operator' };
  const env = referenceEnv({ home: '/bench/run/home', base });
  for (const key of REFERENCE_SCRUBBED_ENV) assert.equal(key in env, false, `${key} must not reach the reference harness`);
  assert.equal(JSON.stringify(env).includes('secret-token'), false);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/bench/run/home/claude');
  assert.equal(env.PATH, '/usr/bin');
});
