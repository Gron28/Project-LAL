/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ModelProvidersConfig } from '@lal/core';
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
  model?: {
    name?: unknown;
    maxSessionTurns?: unknown;
    skipLoopDetection?: unknown;
    maxToolCallsPerTurn?: unknown;
  };
  tools?: {
    shell?: {
      defaultTimeoutMs?: unknown;
    };
  };
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
    /** Preserve a model selected explicitly by `--model` on first sync. */
    preserveInitialModel?: boolean;
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
      const raw =
        (await client.fetchClientSettings()) as ManagedSnapshot | null;
      if (stopped) return;
      if (
        !raw?.modelProviders ||
        !raw.model ||
        typeof raw.model.name !== 'string'
      )
        return;
      const snapshot = JSON.stringify({
        model: raw.model,
        tools: raw.tools,
        modelProviders: raw.modelProviders,
      });
      if (snapshot === lastSnapshot) return;
      const nextDefault = raw.model.name;
      const initial = !lastSnapshot;
      const previous = previousDefault;
      lastSnapshot = snapshot;
      previousDefault = nextDefault;

      config.reloadModelProvidersConfig(raw.modelProviders);
      const managedPolicy = [
        ...(typeof raw.model.maxSessionTurns === 'number'
          ? [
              {
                key: 'model.maxSessionTurns',
                value: raw.model.maxSessionTurns,
              },
            ]
          : []),
        ...(typeof raw.model.skipLoopDetection === 'boolean'
          ? [
              {
                key: 'model.skipLoopDetection',
                value: raw.model.skipLoopDetection,
              },
            ]
          : []),
        ...(typeof raw.model.maxToolCallsPerTurn === 'number'
          ? [
              {
                key: 'model.maxToolCallsPerTurn',
                value: raw.model.maxToolCallsPerTurn,
              },
            ]
          : []),
        ...(typeof raw.tools?.shell?.defaultTimeoutMs === 'number'
          ? [
              {
                key: 'tools.shell.defaultTimeoutMs',
                value: raw.tools.shell.defaultTimeoutMs,
              },
            ]
          : []),
      ];
      settings.setValues([
        {
          scope: SettingScope.User,
          key: 'modelProviders',
          value: raw.modelProviders,
        },
        { scope: SettingScope.User, key: 'model.name', value: nextDefault },
        ...managedPolicy.map((value) => ({
          scope: SettingScope.User,
          ...value,
        })),
      ]);

      if (typeof raw.model.maxSessionTurns === 'number') {
        config.setMaxSessionTurns(raw.model.maxSessionTurns);
      }
      if (typeof raw.model.skipLoopDetection === 'boolean') {
        config.setSkipLoopDetection(raw.model.skipLoopDetection);
      }
      if (typeof raw.model.maxToolCallsPerTurn === 'number') {
        config.setMaxToolCallsPerTurn(raw.model.maxToolCallsPerTurn);
      }
      if (typeof raw.tools?.shell?.defaultTimeoutMs === 'number') {
        config.setShellDefaultTimeoutMs(raw.tools.shell.defaultTimeoutMs);
      }

      // Adopt the host default at startup. During a live session, follow a
      // default change only if the terminal was still using the prior default;
      // an explicit local /model choice remains a session override.
      if (
        ((initial && !options.preserveInitialModel) ||
          (!initial && config.getModel() === previous)) &&
        config.getModel() !== nextDefault
      ) {
        await config.setModel(nextDefault, {
          reason: 'LAL host default synchronized',
        });
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
