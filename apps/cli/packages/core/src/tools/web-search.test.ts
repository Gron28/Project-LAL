/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSearchTool } from './web-search.js';

// gatewayOrigin() falls back to ~/.lal/client-host on disk, so on a paired
// developer machine real credentials would leak into "no gateway configured"
// assertions. Point homedir at an empty temp dir to keep this file hermetic.
beforeAll(() => {
  const emptyHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lal-web-search-test-'),
  );
  vi.spyOn(os, 'homedir').mockReturnValue(emptyHome);
});

describe('WebSearchTool', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['LAL_GATEWAY_URL'] = 'http://lal.test/';
    process.env['LAL_API_KEY'] = 'pairing-token';
    process.env['LAL_DEVICE_ID'] = 'device-12345678';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it('rejects an empty query', () => {
    expect(() => new WebSearchTool().build({ query: '   ' })).toThrow(
      "The 'query' parameter cannot be empty.",
    );
  });

  it('searches through the paired authenticated gateway', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          query: 'tiny bomberman html github',
          results: '[1] Example\nhttps://github.com/example/game',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const invocation = new WebSearchTool().build({
      query: ' tiny bomberman html github ',
    });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain('github.com/example/game');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://lal.test/api/lal/web-search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer pairing-token',
          'x-lal-device-id': 'device-12345678',
        }),
        body: JSON.stringify({ query: 'tiny bomberman html github' }),
      }),
    );
  });

  it('falls back to the default gateway origin when LAL_GATEWAY_URL is unset', async () => {
    delete process.env['LAL_GATEWAY_URL'];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new WebSearchTool()
      .build({ query: 'anything' })
      .execute(new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8770/api/lal/web-search',
      expect.anything(),
    );
  });

  it('returns a useful error instead of throwing on gateway failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'search backend unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await new WebSearchTool()
      .build({ query: 'anything' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toBe(
      'Web search failed: search backend unavailable',
    );
  });
});
