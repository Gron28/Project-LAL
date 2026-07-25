/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ModelLease } from './model-lease.js';

/** A task that resolves when told to, so ordering is deterministic. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('ModelLease (PLAN 2.5)', () => {
  it('serialises to one model at a time by default', async () => {
    const lease = new ModelLease(() => 1);
    const first = gate();
    const order: string[] = [];

    const a = lease.run('a', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
    });
    const b = lease.run('b', async () => {
      order.push('b:start');
    });

    // b must not have started while a holds the lease.
    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    expect(lease.queuedCount).toBe(1);

    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('admits up to the configured limit concurrently', async () => {
    const lease = new ModelLease(() => 2);
    const held = gate();
    let peak = 0;
    const tasks = [1, 2, 3].map(() =>
      lease.run('t', async () => {
        peak = Math.max(peak, lease.activeCount);
        await held.promise;
      }),
    );
    await Promise.resolve();
    expect(peak).toBe(2);
    held.release();
    await Promise.all(tasks);
  });

  it('announces the wait, and only when there actually is one', async () => {
    const lease = new ModelLease(() => 1);
    const held = gate();
    const waits: Array<{ running: number; queued: number }> = [];

    const a = lease.run('a', () => held.promise, (info) => waits.push(info));
    const b = lease.run('b', async () => {}, (info) => waits.push(info));

    await Promise.resolve();
    // Only b waited.
    expect(waits).toEqual([{ running: 1, queued: 1 }]);
    held.release();
    await Promise.all([a, b]);
  });

  it('a nested run proceeds immediately — waiting would deadlock', async () => {
    const lease = new ModelLease(() => 1);
    const inner = await lease.run('outer', async () =>
      // With a limit of 1 and no reentrancy handling, this waits for its own
      // parent forever. The test would time out rather than fail.
      lease.run('inner', async () => 'done'),
    );
    expect(inner).toBe('done');
    expect(lease.activeCount).toBe(0);
  });

  it('releases the lease when a task throws, so the queue never strands', async () => {
    const lease = new ModelLease(() => 1);
    await expect(
      lease.run('boom', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(lease.activeCount).toBe(0);
    await expect(lease.run('after', async () => 'ok')).resolves.toBe('ok');
  });

  it('hands the lease to exactly one waiter at a time', async () => {
    const lease = new ModelLease(() => 1);
    const held = gate();
    const started: string[] = [];
    const a = lease.run('a', () => held.promise);
    const rest = ['b', 'c', 'd'].map((name) =>
      lease.run(name, async () => {
        started.push(name);
        expect(lease.activeCount).toBe(1);
      }),
    );
    expect(lease.queuedCount).toBe(3);
    held.release();
    await Promise.all([a, ...rest]);
    expect(started).toEqual(['b', 'c', 'd']);
  });

  it('reads the limit at acquisition time, so the env var is not baked in', async () => {
    let limit = 1;
    const lease = new ModelLease(() => limit);
    const held = gate();
    const a = lease.run('a', () => held.promise);
    limit = 2;
    let ranConcurrently = false;
    const b = lease.run('b', async () => {
      ranConcurrently = lease.activeCount === 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ranConcurrently).toBe(true);
    held.release();
    await Promise.all([a, b]);
  });
});
