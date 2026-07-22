/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage, isNodeError } from './errors.js';
import { isTlsVerificationDisabled } from './runtimeFetchOptions.js';
import { URL } from 'node:url';
import { lookup } from 'node:dns/promises';

const PRIVATE_IP_RANGES = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/,
  /^fe[89ab][0-9a-f]:/,
];

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const FETCH_TROUBLESHOOTING_ERROR_CODES = new Set([
  ...TLS_ERROR_CODES,
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export class FetchError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export function isPrivateIp(url: string): boolean {
  try {
    const hostname = new URL(url).hostname
      .toLowerCase()
      .replace(/\.$/, '')
      .replace(/^\[|\]$/g, '');
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    ) {
      return true;
    }
    if (hostname.startsWith('::ffff:')) {
      const mapped = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      const address = mapped
        ? [
            Number.parseInt(mapped[1], 16) >> 8,
            Number.parseInt(mapped[1], 16) & 0xff,
            Number.parseInt(mapped[2], 16) >> 8,
            Number.parseInt(mapped[2], 16) & 0xff,
          ].join('.')
        : hostname.slice('::ffff:'.length);
      return PRIVATE_IP_RANGES.some((range) => range.test(address));
    }
    return PRIVATE_IP_RANGES.some((range) => range.test(hostname));
  } catch (_e) {
    return false;
  }
}

/** Resolve hostnames before an auto-approved network read. A lookup failure is
 * treated as private/unsafe here; the ordinary confirmed fetch path can still
 * surface its normal network error to the user. */
export async function isPrivateNetworkUrl(url: string): Promise<boolean> {
  if (isPrivateIp(url)) return true;
  try {
    const hostname = new URL(url).hostname;
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.some(({ address }) =>
      isPrivateIp(`http://${address.includes(':') ? `[${address}]` : address}`),
    );
  } catch {
    return true;
  }
}

export async function fetchWithTimeout(
  url: string,
  timeout: number,
  headers?: Record<string, string>,
  redirect: RequestRedirect = 'follow',
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
      redirect,
    });
    return response;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ABORT_ERR') {
      throw new FetchError(`Request timed out after ${timeout}ms`, 'ETIMEDOUT');
    }
    throw new FetchError(getErrorMessage(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  if (
    'code' in error &&
    typeof (error as Record<string, unknown>)['code'] === 'string'
  ) {
    return (error as Record<string, string>)['code'];
  }

  return undefined;
}

function formatUnknownErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error;
  }

  if (
    typeof error === 'number' ||
    typeof error === 'boolean' ||
    typeof error === 'bigint'
  ) {
    return String(error);
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const message = (error as Record<string, unknown>)['message'];
  if (typeof message === 'string') {
    return message;
  }

  return undefined;
}

function formatErrorCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause) {
    return undefined;
  }

  const causeCode = getErrorCode(cause);
  const causeMessage = formatUnknownErrorMessage(cause);

  if (!causeCode && !causeMessage) {
    return undefined;
  }

  if (causeCode && causeMessage && !causeMessage.includes(causeCode)) {
    return `${causeCode}: ${causeMessage}`;
  }

  return causeMessage ?? causeCode;
}

export function formatFetchErrorForUser(
  error: unknown,
  options: { url?: string } = {},
): string {
  const errorMessage = getErrorMessage(error);

  const code =
    error instanceof Error
      ? (getErrorCode((error as Error & { cause?: unknown }).cause) ??
        getErrorCode(error))
      : getErrorCode(error);

  const cause = formatErrorCause(error);
  const fullErrorMessage = [
    errorMessage,
    cause ? `(cause: ${cause})` : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  const shouldShowFetchHints =
    errorMessage.toLowerCase().includes('fetch failed') ||
    (code != null && FETCH_TROUBLESHOOTING_ERROR_CODES.has(code));

  const shouldShowTlsHint = code != null && TLS_ERROR_CODES.has(code);

  if (!shouldShowFetchHints) {
    return fullErrorMessage;
  }

  const hintLines = [
    '',
    'Troubleshooting:',
    ...(options.url
      ? [`- Confirm you can reach ${options.url} from this machine.`]
      : []),
    '- If you are behind a proxy, pass `--proxy <url>` (or set `proxy` in settings).',
    ...(shouldShowTlsHint
      ? isTlsVerificationDisabled()
        ? [
            '- TLS verification is already disabled (`--insecure` / `QWEN_TLS_INSECURE`), so this is likely a network or protocol issue rather than a certificate trust problem.',
          ]
        : [
            '- If your network uses a corporate TLS inspection CA, set `NODE_EXTRA_CA_CERTS` to your CA bundle.',
            '- For a trusted self-signed endpoint, pass `--insecure` (or set `QWEN_TLS_INSECURE=1`) to skip certificate verification.',
          ]
      : []),
  ];

  return `${fullErrorMessage}${hintLines.join('\n')}`;
}
