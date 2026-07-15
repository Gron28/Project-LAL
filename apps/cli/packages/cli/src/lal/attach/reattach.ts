/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

// Reattach-if-live: the CLI half of "Cross-device session continuity"
// (docs/design/lal-cli-product-plan.md). A session started on one device
// is a server-side conversation + run; any other device (or the same
// device after a restart) finds it the same way the web UI's
// resync-on-focus logic does — by listing runs and matching status/
// conversationId, never by trusting local state.
import type { GatewayClient, GatewayRunMeta } from './gateway-client.js';

export interface FindLiveRunOptions {
  /** Only consider runs for this server-side conversation id. */
  conversationId?: string;
  /** Only consider runs of this kind (code/chat/deliberate/hive). */
  kind?: GatewayRunMeta['kind'];
  /** How many recent runs to scan (passed through to `GET /api/agent/runs`). */
  limit?: number;
}

/** Finds the best live run to auto-attach to: the most recently updated
 * `status === "running"` run matching the given filters. Returns null if
 * nothing is currently live (there is nothing to reattach to — the caller
 * should fall back to starting a new run or just listing history). */
export async function findLiveRun(
  client: GatewayClient,
  opts: FindLiveRunOptions = {},
): Promise<GatewayRunMeta | null> {
  const runs = await client.listRuns(opts.limit ?? 50);
  const live = runs.filter(
    (r) =>
      r.status === 'running' &&
      (!opts.kind || r.kind === opts.kind) &&
      (!opts.conversationId || r.conversationId === opts.conversationId),
  );
  if (live.length === 0) return null;
  // `listRuns` already sorts running-first then by updatedAt desc, but this
  // function's contract shouldn't depend on the server's sort order, so
  // pick the freshest explicitly.
  return live.reduce((best, r) => (r.updatedAt > best.updatedAt ? r : best));
}

/** Finds the most recent run (live or not) for a conversation — used when
 * a device wants "whatever this conversation's latest turn was," e.g. to
 * decide whether to attach live or just replay a finished run's transcript. */
export async function findLatestRunForConversation(
  client: GatewayClient,
  conversationId: string,
  limit = 50,
): Promise<GatewayRunMeta | null> {
  const runs = await client.listRuns(limit);
  const matching = runs.filter((r) => r.conversationId === conversationId);
  if (matching.length === 0) return null;
  return matching.reduce((best, r) =>
    r.updatedAt > best.updatedAt ? r : best,
  );
}
