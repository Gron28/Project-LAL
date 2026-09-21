/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the SIGINT/SIGTERM checkpoint-loss bug: on shutdown,
 * `Config.shutdown()` aborted `backgroundTaskRegistry`, `monitorRegistry`,
 * and `backgroundShellRegistry`, but never `workflowRunRegistry` — so a
 * running native `Workflow` tool's `AbortSignal` was never triggered, its
 * `finally` block (which writes the resumable snapshot) never ran, and the
 * checkpoint was lost on Ctrl+C. This test proves `shutdown()` now cancels
 * an active workflow run (aborting its controller) and remains a safe
 * no-op when no run is registered / the registry is untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// Shared mocks needed by the Config constructor (mirrors
// config.workflows.test.ts's lightweight scaffolding).
vi.mock('node:fs');
vi.mock('node:fs/promises');
vi.mock('../telemetry/index.js', () => ({
  QwenLogger: vi.fn().mockImplementation(() => ({
    logStartSessionEvent: vi.fn().mockResolvedValue(undefined),
    logEndSessionEvent: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
  DEFAULT_TELEMETRY_TARGET: 'none',
  DEFAULT_OTLP_ENDPOINT: '',
  DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: 1024 * 1024,
  SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT: 100 * 1024 * 1024,
  isTelemetrySdkInitialized: vi.fn().mockReturnValue(false),
  shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
  refreshSessionContext: vi.fn(),
}));
vi.mock('../core/contentGenerator.js', () => ({
  resolveContentGeneratorConfigWithSources: vi.fn().mockReturnValue({
    config: { model: 'test-model', apiKey: 'test-key' },
    sources: {},
  }),
  createContentGeneratorConfig: vi.fn().mockReturnValue({}),
  createContentGenerator: vi.fn().mockReturnValue({}),
  AuthType: { API_KEY: 'apiKey' },
}));
vi.mock('../core/baseLlmClient.js');
vi.mock('../core/toolHookTriggers.js', () => ({
  fireNotificationHook: vi.fn().mockResolvedValue({}),
}));
vi.mock('../services/skillManager.js', () => {
  const SkillManagerMock = vi.fn();
  SkillManagerMock.prototype.startWatching = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.refreshCache = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.stopWatching = vi.fn();
  SkillManagerMock.prototype.listSkills = vi.fn().mockResolvedValue([]);
  SkillManagerMock.prototype.addChangeListener = vi.fn();
  SkillManagerMock.prototype.removeChangeListener = vi.fn();
  SkillManagerMock.prototype.matchAndActivateByPath = vi
    .fn()
    .mockResolvedValue([]);
  SkillManagerMock.prototype.matchAndActivateByPaths = vi
    .fn()
    .mockResolvedValue([]);
  return { SkillManager: SkillManagerMock };
});
vi.mock('../subagents/subagent-manager.js', () => {
  const SubagentManagerMock = vi.fn();
  SubagentManagerMock.prototype.loadSessionSubagents = vi.fn();
  SubagentManagerMock.prototype.addChangeListener = vi
    .fn()
    .mockReturnValue(() => {});
  SubagentManagerMock.prototype.listSubagents = vi.fn().mockResolvedValue([]);
  return { SubagentManager: SubagentManagerMock };
});
vi.mock('../ide/ide-client.js', () => ({
  IdeClient: {
    getInstance: vi.fn().mockResolvedValue({
      getConnectionStatus: vi.fn(),
      initialize: vi.fn(),
      shutdown: vi.fn(),
    }),
  },
}));
vi.mock('../memory/const.js', () => ({
  setGeminiMdFilename: vi.fn(),
}));

import * as fs from 'node:fs';
import type { ConfigParameters } from './config.js';
import { Config } from './config.js';
import type { WorkflowTaskRegistration } from '../agents/workflow-run-registry.js';

const baseParams: ConfigParameters = {
  cwd: '/tmp',
  targetDir: '/tmp',
  debugMode: false,
  model: 'test-model',
  telemetry: { enabled: false },
  usageStatisticsEnabled: false,
  overrideExtensions: [],
};

/**
 * Builds a minimal registration, matching the pattern used by
 * `workflow-run-registry.test.ts`'s own `reg()` helper.
 */
function registration(
  runId: string,
  overrides: Partial<WorkflowTaskRegistration> = {},
): WorkflowTaskRegistration {
  return {
    runId,
    meta: null,
    description: 'wf',
    status: 'running',
    startTime: Date.now(),
    outputFile: `/tmp/${runId}.jsonl`,
    abortController: new AbortController(),
    ...overrides,
  } as WorkflowTaskRegistration;
}

/**
 * Marks a freshly constructed Config as initialized without paying for
 * the full `initialize()` sequence (extensions/hooks/tool registry), the
 * same reflection technique `config.test.ts` uses in "keeps listeners
 * through shutdown flush and clears them afterward". `shutdown()` returns
 * immediately when `!this.initialized`, so the registry-abort code under
 * test is otherwise unreachable without it.
 */
function markInitialized(config: Config): void {
  (config as unknown as { initialized: boolean }).initialized = true;
}

describe('Config.shutdown() workflow run abort', () => {
  beforeEach(() => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue([]);
    (fs.statSync as Mock).mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    });
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    (fs.mkdirSync as Mock).mockImplementation(() => undefined);
    (fs.writeFileSync as Mock).mockImplementation(() => undefined);
    (fs.renameSync as Mock).mockImplementation(() => undefined);
    (fs.copyFileSync as Mock).mockImplementation(() => undefined);
    (fs.unlinkSync as Mock).mockImplementation(() => undefined);
    (fs.readFileSync as Mock).mockImplementation(() => undefined);
  });

  it('aborts the controller and cancels a running workflow entry', async () => {
    const config = new Config({ ...baseParams });
    markInitialized(config);

    const reg = registration('wf_active');
    const entry = config.getWorkflowRunRegistry().register(reg);
    expect(entry.status).toBe('running');
    expect(reg.abortController.signal.aborted).toBe(false);

    await config.shutdown();

    expect(reg.abortController.signal.aborted).toBe(true);
    expect(config.getWorkflowRunRegistry().get('wf_active')?.status).toBe(
      'cancelled',
    );
    // Evidence for the gemini.tsx-redundancy verdict (see worker report):
    // by the time `config.shutdown()` resolves, `hasRunningEntries()` is
    // already false. gemini.tsx's own compensating `registerCleanup`
    // block (registered AFTER the one that calls `config.shutdown()`,
    // and drained sequentially by `runExitCleanup`) gates its 300ms
    // grace wait behind exactly this check — so on the real SIGINT path
    // that block's `if (!workflowRegistry?.hasRunningEntries()) return;`
    // now short-circuits and the grace wait never runs. This fix closes
    // the "signal never fires" bug but does not by itself preserve the
    // grace-period behavior the compensating block was also providing.
    expect(config.getWorkflowRunRegistry().hasRunningEntries()).toBe(false);
  });

  it('does not touch an already-settled workflow entry', async () => {
    const config = new Config({ ...baseParams });
    markInitialized(config);

    const reg = registration('wf_done', { status: 'running' });
    config.getWorkflowRunRegistry().register(reg);
    config.getWorkflowRunRegistry().complete('wf_done', 'ok', Date.now());
    expect(reg.abortController.signal.aborted).toBe(false);

    await config.shutdown();

    // complete() settles without aborting; shutdown's abortAll only
    // touches entries still 'running', so a completed run's controller
    // is left alone.
    expect(reg.abortController.signal.aborted).toBe(false);
    expect(config.getWorkflowRunRegistry().get('wf_done')?.status).toBe(
      'completed',
    );
  });

  it('is a safe no-op when no workflow run was ever registered', async () => {
    const config = new Config({ ...baseParams });
    markInitialized(config);

    expect(config.getWorkflowRunRegistry().list()).toEqual([]);

    await expect(config.shutdown()).resolves.toBeUndefined();

    expect(config.getWorkflowRunRegistry().list()).toEqual([]);
  });

  it('is a safe no-op when shutdown runs before initialize (registry untouched)', async () => {
    const config = new Config({ ...baseParams });
    // Deliberately NOT calling markInitialized(): shutdown() should
    // return early (after stopping the settings watcher) without
    // throwing, same as before this fix.
    await expect(config.shutdown()).resolves.toBeUndefined();
  });
});
