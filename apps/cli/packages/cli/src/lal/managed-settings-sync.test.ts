import { describe, expect, it, vi } from 'vitest';
import { startManagedSettingsSync } from './managed-settings-sync.js';

describe('startManagedSettingsSync', () => {
  it('adopts and persists the host default and applies its runtime profile', async () => {
    let model = 'old-default';
    const config = {
      getModel: vi.fn(() => model),
      setModel: vi.fn(async (next: string) => {
        model = next;
      }),
      reloadModelProvidersConfig: vi.fn(),
      setContextWindowOverride: vi.fn(),
      setSamplingOverride: vi.fn(),
      setThinkingEnabled: vi.fn(),
      setMaxSessionTurns: vi.fn(),
      setSkipLoopDetection: vi.fn(),
      setMaxToolCallsPerTurn: vi.fn(),
      setShellDefaultTimeoutMs: vi.fn(),
    };
    const settings = { setValues: vi.fn() };
    const modelProviders = {
      'lal-main-pc': [
        {
          id: 'qwen35-9b',
          name: 'Qwen 3.5 9B',
          envKey: 'LAL_API_KEY',
          baseUrl: 'http://localhost:8770/api/llm/v1',
          generationConfig: {
            contextWindowSize: 100_000,
            samplingParams: { temperature: 0.25, max_tokens: 4_096 },
            reasoning: false,
          },
        },
      ],
    };
    const client = {
      fetchClientSettings: vi.fn(async () => ({
        model: {
          name: 'qwen35-9b',
          maxSessionTurns: -1,
          skipLoopDetection: true,
          maxToolCallsPerTurn: -1,
        },
        tools: { shell: { defaultTimeoutMs: 600_000 } },
        modelProviders,
      })),
    };

    const stop = startManagedSettingsSync(config as never, settings as never, {
      intervalMs: 60_000,
      client,
    });

    await vi.waitFor(() => expect(config.setModel).toHaveBeenCalledOnce());
    stop();

    expect(config.reloadModelProvidersConfig).toHaveBeenCalledWith(
      modelProviders,
    );
    expect(settings.setValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: 'model.name', value: 'qwen35-9b' }),
        expect.objectContaining({
          key: 'modelProviders',
          value: modelProviders,
        }),
        expect.objectContaining({ key: 'model.maxSessionTurns', value: -1 }),
        expect.objectContaining({
          key: 'model.skipLoopDetection',
          value: true,
        }),
        expect.objectContaining({
          key: 'model.maxToolCallsPerTurn',
          value: -1,
        }),
        expect.objectContaining({
          key: 'tools.shell.defaultTimeoutMs',
          value: 600_000,
        }),
      ]),
    );
    expect(config.setMaxSessionTurns).toHaveBeenCalledWith(-1);
    expect(config.setSkipLoopDetection).toHaveBeenCalledWith(true);
    expect(config.setMaxToolCallsPerTurn).toHaveBeenCalledWith(-1);
    expect(config.setShellDefaultTimeoutMs).toHaveBeenCalledWith(600_000);
    expect(config.setContextWindowOverride).toHaveBeenCalledWith(100_000);
    expect(config.setSamplingOverride).toHaveBeenCalledWith({
      temperature: 0.25,
      max_tokens: 4_096,
    });
    expect(config.setThinkingEnabled).toHaveBeenCalledWith(false);
  });

  it('preserves an explicit CLI model on the initial host snapshot', async () => {
    const config = {
      getModel: vi.fn(() => 'explicit-model'),
      setModel: vi.fn(),
      reloadModelProvidersConfig: vi.fn(),
      setContextWindowOverride: vi.fn(),
      setSamplingOverride: vi.fn(),
      setThinkingEnabled: vi.fn(),
      setMaxSessionTurns: vi.fn(),
      setSkipLoopDetection: vi.fn(),
      setMaxToolCallsPerTurn: vi.fn(),
      setShellDefaultTimeoutMs: vi.fn(),
    };
    const settings = { setValues: vi.fn() };
    const client = {
      fetchClientSettings: vi.fn(async () => ({
        model: { name: 'host-default' },
        modelProviders: {
          local: [{ id: 'explicit-model', generationConfig: {} }],
        },
      })),
    };

    const stop = startManagedSettingsSync(config as never, settings as never, {
      intervalMs: 60_000,
      client,
      preserveInitialModel: true,
    });
    await stop.ready;
    stop();

    expect(config.setModel).not.toHaveBeenCalled();
    expect(config.reloadModelProvidersConfig).toHaveBeenCalledOnce();
    expect(settings.setValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: 'model.name', value: 'host-default' }),
      ]),
    );
  });
});
