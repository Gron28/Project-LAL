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

  // Windows session, 2026-07-25: EVERY web_search failed with
  //   "Cannot convert argument to a ByteString because the character at index 0
  //    has a value of 8745"
  // 8745 is U+2229 — byte 0xEF of the UTF-8 BOM through code page 437.
  // install.ps1 wrote ~/.lal/device-name with [Text.Encoding]::UTF8 (which emits
  // a BOM), lal.cmd read it into LAL_DEVICE_NAME, and it went into an HTTP
  // header. fetch throws on any code unit > 255 BEFORE sending, so the search
  // never left the machine and the host had nothing to log. The installer is
  // fixed, but machines already provisioned still have BOM'd files, so the
  // sanitising here is what actually rescues them.
  describe('header sanitising', () => {
    async function capturedHeaders(): Promise<Record<string, string>> {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ query: 'q', results: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const invocation = new WebSearchTool().build({ query: 'q' });
      await invocation.execute(new AbortController().signal);
      return fetchMock.mock.calls[0][1].headers as Record<string, string>;
    }

    it('strips a UTF-8 BOM from a forwarded device name', async () => {
      process.env['LAL_DEVICE_NAME'] = '\uFEFFAT-DESIGN';
      const headers = await capturedHeaders();
      expect(headers['x-lal-device-name']).toBe('AT-DESIGN');
      // The real bug: any code unit > 255 anywhere in a header value throws.
      for (const value of Object.values(headers)) {
        for (const char of value) {
          expect(char.codePointAt(0)).toBeLessThanOrEqual(255);
        }
      }
    });

    it('strips the whole code-page-437 BOM, leaving no Latin-1 residue', async () => {
      process.env['LAL_DEVICE_NAME'] = '\u2229\u00bb\u00bfAT-DESIGN';
      const headers = await capturedHeaders();
      // Only U+2229 exceeds the ByteString limit, so a code-point filter alone
      // would leave "\u00bb\u00bf" attached and the host would store that as the
      // device's name.
      expect(headers['x-lal-device-name']).toBe('AT-DESIGN');
    });

    it('strips the cp1252 rendering of the BOM too', async () => {
      process.env['LAL_DEVICE_NAME'] = '\u00ef\u00bb\u00bfAT-DESIGN';
      const headers = await capturedHeaders();
      expect(headers['x-lal-device-name']).toBe('AT-DESIGN');
    });

    it('keeps a legitimate accented host name usable', async () => {
      // Latin-1 is representable in a header; it must not be stripped away to
      // nothing just because it is non-ASCII.
      process.env['LAL_DEVICE_NAME'] = 'Bogot\u00e1-PC';
      const headers = await capturedHeaders();
      expect(headers['x-lal-device-name']).toBe('Bogot\u00e1-PC');
    });

    it('strips CR/LF so a header cannot be injected', async () => {
      process.env['LAL_DEVICE_NAME'] = 'evil\r\nx-admin: 1';
      const headers = await capturedHeaders();
      expect(headers['x-lal-device-name']).not.toContain('\n');
      expect(headers['x-lal-device-name']).not.toContain('\r');
    });

    it('sanitises the token too, so a BOM is not an unexplained 401', async () => {
      process.env['LAL_API_KEY'] = '\uFEFFpairing-token';
      const headers = await capturedHeaders();
      expect(headers['authorization']).toBe('Bearer pairing-token');
    });
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
