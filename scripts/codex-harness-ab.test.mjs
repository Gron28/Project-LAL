import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertFixtureCatalog, listFixtures, writeFixture } from '../benchmarks/codex-harness-ab/fixtures.mjs';
import { gateVerdict, isMutation, isVerification, schedule, summarizeTrace, workspaceViolations } from './codex-harness-ab.mjs';

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
