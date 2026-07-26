/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODEL_LEASE');

/**
 * PLAN 2.5 — subagents are context isolation, not concurrency.
 *
 * This box runs roughly one model at a time. When the model plans three
 * subagents and the scheduler dispatches all three, they do not run in
 * parallel — they contend for one GPU, and what the operator sees is three
 * tasks that each take three times as long, plus the memory pressure of three
 * live contexts.
 *
 * The plan is explicit that the fix is NOT to remove the model's
 * parallel-planning instinct: planning several independent lines of work is
 * correct reasoning, and each subagent still gets its own isolated context,
 * which is the actual point of a subagent. What changes is underneath — the
 * scheduler admits `LAL_MAX_CONCURRENT_AGENTS` (default 1) at a time and queues
 * the rest.
 *
 * Reentrancy is handled with AsyncLocalStorage rather than a counter, because
 * getting it wrong is a deadlock, not a slowdown: with a limit of 1, a subagent
 * that spawns a subagent while holding the lease would wait forever for itself.
 * Anything already running inside a lease proceeds immediately.
 */

function configuredLimit(): number {
  const raw = process.env['LAL_MAX_CONCURRENT_AGENTS'];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed >= 1) return Math.min(parsed, 16);
  return 1;
}

export interface ModelLeaseWaitInfo {
  /** How many are already running when this one had to wait. */
  running: number;
  /** Position in the queue, 1-based. */
  queued: number;
}

export class ModelLease {
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly inLease = new AsyncLocalStorage<true>();

  constructor(private readonly limitFn: () => number = configuredLimit) {}

  get activeCount(): number {
    return this.running;
  }
  get queuedCount(): number {
    return this.waiters.length;
  }

  /**
   * Run `task` under the lease. `onWait` fires only when the task actually has
   * to queue, so the caller can tell the user why nothing appears to be
   * happening — an invisible queue is indistinguishable from a hang.
   */
  async run<T>(
    label: string,
    task: () => Promise<T>,
    onWait?: (info: ModelLeaseWaitInfo) => void,
  ): Promise<T> {
    // Already inside a lease: proceed. Waiting here would be a deadlock.
    if (this.inLease.getStore()) return task();

    const limit = this.limitFn();
    if (this.running >= limit) {
      const info = { running: this.running, queued: this.waiters.length + 1 };
      debugLogger.debug(
        `[model-lease] "${label}" queued (running=${info.running}, queued=${info.queued}, limit=${limit})`,
      );
      onWait?.(info);
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.running += 1;
    try {
      return await this.inLease.run(true, task);
    } finally {
      this.running -= 1;
      // Hand off to exactly one waiter. Released in `finally`, so a task that
      // throws or is cancelled never strands the queue.
      this.waiters.shift()?.();
    }
  }
}

/** The process-wide lease. One GPU, one lease. */
export const localModelLease = new ModelLease();
