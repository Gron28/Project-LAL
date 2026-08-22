import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertFixtureCatalog, listFixtures, writeFixture } from '../benchmarks/codex-harness-ab/fixtures.mjs';
import { gateVerdict, headroom, isMutation, scratchWrites, shellPayload, stripHeredocs, isVerification, parityReport, prepareReferenceConfigDir, referenceArgs, referenceEnv, REFERENCE_SCRUBBED_ENV, schedule, summarizeTrace, TAXONOMY, workspaceViolations } from './codex-harness-ab.mjs';

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
  // Scratch under the system temp directory is ordinary agent behaviour: it
  // is recorded, but it does not fail the containment gate.
  assert.deepEqual(workspaceViolations([
    { name: 'run_shell_command', input: { command: 'cp /bench/repo/src/a.mjs /tmp/a.mjs' } },
  ], repo), []);
  assert.deepEqual(scratchWrites([
    { name: 'run_shell_command', input: { command: 'cp /bench/repo/src/a.mjs /tmp/a.mjs' } },
  ], repo), [{ tool: 'run_shell_command', path: '/tmp/a.mjs' }]);
  assert.deepEqual(workspaceViolations([
    { name: 'run_shell_command', input: { command: 'cp /bench/repo/src/a.mjs /home/operator/stolen.mjs' } },
  ], repo), [{ tool: 'run_shell_command', path: '/home/operator/stolen.mjs' }]);
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
  ], repo, TAXONOMY.reference), []);
  assert.deepEqual(workspaceViolations([
    { name: 'Bash', input: { command: 'cp /bench/repo/src/a.mjs /etc/cron.d/pwn' } },
  ], repo, TAXONOMY.reference), [{ tool: 'Bash', path: '/etc/cron.d/pwn' }]);
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
  assert.deepEqual(gap.byFixture.b.reference, { runs: 1, passes: 1, medianScore: 100, medianWallMs: 1000, medianTotalTokens: 0, floor: null, medianHeadroom: null });
  assert.deepEqual(gap.byFixture.b.local, { runs: 1, passes: 0, medianScore: 40, medianWallMs: 2000, medianTotalTokens: 0, floor: null, medianHeadroom: null });
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

