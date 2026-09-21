/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression coverage for a defect verified against source (see the worker
 * report accompanying this change): `installInteractiveSignalHandlers` in
 * `gemini.tsx` wired SIGINT/SIGTERM to `runExitCleanup()`, and
 * `Config.shutdown()` (registered there as a cleanup) aborted the
 * background-task, monitor, and shell registries — but never the native
 * Workflow tool's own `WorkflowRunRegistry`. So killing the process
 * (Ctrl+C) while a `/hive <objective>` (or any `Workflow` tool call) was
 * running left its `AbortSignal` untouched: the workflow's own `finally`
 * block, which writes the resumable run snapshot
 * (`packages/core/src/tools/workflow/workflow.ts`), never fired, silently
 * discarding the checkpoint. In-session Esc-to-cancel and the Background
 * Tasks dialog already reach this same cancellation via
 * `WorkflowRunRegistry.cancel()` / `abortAll()` — this test proves SIGINT
 * now reaches it too.
 *
 * This file deliberately does NOT mock `./utils/cleanup.js` (unlike
 * `gemini.test.tsx`, which mocks it out for its `main()` tests and can
 * therefore only assert that `runExitCleanup` was *called*, not that the
 * registered cleanups actually drain). Using the real cleanup module lets
 * this test drive the whole chain for real: SIGINT -> real
 * `runExitCleanup()` -> drains the real registered cleanup list -> reaches
 * the workflow registry.
 *
 * `./ui/startInteractiveUI.js` IS mocked out — this test is scoped to
 * gemini.tsx's own signal-handling/cleanup-registration logic, not the
 * interactive UI stack (which has its own coverage elsewhere).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import type { Config } from '@lal/core';
// Static (not dynamic-inside-`it()`) import, matching gemini.test.tsx's own
// pattern: this pulls in gemini.tsx's whole module graph once during
// collection, so the one-time cost of evaluating it isn't charged against a
// single test's execution timeout.
import { main } from './gemini.js';
import { loadCliConfig, parseArguments } from './config/config.js';
import { loadSettings } from './config/settings.js';

vi.mock('./config/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config/settings.js')>();
  return {
    ...actual,
    loadSettings: vi.fn(),
    createMinimalSettings: vi.fn(),
  };
});

vi.mock('./config/config.js', () => ({
  loadCliConfig: vi.fn(),
  parseArguments: vi.fn().mockResolvedValue({}),
  isDebugMode: vi.fn(() => false),
  buildDisabledSkillNamesProvider: vi.fn(() => () => new Set<string>()),
}));

vi.mock('read-package-up', () => ({
  readPackageUp: vi.fn().mockResolvedValue({
    packageJson: { name: 'test-pkg', version: 'test-version' },
    path: '/fake/path/package.json',
  }),
}));

vi.mock('update-notifier', () => ({
  default: vi.fn(() => ({ notify: vi.fn() })),
}));

vi.mock('./utils/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/events.js')>();
  return { ...actual, appEvents: { emit: vi.fn() } };
});

vi.mock('./utils/sandbox.js', () => ({
  sandbox_command: vi.fn(() => ''),
  start_sandbox: vi.fn(() => Promise.resolve()),
}));

vi.mock('./utils/stdioHelpers.js', () => ({
  writeStderrLine: vi.fn(),
  writeStdoutLine: vi.fn(),
  clearScreen: vi.fn(),
}));

vi.mock('./utils/relaunch.js', () => ({
  relaunchAppInChildProcess: vi.fn(),
  relaunchOnExitCode: vi.fn((fn: () => Promise<number>) => fn()),
}));

vi.mock('./config/sandboxConfig.js', () => ({
  loadSandboxConfig: vi.fn(),
}));

vi.mock('./core/initializer.js', () => ({
  initializeApp: vi.fn().mockResolvedValue({
    authError: null,
    themeError: null,
    shouldOpenAuthDialog: false,
    geminiMdFileCount: 0,
  }),
}));

vi.mock('./startup/startup-prefetch.js', () => ({
  startEarlyStartupPrefetches: vi.fn(),
  startPostRenderPrefetches: vi.fn(),
}));

vi.mock('./acp-integration/acpAgent.js', () => ({
  runAcpAgent: vi.fn(),
}));

vi.mock('./commands/extensions/list.js', () => ({
  handleList: vi.fn(),
}));

vi.mock('./ui/AppContainer.js', () => ({
  AppContainer: () => null,
}));

vi.mock('./config/settingsWatcher.js', () => ({
  SettingsWatcher: class {
    startWatching() {}
    stopWatching() {}
    addChangeListener() {
      return () => {};
    }
  },
}));

vi.mock('./config/lsp-config-watcher.js', () => ({
  LspConfigWatcher: class {
    startWatching() {}
    stopWatching() {}
  },
}));

vi.mock('./config/extension-file-watcher.js', () => ({
  ExtensionFileWatcher: class {
    startWatching() {}
    restartWatching() {}
    stopWatching() {}
  },
}));

vi.mock('./utils/version.js', () => ({
  getCliVersion: vi.fn(() => Promise.resolve('1.0.0')),
}));

vi.mock('./ui/utils/kittyProtocolDetector.js', () => ({
  detectAndEnableKittyProtocol: vi.fn(() => Promise.resolve(true)),
  disableKittyProtocol: vi.fn(),
}));

