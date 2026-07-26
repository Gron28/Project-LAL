import { describe, expect, it } from 'vitest';
import { type GatewayStats, stabilizeGatewayStats } from './useGatewayStats.js';

const stats = (overrides: Partial<GatewayStats> = {}): GatewayStats => ({
  gpuPct: 2,
  vramUsedGb: 1,
  vramTotalGb: 8,
  vramPct: 12,
  servingModel: 'local-model',
  activeContext: 32768,
  backend: 'llama.cpp',
  gpuOffload: 'all',
  runAlive: false,
  ...overrides,
});

describe('stabilizeGatewayStats', () => {
  it('keeps the same snapshot when only idle GPU utilization changes', () => {
    const previous = stats();

    expect(stabilizeGatewayStats(previous, stats({ gpuPct: 17 }))).toBe(
      previous,
    );
  });

  it('publishes GPU utilization changes while work is active', () => {
    const previous = stats({ runAlive: true });
    const next = stats({ runAlive: true, gpuPct: 87 });

    expect(stabilizeGatewayStats(previous, next)).toBe(next);
  });

  it('publishes runtime and memory state changes while idle', () => {
    const previous = stats();
    const next = stats({ servingModel: null, vramUsedGb: 0 });

    expect(stabilizeGatewayStats(previous, next)).toBe(next);
  });
});
