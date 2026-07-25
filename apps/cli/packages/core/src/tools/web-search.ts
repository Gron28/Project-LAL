/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';

export interface WebSearchToolParams {
  query: string;
}

const MAX_QUERY_CHARS = 500;
const MAX_RESULT_CHARS = 24_000;

// Default origin for the gateway when nothing else is configured — mirrors
// DEFAULT_GATEWAY_ORIGIN in packages/cli/src/lal/attach/gateway-client.ts.
// Duplicated (not imported) because core cannot depend on the cli package.
const DEFAULT_GATEWAY_ORIGIN = 'http://localhost:8770';

// The Windows installer persists the paired host in ~/.lal/client-host so a
// newly opened terminal works without manually exporting env values.
function readLalFile(name: string): string | undefined {
  try {
    const value = fs
      .readFileSync(path.join(os.homedir(), '.lal', name), 'utf8')
      .trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function gatewayOrigin(): string {
  const fromEnv = process.env['LAL_GATEWAY_URL']?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const pairedHost = readLalFile('client-host');
  if (pairedHost) return pairedHost.replace(/\/+$/, '');
  return DEFAULT_GATEWAY_ORIGIN;
}

/**
 * Make a value safe to put in an HTTP header.
 *
 * `fetch` header values must be ByteStrings — every code unit <= 255. Anything
 * above that makes undici throw *before the request is sent*, which is a silent
 * failure with no server-side trace at all.
 *
 * This is not hypothetical. Measured from a Windows session on 2026-07-25: every
 * web_search failed with
 *
 *   Cannot convert argument to a ByteString because the character at index 0
 *   has a value of 8745 which is greater than 255
 *
 * 8745 is U+2229 (INTERSECTION). It is byte 0xEF — the first byte of the UTF-8
 * BOM — rendered through code page 437. PowerShell 5.1 writes UTF-8 WITH a BOM
 * by default, so the installer's `~/.lal/device-name` and friends begin with
 * EF BB BF; `lal.cmd` reads them with `for /f`, the BOM lands in
 * LAL_DEVICE_NAME, and that goes straight into `x-lal-device-name` here. Result:
 * web_search was dead on Windows for every query, the host logged nothing
 * because nothing arrived, and the model — unable to search — fell back to
 * guessing recipe URLs one at a time.
 *
 * Stripping the BOM alone would fix that one case. Restricting to Latin-1 fixes
 * the whole class, including a device or host name with an accent in it, which is
 * entirely legitimate and would break identically.
 */
function headerSafe(value: string): string {
  return (
    value
      // A UTF-8 BOM that has already been decoded through a legacy code page
      // arrives as three legible characters, not as U+FEFF. Strip the known
      // renderings of EF BB BF when they lead the string: cp437/cp850 gives
      // "\u2229\u00bb\u00bf" and cp1252/latin-1 gives "\u00ef\u00bb\u00bf". Only
      // U+2229 is above the ByteString limit, so filtering by code point alone
      // would leave "\u00bb\u00bf" glued to the device name and the host would
      // record that as the machine's identity.
      .replace(/^(?:\u2229|\u00ef)\u00bb\u00bf/, '')
      // Strip BOM / zero-width marks anywhere, not just at index 0.
      .replace(/[\uFEFF\u200B-\u200D\u2060]/g, '')
      // Drop anything a header value cannot carry: non-Latin-1, plus CR/LF and
      // other control characters (header injection).
      .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, '')
      .trim()
  );
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  // The token is sanitised too: a BOM on ~/.lal/.env would otherwise turn every
  // search into an unexplained 401 instead of an unexplained throw.
  const token =
    headerSafe(process.env['LAL_API_KEY'] ?? '') ||
    headerSafe(process.env['LAL_CLI_TOKEN'] ?? '');
  if (token) headers['authorization'] = `Bearer ${token}`;

  const forwardedHeaders: Array<[string, string | undefined]> = [
    ['x-lal-device-id', process.env['LAL_DEVICE_ID']],
    ['x-lal-device-name', process.env['LAL_DEVICE_NAME']],
    ['x-lal-platform', process.env['LAL_PLATFORM']],
    ['x-lal-client-version', process.env['LAL_CLIENT_VERSION']],
  ];
  for (const [name, value] of forwardedHeaders) {
    const safe = headerSafe(value ?? '');
    if (safe) headers[name] = safe;
  }
  return headers;
}

class WebSearchToolInvocation extends BaseToolInvocation<
  WebSearchToolParams,
  ToolResult
> {
  getDescription(): string {
    return `Search the web for: ${this.params.query}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const origin = gatewayOrigin();

    try {
      const response = await fetch(`${origin}/api/lal/web-search`, {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ query: this.params.query.trim() }),
        signal,
      });
      const payload = (await response.json()) as {
        results?: unknown;
        error?: { message?: unknown } | string;
      };
      if (!response.ok) {
        const message =
          typeof payload.error === 'string'
            ? payload.error
            : typeof payload.error?.message === 'string'
              ? payload.error.message
              : `HTTP ${response.status}`;
        throw new Error(message);
      }
      if (typeof payload.results !== 'string') {
        throw new Error('gateway returned an invalid search response');
      }
      const results = payload.results.slice(0, MAX_RESULT_CHARS);
      return { llmContent: results, returnDisplay: results };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Web search failed: ${message}`,
        returnDisplay: `Web search failed: ${message}`,
        error: {
          message: `Web search failed: ${message}`,
          type: ToolErrorType.WEB_SEARCH_FAILED,
        },
      };
    }
  }
}

