/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ModelProvidersConfig } from '@qwen-code/qwen-code-core';
import { GatewayClient } from './attach/gateway-client.js';
import { type LoadedSettings, SettingScope } from '../config/settings.js';

type ManagedModel = {
  id?: unknown;
  generationConfig?: {
    contextWindowSize?: unknown;
    samplingParams?: Record<string, unknown>;
    reasoning?: unknown;
  };
};

type ManagedSnapshot = {
  model?: { name?: unknown };
  modelProviders?: ModelProvidersConfig;
};

export type ManagedSettingsSyncHandle = (() => void) & {
  /** Settles after the first host reconciliation attempt, successful or not. */
  ready: Promise<void>;
};

/** Keep a running LAL terminal aligned with the owner-controlled host profile.
 * The host gateway still enforces settings on every request; this poll also
 * updates the local context meter, model picker, and last-known offline config. */
export function startManagedSettingsSync(
  config: Config,
  settings: LoadedSettings,
  options: {
    intervalMs?: number;
    client?: Pick<GatewayClient, 'fetchClientSettings'>;
  } = {},
): ManagedSettingsSyncHandle {
  const client = options.client ?? new GatewayClient();
  const intervalMs = options.intervalMs ?? 2_000;
  let stopped = false;
  let running = false;
  let lastSnapshot = '';
  let previousDefault: string | undefined;
  let settleReady!: () => void;
  let readySettled = false;
  const ready = new Promise<void>((resolve) => {
    settleReady = resolve;
  });

  const applyCurrentProfile = (providers: ModelProvidersConfig) => {
    const current = config.getModel();
    const models = Object.values(providers).flat() as ManagedModel[];
    const managed = models.find((model) => model.id === current);
    const generation = managed?.generationConfig;
    if (!generation) return;
    if (typeof generation.contextWindowSize === 'number') {
      config.setContextWindowOverride(generation.contextWindowSize);
    }
    if (generation.samplingParams) {
      config.setSamplingOverride(generation.samplingParams);
    }
    config.setThinkingEnabled(generation.reasoning !== false);
  };

  const sync = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const raw = (await client.fetchClientSettings()) as ManagedSnapshot | null;
      if (stopped) return;
      if (!raw?.modelProviders || !raw.model || typeof raw.model.name !== 'string') return;
      const snapshot = JSON.stringify({ model: raw.model, modelProviders: raw.modelProviders });
      if (snapshot === lastSnapshot) return;
      const nextDefault = raw.model.name;
      const initial = !lastSnapshot;
      const previous = previousDefault;
      lastSnapshot = snapshot;
      previousDefault = nextDefault;

      config.reloadModelProvidersConfig(raw.modelProviders);
      settings.setValues([
        { scope: SettingScope.User, key: 'modelProviders', value: raw.modelProviders },
        { scope: SettingScope.User, key: 'model.name', value: nextDefault },
      ]);

      // Adopt the host default at startup. During a live session, follow a
      // default change only if the terminal was still using the prior default;
      // an explicit local /model choice remains a session override.
      if ((initial || config.getModel() === previous) && config.getModel() !== nextDefault) {
        await config.setModel(nextDefault, { reason: 'LAL host default synchronized' });
      }
      applyCurrentProfile(raw.modelProviders);
    } catch {
      // Offline operation deliberately retains the last successfully persisted
      // host profile. The next poll reconciles after connectivity returns.
    } finally {
      running = false;
      if (!readySettled) {
        readySettled = true;
        settleReady();
      }
    }
  };

  void sync();
  const timer = setInterval(() => void sync(), intervalMs);
  timer.unref?.();
  const dispose = () => {
    stopped = true;
    clearInterval(timer);
  };
  return Object.assign(dispose, { ready });
}
