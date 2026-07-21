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

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const token =
    process.env['LAL_API_KEY']?.trim() ||
    process.env['LAL_CLI_TOKEN']?.trim();
  if (token) headers['authorization'] = `Bearer ${token}`;

  const forwardedHeaders: Array<[string, string | undefined]> = [
    ['x-lal-device-id', process.env['LAL_DEVICE_ID']],
    ['x-lal-device-name', process.env['LAL_DEVICE_NAME']],
    ['x-lal-platform', process.env['LAL_PLATFORM']],
    ['x-lal-client-version', process.env['LAL_CLIENT_VERSION']],
  ];
  for (const [name, value] of forwardedHeaders) {
    if (value?.trim()) headers[name] = value.trim();
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
      true,
      false,
      true,
      false,
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