// Scoped out of this test: exercise gemini.tsx's own signal/cleanup wiring,
// not the interactive UI stack.
vi.mock('./ui/startInteractiveUI.js', () => ({
  startInteractiveUI: vi.fn().mockResolvedValue(undefined),
}));

// Deliberately NOT mocking './utils/cleanup.js' — this test needs the real
// registerCleanup/runExitCleanup drain behavior.

function makeBaseConfig(
  workflowRegistry: {
    hasRunningEntries: () => boolean;
    abortAll: () => void;
  },
  overrides: Record<string, unknown> = {},
) {
  return {
    isInteractive: () => true,
    getQuestion: () => '',
    getSandbox: () => false,
    getDebugMode: () => false,
    getListExtensions: () => false,
    getMcpServers: () => ({}),
    getTopTierMcpServers: () => undefined,
    initialize: vi.fn(),
    waitForMcpReady: vi.fn().mockResolvedValue(undefined),
    getIdeMode: () => false,
    getExperimentalZedIntegration: () => false,
    getScreenReader: () => false,
    getGeminiMdFileCount: () => 0,
    getWarnings: () => [],
    isSafeMode: () => false,
    getModelsConfig: () => ({
      getCurrentAuthType: () => null,
      getGenerationConfig: () => ({}),
    }),
    getProxy: () => undefined,
    getUsageStatisticsEnabled: () => true,
    getSessionId: () => 'test-session-id',
    isTelemetryInitializationDeferred: () => true,
    getProjectRoot: () => '/root',
    shutdown: vi.fn().mockResolvedValue(undefined),
    getWorkflowRunRegistry: () => workflowRegistry,
    ...overrides,
  } as unknown as Config;
}

const baseSettings = {
  errors: [],
  merged: { advanced: {}, security: { auth: {} }, ui: {} },
  setValue: vi.fn(),
  forScope: () => ({ settings: {}, originalSettings: {}, path: '' }),
  migrationWarnings: [],
  getUserHooks: () => undefined,
  getProjectHooks: () => undefined,
} as never;

describe('SIGINT reaching an active native Workflow run (gemini.tsx)', () => {
  const signalHandlers = new Map<string, (...args: unknown[]) => void>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processOnceSpy: MockInstance<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processExitSpy: MockInstance<any>;
  let originalIsTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    signalHandlers.clear();
    // Force the non-TTY branch so gemini.tsx skips early-input-capture /
    // kitty-protocol / OSC-11 theme-probe setup entirely — none of that is
    // relevant to this test, and depending on the ambient environment's
    // real stdin.isTTY, exercising it can hang on a real terminal probe.
    originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });
    processOnceSpy = vi.spyOn(process, 'once').mockImplementation(((
      eventName: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (eventName === 'SIGTERM' || eventName === 'SIGINT') {
        signalHandlers.set(eventName as string, listener);
      }
      return process;
    }) as typeof process.once);
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
  });

  afterEach(() => {
    // Restore only the spies this file created — NOT vi.restoreAllMocks(),
    // which (in this Vitest version) also unwinds the module-level
    // vi.mock() factories above back to their real implementations,
    // corrupting subsequent tests in this file.
    processOnceSpy.mockRestore();
    processExitSpy.mockRestore();
    if (originalIsTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
    } else {
      delete (process.stdin as { isTTY?: unknown }).isTTY;
    }
  });

  it('calls WorkflowRunRegistry.abortAll() when SIGINT drains cleanup during an active workflow run', async () => {
    const fakeWorkflowRegistry = {
      hasRunningEntries: vi.fn(() => true),
      abortAll: vi.fn(),
    };

    vi.mocked(loadCliConfig).mockResolvedValue(
      makeBaseConfig(fakeWorkflowRegistry),
    );
    vi.mocked(loadSettings).mockReturnValue(baseSettings);
    vi.mocked(parseArguments).mockResolvedValue({
      extensions: undefined,
    } as never);

    await main();

    // Sanity: the handler under test is actually installed before we pull
    // the trigger.
    expect(signalHandlers.has('SIGINT')).toBe(true);

    signalHandlers.get('SIGINT')?.();

    // Let the real runExitCleanup() drain its cleanup list, including the
    // bounded grace wait the fix adds after abortAll().
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(fakeWorkflowRegistry.hasRunningEntries).toHaveBeenCalled();
    expect(fakeWorkflowRegistry.abortAll).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(130);
  });

  it('does not call abortAll() when no workflow is running', async () => {
    const fakeWorkflowRegistry = {
      hasRunningEntries: vi.fn(() => false),
      abortAll: vi.fn(),
    };

    vi.mocked(loadCliConfig).mockResolvedValue(
      makeBaseConfig(fakeWorkflowRegistry),
    );
    vi.mocked(loadSettings).mockReturnValue(baseSettings);
    vi.mocked(parseArguments).mockResolvedValue({
      extensions: undefined,
    } as never);

    await main();
    signalHandlers.get('SIGINT')?.();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(fakeWorkflowRegistry.hasRunningEntries).toHaveBeenCalled();
    expect(fakeWorkflowRegistry.abortAll).not.toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(130);
  });
});