test('reference config dir carries credentials and nothing else', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-config-'));
  const source = path.join(root, 'source-claude');
  fs.mkdirSync(source);
  // Everything the operator's real config directory would otherwise contribute.
  fs.writeFileSync(path.join(source, '.credentials.json'), '{"token":"secret"}');
  fs.writeFileSync(path.join(source, 'settings.json'), '{"model":"other"}');
  fs.writeFileSync(path.join(source, 'CLAUDE.md'), 'operator instructions');
  fs.mkdirSync(path.join(source, 'plugins'));

  const home = path.join(root, 'home');
  const configDir = prepareReferenceConfigDir(home, source);
  assert.deepEqual(fs.readdirSync(configDir), ['.credentials.json']);
  assert.equal(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8'), '{"token":"secret"}');
  assert.equal(fs.statSync(path.join(configDir, '.credentials.json')).mode & 0o777, 0o600);

  fs.rmSync(path.join(source, '.credentials.json'));
  assert.throws(() => prepareReferenceConfigDir(path.join(root, 'home2'), source), /needs credentials/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('reference arm cannot spawn subagents or reach the network', () => {
  const args = referenceArgs({ prompt: 'p', repo: '/r', model: 'opus' });
  const disallowed = args.slice(args.indexOf('--disallowed-tools') + 1);
  // Subagents would give the reference parallel compute the local arms lack,
  // and hide an unbounded number of billable sessions behind one run.
  for (const tool of ['WebSearch', 'WebFetch', 'Task']) assert.ok(disallowed.includes(tool), `${tool} must be disallowed`);
});

test('classifier survives the shell shapes a real agent actually emits', () => {
  const reference = TAXONOMY.reference;
  const bash = (command) => ({ name: 'Bash', input: { command } });
  // Every case below is a verbatim shape from the first reference trace that
  // the original classifier got wrong.
  assert.equal(isMutation(bash('ls -la && cat TASK.md package.json 2>/dev/null'), reference), false, 'fd redirection is not a file write');
  assert.equal(isMutation(bash("git add -A && git commit -q -F - <<'EOF' && git status --short\nFix boundary\nEOF"), reference), false, 'commit message body is not shell');
  assert.equal(isMutation(bash("cat > src/x.mjs <<'EOF'\nconst a = b > c;\nEOF"), reference), true, 'redirect into a file is a write');
  // A command that both edits and tests must count as both, or the last real
  // edit looks unverified.
  const both = bash('cp src/x.mjs /tmp/fixed.mjs && git stash -q && npm test');
  assert.equal(isMutation(both, reference), true);
  assert.equal(isVerification(both, reference), true);
  // A heredoc fed to an interpreter can write anything invisibly.
  assert.equal(isMutation(bash("python3 - <<'PY'\nopen('src/x.mjs','w').write('hi')\nPY"), reference), true);
  // Relative paths must not be read as absolute ones.
  assert.deepEqual(workspaceViolations([bash('cat -n src/rate-window.mjs && cat -n test/rate-window.test.mjs')], '/bench/repo', reference), []);
});

test('heredoc bodies are stripped but trailing commands survive', () => {
  const payload = stripHeredocs("cat >> test/a.mjs <<'EOF'\nnpm run build\nEOF\nnpm test | tail -25");
  assert.equal(payload.includes('npm run build'), false, 'heredoc body must not be scanned');
  assert.equal(payload.includes('npm test'), true, 'the command after the heredoc must survive');
  assert.equal(shellPayload({ input: { command: 'cat a.txt 2>/dev/null 2>&1' } }).includes('>'), false);
});

test('scores are normalised against the measured floor of each fixture', () => {
  // An untouched 05-ledger-refactor already scores 65, so 82 is a third of the
  // available headroom, not "82%".
  assert.equal(headroom(65, 65), 0);
  assert.equal(headroom(100, 65), 1);
  assert.equal(Math.round(headroom(82, 65) * 100), 49);
  assert.equal(headroom(50, 5), 45 / 95);
  assert.equal(headroom(90, undefined), null, 'an unmeasured fixture has no headroom');
  assert.equal(headroom(10, 55), 0, 'scoring below the floor is clamped');

  const make = (engine, fixture, pass, score) => ({ engine, fixture, pass, score, wallMs: 1000, hardGates: { safety: true } });
  // `b` passes every discriminator untouched, so it measures nothing. A
  // refactor fixture that passes `hidden` but fails `behavior` is legitimate.
  const floors = {
    a: { score: 55, hiddenPasses: false, behaviorPasses: true },
    b: { score: 65, hiddenPasses: true, behaviorPasses: true },
    c: { score: 65, hiddenPasses: true, behaviorPasses: false },
  };
  const parity = parityReport([
    make('reference', 'a', true, 100), make('reference', 'b', true, 100),
    make('reference', 'c', true, 100),
    make('qwen', 'a', false, 55), make('qwen', 'b', false, 65), make('qwen', 'c', false, 65),
  ], ['qwen', 'reference'], floors);
  // Both local runs scored at the floor: they captured none of the headroom.
  assert.equal(parity.gaps[0].byFixture.a.local.medianHeadroom, 0);
  assert.equal(parity.gaps[0].byFixture.a.reference.medianHeadroom, 1);
  // A fixture whose hidden check passes untouched cannot discriminate.
  assert.deepEqual(parity.degenerateFixtures, ['b'], 'only a fixture with no working discriminator is degenerate');
  assert.match(parity.degenerateNote, /cannot tell a solved task from an unsolved one/);
});
