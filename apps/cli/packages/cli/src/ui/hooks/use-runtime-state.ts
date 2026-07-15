/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { StreamingState } from '../types.js';
import { t } from '../../i18n/index.js';

/**
 * Typed runtime states for the turn-loop status line, replacing the inherited
 * "witty loading phrase" cycler (a random pick from a joke list, refreshed on
 * a 15s timer regardless of what was actually happening). Each state maps to
 * a real, observable signal instead of decorative flavor text.
 *
 * `loading_model` and `verifying` are part of the intended vocabulary (see
 * `docs/design/lal-cli-product-plan.md`, Identity cleanup) but have no wired
 * signal at this layer yet:
 *   - `loading_model` needs a `model_loading`/`model_ready` event from the
 *     gateway attach layer (Step 3) to distinguish "cold model swap on
 *     main-pc" from an ordinary queued turn; until then both read as
 *     `queuing`, which is honest (it doesn't claim a distinction the client
 *     can't yet see) rather than decorative.
 *   - `verifying` is a Hive verifier-node state (Step 7 TUI, not yet built);
 *     it isn't reachable from the Default/Code turn loop this hook drives.
 */
export type RuntimeState =
  | 'idle'
  | 'queuing'
  | 'thinking'
  | 'calling_tool'
  | 'waiting_approval';

export function computeRuntimeState(
  streamingState: StreamingState,
  isToolExecuting: boolean,
  hasStreamedOutput: boolean,
): RuntimeState {
  if (streamingState === StreamingState.Idle) return 'idle';
  if (streamingState === StreamingState.WaitingForConfirmation) {
    return 'waiting_approval';
  }
  if (isToolExecuting) return 'calling_tool';
  if (!hasStreamedOutput) return 'queuing';
  return 'thinking';
}

export function runtimeStateLabel(state: RuntimeState): string {
  switch (state) {
    case 'waiting_approval':
      return t('Waiting for approval…');
    case 'calling_tool':
      return t('Calling tool…');
    case 'queuing':
      return t('Queuing…');
    case 'thinking':
      return t('Thinking…');
    case 'idle':
    default:
      return '';
  }
}