export class WebSearchTool extends BaseDeclarativeTool<
  WebSearchToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.WEB_SEARCH;

  constructor() {
    super(
      WebSearchTool.Name,
      ToolDisplayNames.WEB_SEARCH,
      'Searches the public web through the paired LAL host and returns titles, snippets, and source URLs. Use it to discover sources; open important results with web_fetch before relying on them.',
      Kind.Search,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A focused web search query',
            minLength: 1,
            maxLength: MAX_QUERY_CHARS,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      // shouldDefer — WAS true, which is the root cause of PLAN 2.1's shell
      // fallback, confirmed from two field sessions on 2026-07-25.
      //
      // A deferred tool is hidden from the model's tool list until `tool_search`
      // reveals it. Meanwhile the base system prompt says "Use web_search to
      // discover candidate sources and web_fetch to inspect the important
      // originals", and the research controller injects "In this session
      // web_search and web_fetch are already available". Both statements were
      // false on the first turn of every session.
      //
      // Told to use a tool it cannot see, the model did the only thing left: it
      // passed the name to the shell — `web_search "monitores usados"`,
      // `subprocess.run(['web_search', query])`. That is exactly PLAN 2.1's
      // hypothesis 2 ("a tool it was told about in the system prompt is absent
      // from the actual payload — verify they agree"), and it produced a research
      // run whose every source was invisible to the evidence gate.
      //
      // The prompt advertises these unconditionally, so the registry must too.
      // Two small schemas per turn is the entire cost.
      false, // shouldDefer
      false, // alwaysLoad
      'web search internet sources repositories github research',
    );
  }

  protected override validateToolParamValues(
    params: WebSearchToolParams,
  ): string | null {
    const query = params.query?.trim();
    if (!query) return "The 'query' parameter cannot be empty.";
    if (query.length > MAX_QUERY_CHARS) {
      return `The 'query' parameter cannot exceed ${MAX_QUERY_CHARS} characters.`;
    }
    return null;
  }

  protected createInvocation(
    params: WebSearchToolParams,
  ): ToolInvocation<WebSearchToolParams, ToolResult> {
    return new WebSearchToolInvocation(params);
  }
}
