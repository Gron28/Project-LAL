/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSearchTool } from './web-search.js';

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

  it('fails closed when the CLI has no paired gateway', async () => {
    delete process.env['LAL_GATEWAY_URL'];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await new WebSearchTool()
      .build({ query: 'anything' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('LAL_GATEWAY_URL is unset');
    expect(fetchMock).not.toHaveBeenCalled();
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
