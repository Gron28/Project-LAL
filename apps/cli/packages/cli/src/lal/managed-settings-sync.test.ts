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
        model: { name: 'qwen35-9b' },
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
        expect.objectContaining({ key: 'modelProviders', value: modelProviders }),
      ]),
    );
    expect(config.setContextWindowOverride).toHaveBeenCalledWith(100_000);
    expect(config.setSamplingOverride).toHaveBeenCalledWith({
      temperature: 0.25,
      max_tokens: 4_096,
    });
    expect(config.setThinkingEnabled).toHaveBeenCalledWith(false);
  });
});
