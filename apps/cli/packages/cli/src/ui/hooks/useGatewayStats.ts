/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { useConfig } from '../contexts/ConfigContext.js';

/** Host-reported runtime truth polled from the gateway's /api/sysinfo. */
export interface GatewayStats {
  /** GPU utilization percent (AMD gpu_busy_percent). */
  gpuPct: number | null;
  vramUsedGb: number | null;
  vramTotalGb: number | null;
  vramPct: number | null;
  /** Model actually resident on the host (null when GPU is cold). */
  servingModel: string | null;
  /** Context size the resident server was started with. */
  activeContext: number | null;
}

const POLL_INTERVAL_MS = 5_000;
const FETCH_TIMEOUT_MS = 2_500;

/**
 * Derive the gateway web origin from the OpenAI-compat baseUrl the CLI is
 * configured against (e.g. http://127.0.0.1:8770/api/llm/v1 → :8770).
 * Returns null when the CLI is not pointed at an LAL gateway.
 */
export function gatewayOriginFromBaseUrl(
  baseUrl: string | undefined,
): string | null {
  if (!baseUrl) return null;
  const match = baseUrl.match(/^(https?:\/\/[^/]+)\/api\/llm\b/);
  return match ? match[1] : null;
}

/**
 * Poll the LAL gateway for GPU / VRAM / resident-model truth so the footer
 * can show real host state on every screen (LAL transparency baseline).
 * Silently returns null when no gateway is configured or the host is
 * unreachable — the footer then simply omits the pill instead of guessing.
 */
export function useGatewayStats(): GatewayStats | null {
  const config = useConfig();
  const [stats, setStats] = useState<GatewayStats | null>(null);
  const baseUrl = (
    config.getContentGeneratorConfig() as { baseUrl?: string } | undefined
  )?.baseUrl;
  const origin = gatewayOriginFromBaseUrl(baseUrl);

  useEffect(() => {
    if (!origin) {
      setStats(null);
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const response = await fetch(`${origin}/api/sysinfo`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!response.ok) throw new Error(`sysinfo ${response.status}`);
        const body = (await response.json()) as {
          gpu?: number | null;
          vramUsedGb?: number | null;
          vramTotalGb?: number | null;
          vramPct?: number | null;
          serving?: { model?: string | null };
          runtime?: { serving?: { model?: string | null; context?: number | null } };
        };
        if (cancelled) return;
        setStats({
          gpuPct: body.gpu ?? null,
          vramUsedGb: body.vramUsedGb ?? null,
          vramTotalGb: body.vramTotalGb ?? null,
          vramPct: body.vramPct ?? null,
          servingModel:
            body.runtime?.serving?.model ?? body.serving?.model ?? null,
          activeContext: body.runtime?.serving?.context ?? null,
        });
      } catch {
        if (!cancelled) setStats(null);
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [origin]);

  return stats;
}
