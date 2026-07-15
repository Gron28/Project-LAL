/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GATEWAY_ORIGIN,
  GatewayClient,
  GatewayError,
  buildDeviceHeaders,
  resolveGatewayOrigin,
  resolveGatewayToken,
} from './gateway-client.js';

describe('gateway origin/token resolution', () => {
  it('defaults to the known dev gateway origin when nothing is configured', () => {
    expect(resolveGatewayOrigin({})).toBe(DEFAULT_GATEWAY_ORIGIN);
  });

  it('honors LAL_GATEWAY_URL and strips a trailing slash', () => {
    expect(
      resolveGatewayOrigin({
        LAL_GATEWAY_URL: 'http://main-pc.tail3ba909.ts.net:8443/',
      }),
    ).toBe('http://main-pc.tail3ba909.ts.net:8443');
  });

  it('resolves the bearer token from LAL_API_KEY, falling back to LAL_CLI_TOKEN', () => {
    expect(resolveGatewayToken({ LAL_API_KEY: 'abc' })).toBe('abc');
    expect(resolveGatewayToken({ LAL_CLI_TOKEN: 'xyz' })).toBe('xyz');
    expect(
      resolveGatewayToken({ LAL_API_KEY: 'abc', LAL_CLI_TOKEN: 'xyz' }),
    ).toBe('abc');
    expect(resolveGatewayToken({})).toBeUndefined();
  });

  it('builds stable device headers with the expected names', () => {
    const headers = buildDeviceHeaders();
    expect(Object.keys(headers).sort()).toEqual([
      'x-lal-client-version',
      'x-lal-device-id',
      'x-lal-device-name',
      'x-lal-platform',
    ]);
    expect(headers['x-lal-device-id']).toMatch(/^cli-/);
  });
});

describe('GatewayClient', () => {
  it('sends the bearer + device headers opportunistically, even though /api/agent/* does not require them', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify([]), { status: 200 }),
    );
    const client = new GatewayClient({
      origin: 'http://gw:8770',
      token: 'tok123',
      fetchImpl,
    });
    await client.listRuns(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://gw:8770/api/agent/runs?limit=10');
    const headers = init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok123');
    expect(headers['x-lal-device-id']).toMatch(/^cli-/);
  });

  it('omits the authorization header entirely when no token is configured, without failing the call', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify([]), { status: 200 }),
    );
    const client = new GatewayClient({
      origin: 'http://gw:8770',
      token: undefined,
      fetchImpl,
    });
    await client.listRuns();
    const [, init] = fetchImpl.mock.calls[0];
    expect(
      (init?.headers as Record<string, string>)['authorization'],
    ).toBeUndefined();
  });

  it('throws a GatewayError with status on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    const client = new GatewayClient({ origin: 'http://gw:8770', fetchImpl });
    await expect(client.getRun('missing')).rejects.toBeInstanceOf(GatewayError);
    await expect(client.getRun('missing')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('fetchClientSettings resolves to null (not a throw) on a 401 or network failure', async () => {
    const unauthorized = new GatewayClient({
      origin: 'http://gw:8770',
      fetchImpl: vi.fn(async () => new Response('no', { status: 401 })),
    });
    await expect(unauthorized.fetchClientSettings()).resolves.toBeNull();

    const networkDown = new GatewayClient({
      origin: 'http://gw:8770',
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    await expect(networkDown.fetchClientSettings()).resolves.toBeNull();
  });

  it('builds the stream URL with the resume cursor and a URL-encoded run id', () => {
    const client = new GatewayClient({ origin: 'http://gw:8770' });
    expect(client.streamUrl('run-abc/123', 42)).toBe(
      'http://gw:8770/api/agent/runs/run-abc%2F123/stream?after=42',
    );
    expect(client.streamUrl('run-abc')).toBe(
      'http://gw:8770/api/agent/runs/run-abc/stream?after=0',
    );
  });

  it('getRun passes ?trace=1 through when requested', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ run: {}, trace: {}, diagnosis: null }), {
          status: 200,
        }),
    );
    const client = new GatewayClient({ origin: 'http://gw:8770', fetchImpl });
    await client.getRun('r1', { trace: true });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://gw:8770/api/agent/runs/r1?trace=1');
  });
});
