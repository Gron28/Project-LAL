/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config/config.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

export interface BrowserScreenshotParams {
  url: string;
  width?: number;
  height?: number;
  output_file?: string;
}

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function within(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

class BrowserScreenshotInvocation extends BaseToolInvocation<
  BrowserScreenshotParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: BrowserScreenshotParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Capture and inspect ${this.params.url}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const chrome = process.env['CHROME_PATH'] ||
      (await Promise.all(CHROME_CANDIDATES.map(async (candidate) => {
        try { await fs.access(candidate); return candidate; } catch { return null; }
      }))).find(Boolean);
    if (!chrome) {
      return {
        llmContent: 'No Chrome/Chromium executable was found. Set CHROME_PATH.',
        returnDisplay: 'Browser screenshot unavailable',
        error: { message: 'No Chrome/Chromium executable found' },
      };
    }

    const width = this.params.width ?? 1280;
    const height = this.params.height ?? 800;
    const target = this.params.output_file
      ? path.resolve(this.params.output_file)
      : path.join(
          this.config.storage.getProjectTempDir(),
          `browser-${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
        );
    await fs.mkdir(path.dirname(target), { recursive: true });

    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(chrome, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
        `--window-size=${width},${height}`, `--screenshot=${target}`,
        '--dump-dom', this.params.url,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const abort = () => child.kill('SIGKILL');
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', () => resolve(-1));
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(code ?? -1);
      });
    });
    if (exitCode !== 0) {
      const detail = Buffer.concat(stderr).toString('utf8').slice(-1200);
      return {
        llmContent: `Browser exited ${exitCode}: ${detail}`,
        returnDisplay: `Browser screenshot failed (${exitCode})`,
        error: { message: detail || `Browser exited ${exitCode}` },
      };
    }

    const image = await fs.readFile(target);
    const dom = Buffer.concat(stdout).toString('utf8').slice(0, 12_000);
    return {
      llmContent: [
        { text: `Screenshot captured at ${width}x${height}. Rendered DOM excerpt:\n${dom}` },
        { inlineData: { mimeType: 'image/png', data: image.toString('base64') } },
      ],
      returnDisplay: `Captured ${this.params.url} at ${width}x${height}`,
      resultFilePaths: this.params.output_file ? [target] : undefined,
      artifacts: [{
        kind: 'image', storage: this.params.output_file ? 'workspace' : 'managed',
        title: 'Browser screenshot', workspacePath: this.params.output_file ? target : undefined,
        mimeType: 'image/png', sizeBytes: image.length,
      }],
    };
  }
}

export class BrowserScreenshotTool extends BaseDeclarativeTool<
  BrowserScreenshotParams,
  ToolResult
> {
  static readonly Name = ToolNames.BROWSER_SCREENSHOT;

  constructor(private readonly config: Config) {
    super(
      BrowserScreenshotTool.Name,
      ToolDisplayNames.BROWSER_SCREENSHOT,
      'Open a localhost or workspace file URL in headless Chrome, return the rendered DOM and an actual PNG image for visual inspection. Use after starting a local web app. This is read-only browser inspection; use shell or app controls for interaction.',
      Kind.Read,
      {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A localhost http URL or workspace file:// URL' },
          width: { type: 'integer', minimum: 320, maximum: 2560 },
          height: { type: 'integer', minimum: 320, maximum: 2560 },
          output_file: { type: 'string', description: 'Optional PNG path inside the workspace' },
        },
        required: ['url'],
      },
      true,
      false,
      // Small local models commonly keep replaying the tool that preceded a
      // successful ToolSearch reveal instead of selecting the newly injected
      // schema. Browser inspection is core to web work, so keep this compact
      // read-only schema visible just like web_search and web_fetch.
      false,
      false,
      'browser screenshot localhost visual image webpage chrome render inspect UI',
    );
  }

  protected override validateToolParamValues(params: BrowserScreenshotParams): string | null {
    let url: URL;
    try { url = new URL(params.url); } catch { return 'url must be a valid absolute URL'; }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        return 'browser_screenshot only accepts localhost URLs';
      }
    } else if (url.protocol === 'file:') {
      if (!within(this.config.getTargetDir(), decodeURIComponent(url.pathname))) {
        return 'file URLs must remain inside the workspace';
      }
    } else return 'url must use http(s) localhost or file://';
    if (params.output_file && !within(this.config.getTargetDir(), params.output_file)) {
      return 'output_file must remain inside the workspace';
    }
    return null;
  }

  protected createInvocation(params: BrowserScreenshotParams): ToolInvocation<BrowserScreenshotParams, ToolResult> {
    return new BrowserScreenshotInvocation(this.config, params);
  }
}
