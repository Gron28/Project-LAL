/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { convert } from 'html-to-text';
import type { Config } from '../config/config.js';
import {
  fetchWithTimeout,
  isPrivateIp,
  isPrivateNetworkUrl,
} from '../utils/fetch.js';
import { ToolErrorType } from './tool-error.js';
import type {
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolResult,
  ToolConfirmationPayload,
  ToolConfirmationOutcome,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { createDebugLogger, type DebugLogger } from '../utils/debugLogger.js';

const URL_FETCH_TIMEOUT_MS = 10000;
const MAX_CONTENT_LENGTH = 100000;

/**
 * How much fetched page text is handed straight to the calling model.
 *
 * web_fetch used to run the fetched page through a full generation on the MAIN
 * model (runSideQuery, pinned to config.getModel()) to summarise it before
 * returning. On a single-GPU host that is ruinous: a research pass doing N
 * fetches paid for N extra full generations, each with a page-sized prompt,
 * serialised behind the same GPU lease the outer turn is already holding — the
 * likeliest cause of research appearing to hang or fail outright (reported by
 * the operator 2026-07-24).
 *
 * The content is now returned directly, exactly like read_file: the calling
 * model is perfectly capable of extracting what it asked for, it already has the
 * page in context, and no second model, second lease, or second failure mode is
 * involved. 24k chars matches web_search's result budget.
 */
const DIRECT_CONTENT_MAX_CHARS = 24_000;

/**
 * Prose floor for a many-line page, in characters on lines over 80 chars.
 * Calibrated on measured fetches 2026-07-25: a Tasting Table article yielded
 * ~15k and a Mirror article ~4k, while a Yahoo navigation dump yielded zero.
 */
const MIN_PROSE_CHARS = 400;

/**
 * How many non-empty lines make a page's shape "chrome-like". Below this a page
 * is simply short, which is not a defect — the prose floor only applies once
 * there is enough structure for the low density to be meaningful.
 */
const NAV_LINE_COUNT = 15;
const MAX_RESEARCH_REDIRECTS = 5;

/**
 * Parameters for the WebFetch tool
 */
export interface WebFetchToolParams {
  /**
   * The URL to fetch content from
   */
  url: string;
  /**
   * The prompt to run on the fetched content
   */
  prompt: string;
  /**
   * Preferred content format (controls only the Accept header)
   * All content is normalized to plain text for LLM processing
   * - auto: Prefers markdown via content negotiation (default)
   * - markdown: Prefer markdown format
   * - html: Prefer HTML format (still converted to text)
   * - text: Prefer plain text format
   */
  format?: 'auto' | 'markdown' | 'html' | 'text';
}

/**
 * Implementation of the WebFetch tool invocation logic
 */
class WebFetchToolInvocation extends BaseToolInvocation<
  WebFetchToolParams,
  ToolResult
> {
  private readonly debugLogger: DebugLogger;

  constructor(
    private readonly config: Config,
    params: WebFetchToolParams,
  ) {
    super(params);
    this.debugLogger = createDebugLogger('WEB_FETCH');
  }

  private getAcceptHeader(): string {
    const format = this.params.format ?? 'auto';
    switch (format) {
      case 'markdown':
        return 'text/markdown, */*;q=0.1';
      case 'html':
        return 'text/html, */*;q=0.1';
      case 'text':
        return 'text/plain, */*;q=0.1';
      case 'auto':
      default:
        return 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1';
    }
  }

  private async executeDirectFetch(signal: AbortSignal): Promise<ToolResult> {
    let url = this.params.url;

    // Convert GitHub blob URL to raw URL
    if (url.includes('github.com') && url.includes('/blob/')) {
      url = url
        .replace('github.com', 'raw.githubusercontent.com')
        .replace('/blob/', '/');
      this.debugLogger.debug(
        `[WebFetchTool] Converted GitHub blob URL to raw URL: ${url}`,
      );
    }

    const acceptHeader = this.getAcceptHeader();
    this.debugLogger.debug(
      `[WebFetchTool] Using Accept header: ${acceptHeader}`,
    );

    try {
      this.debugLogger.debug(`[WebFetchTool] Fetching content from: ${url}`);
      const researchActive =
        this.config.getGeminiClient?.()?.isResearchModeActive?.() === true;
      let response: Response;
      if (!researchActive) {
        response = await fetchWithTimeout(url, URL_FETCH_TIMEOUT_MS, {
          Accept: acceptHeader,
        });
      } else {
        let currentUrl = url;
        let redirects = 0;
        while (true) {
          if (await isPrivateNetworkUrl(currentUrl)) {
            throw new Error(
              `Research fetch blocked a private or unresolved network target: ${currentUrl}`,
            );
          }
          response = await fetchWithTimeout(
            currentUrl,
            URL_FETCH_TIMEOUT_MS,
            { Accept: acceptHeader },
            'manual',
          );
          if (
            response.status < 300 ||
            response.status >= 400 ||
            !response.headers.get('location')
          ) {
            break;
          }
          if (redirects++ >= MAX_RESEARCH_REDIRECTS) {
            throw new Error('Research fetch exceeded the redirect limit.');
          }
          currentUrl = new URL(
            response.headers.get('location')!,
            currentUrl,
          ).toString();
        }
      }

      if (!response.ok) {
        const errorMessage = `Request failed with status code ${response.status} ${response.statusText}`;
        this.debugLogger.error(`[WebFetchTool] ${errorMessage}`);
        throw new Error(errorMessage);
      }

      this.debugLogger.debug(
        `[WebFetchTool] Successfully fetched content from ${url}`,
      );

      const contentType = response.headers.get('content-type') || '';
      const responseText = await response.text();

      let textContent: string;

      if (contentType.includes('text/markdown')) {
        this.debugLogger.debug('[WebFetchTool] Received markdown content');
        textContent = responseText.substring(0, MAX_CONTENT_LENGTH);
      } else if (contentType.includes('text/plain')) {
        this.debugLogger.debug('[WebFetchTool] Received plain text content');
        textContent = responseText.substring(0, MAX_CONTENT_LENGTH);
      } else if (contentType.includes('text/html')) {
        this.debugLogger.debug('[WebFetchTool] Converting HTML to text');
        textContent = convert(responseText.substring(0, MAX_CONTENT_LENGTH), {
          wordwrap: false,
          selectors: [
            { selector: 'a', options: { ignoreHref: true } },
            { selector: 'img', format: 'skip' },
          ],
        });
      } else {
        this.debugLogger.debug(
          `[WebFetchTool] Passing through ${contentType || 'unknown'} content as text`,
        );
        textContent = responseText.substring(0, MAX_CONTENT_LENGTH);
      }

      this.debugLogger.debug(
        `[WebFetchTool] Content length: ${textContent.length} characters`,
      );

      // Navigation is not content. Extracted text can be non-empty and still
      // carry nothing citable: measured 2026-07-25, Yahoo returned a navigation
      // menu and it was reported as a SUCCESSFUL fetch, after which the model
      // counted it toward the research coverage gate and told the user it had
      // "opened 4 sources" when that one held no prose at all.
      //
      // The discriminator is prose density ACROSS MANY LINES. Chrome arrives as
      // dozens of short list items; an article arrives as long lines. Both
      // conditions are required, because a short-but-real page — a small JSON API
      // response, a plain-text file — also has no long lines and must not be
      // rejected for being brief.
      //
      // Known remaining gap, stated rather than papered over: a page that returns
      // only its <title> (Epicurious did) is a single short line, so it passes
      // here. Catching that needs an absolute length floor, which would also
      // reject legitimately tiny sources. And a site serving the WRONG page
      // (Food Network returning a corporate profile) is rich, well-formed prose —
      // no statistic catches it; the model spotted that one unaided.
      const lines = textContent.split('\n').map((line) => line.trim());
      const proseChars = lines
        .filter((line) => line.length > 80)
        .reduce((total, line) => total + line.length, 0);
      const nonEmptyLines = lines.filter((line) => line.length > 0).length;
      if (proseChars < MIN_PROSE_CHARS && nonEmptyLines >= NAV_LINE_COUNT) {
        const thinMessage =
          `Fetched ${url} (HTTP ${response.status}) but it yielded only ` +
          `${proseChars} characters of prose across ${nonEmptyLines} lines — ` +
          `that shape is a navigation menu or consent wall, not an article. ` +
          `Treat this as a FAILED source: do not cite it, do not count it as ` +
          `opened, and do not refetch it. Find a different source.`;
        return {
          llmContent: `Error: ${thinMessage}`,
          returnDisplay: `No article text at ${url} (${proseChars} chars prose / ${nonEmptyLines} lines)`,
          error: {
            message: thinMessage,
            type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
          },
        };
      }

      // An empty body is a FAILURE, not an empty success. Observed 2026-07-25:
      // food.com, reddit.com and youtube.com each returned HTTP 200 with no
      // extractable text, and web_fetch reported that as a successful fetch with
      // nothing in it. The model read the blank result as "the page had no
      // answer", moved on, and counted it toward research coverage. A tool that
      // returns nothing must say so.
      if (!textContent.trim()) {
        const emptyMessage =
          `Fetched ${url} successfully (HTTP ${response.status}) but extracted no ` +
          `readable text. The page is almost certainly JavaScript-rendered or ` +
          `bot-blocked, so its content is not reachable this way. Treat this as a ` +
          `FAILED source, not an empty one: do not cite it, and do not refetch it. ` +
          `Try a different source.`;
        return {
          llmContent: `Error: ${emptyMessage}`,
          returnDisplay: `No readable text at ${url}`,
          error: {
            message: emptyMessage,
            type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
          },
        };
      }

      const truncated = textContent.length > DIRECT_CONTENT_MAX_CHARS;
      const body = truncated
        ? textContent.slice(0, DIRECT_CONTENT_MAX_CHARS)
        : textContent;

      this.debugLogger.debug(
        `[WebFetchTool] Returning ${body.length} chars directly (truncated=${truncated})`,
      );

      const resultText =
        `Content of ${this.params.url}` +
        (truncated
          ? ` (first ${DIRECT_CONTENT_MAX_CHARS} of ${textContent.length} characters; ` +
            `the page continues past this point)`
          : '') +
        `\n\nYou asked: "${this.params.prompt}"\n` +
        `Answer that from the content below. If the answer is not here, say so ` +
        `rather than guessing — do not refetch the same URL, it will return this ` +
        `same content.\n\n---\n${body}\n---`;

      return {
        llmContent: resultText,
        returnDisplay:
          `Fetched ${body.length.toLocaleString()} chars from ${this.params.url}` +
          (truncated ? ' (truncated)' : ''),
      };
    } catch (e) {
      const error = e as Error;
      const errorMessage = `Error during fetch for ${url}: ${error.message}`;
      this.debugLogger.error(`[WebFetchTool] ${errorMessage}`, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
        },
      };
    }
  }

  override getDescription(): string {
    const displayPrompt =
      this.params.prompt.length > 100
        ? this.params.prompt.substring(0, 97) + '...'
        : this.params.prompt;
    const format = this.params.format ?? 'auto';
    return `Fetching content from ${this.params.url} (format: ${format}) and processing with prompt: "${displayPrompt}"`;
  }

  /**
   * An explicit research request already authorizes read-only access to public
   * sources. Keep ordinary fetches and private/local targets behind the normal
   * confirmation boundary.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const researchActive =
      this.config.getGeminiClient?.()?.isResearchModeActive?.() === true;
    if (researchActive && !(await isPrivateNetworkUrl(this.params.url))) {
      return 'allow';
    }
    return 'ask';
  }

  /**
   * Constructs the web fetch confirmation details.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    // Extract the domain for the permission rule.
    let domain: string;
    try {
      domain = new URL(this.params.url).hostname;
    } catch {
      domain = this.params.url;
    }
    const permissionRules = [`WebFetch(${domain})`];

    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: `Confirm Web Fetch`,
      prompt: `Fetch content from ${this.params.url} and process with: ${this.params.prompt}`,
      urls: [this.params.url],
      permissionRules,
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // No-op: persistence is handled by coreToolScheduler via PM rules
      },
    };
    return confirmationDetails;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    // Check if URL is private/localhost
    const isPrivate = isPrivateIp(this.params.url);

    if (isPrivate) {
      this.debugLogger.debug(
        `[WebFetchTool] Private IP detected for ${this.params.url}, using direct fetch`,
      );
    } else {
      this.debugLogger.debug(
        `[WebFetchTool] Public URL detected for ${this.params.url}, using direct fetch`,
      );
    }

    return this.executeDirectFetch(signal);
  }
}

/**
 * Implementation of the WebFetch tool logic
 */
export class WebFetchTool extends BaseDeclarativeTool<
  WebFetchToolParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.WEB_FETCH;

  constructor(private readonly config: Config) {
    super(
      WebFetchTool.Name,
      ToolDisplayNames.WEB_FETCH,
      'Fetches content from a specified URL and returns its text for you to read\n- Takes a URL and a prompt describing what you want from the page\n- Supports content negotiation for markdown (reduces tokens by ~80%)\n- Fetches the URL content, converts HTML to text if needed\n- Processes the content with the prompt using a small, fast model\n- Returns the model\'s response about the content\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions. All MCP-provided tools start with "mcp__".\n  - The URL must be a fully-formed valid URL\n  - The prompt should describe what information you want to extract from the page\n  - format parameter (optional): controls only the Accept header sent to the server. All content is normalized to plain text for LLM processing, regardless of format.\n  - "auto" (default): Prefers markdown via content negotiation, accepts HTML, text, or other content as fallback. Use when user does NOT specify a format.\n  - "markdown": Prefers text/markdown. Use when user explicitly asks for markdown content.\n  - "html": Prefers text/html. Content is still converted to plain text for LLM processing.\n  - "text": Prefers text/plain. Use when user explicitly asks for plain text.\n  - This tool is read-only and does not modify any files\n  - Long pages are truncated, and the result says so; it is not silently summarised\n  - Supports both public and private/localhost URLs using direct fetch',
      Kind.Fetch,
      {
        properties: {
          url: {
            description: 'The URL to fetch content from',
            type: 'string',
          },
          prompt: {
            description: 'The prompt to run on the fetched content',
            type: 'string',
          },
          format: {
            description:
              'Preferred content format (Accept header only): auto (default, prefers markdown), markdown, html, or text. All content is normalized to plain text.',
            type: 'string',
            enum: ['auto', 'markdown', 'html', 'text'],
          },
        },
        required: ['url', 'prompt'],
        type: 'object',
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      // shouldDefer — WAS true ("web fetching is infrequent"). It is not
      // infrequent during research, and hiding it while the system prompt
      // advertises it is what drove the model to the shell. See the long note in
      // web-search.ts; both tools share one cause and must share the fix.
      false,
      false, // alwaysLoad
      'web fetch url http download content',
    );
  }

  protected override validateToolParamValues(
    params: WebFetchToolParams,
  ): string | null {
    if (!params.url || params.url.trim() === '') {
      return "The 'url' parameter cannot be empty.";
    }
    // Regex rejects non-http(s) schemes and malformed authority that new URL() normalizes away.
    if (!/^https?:\/\//i.test(params.url)) {
      return "The 'url' must be a valid URL starting with http:// or https://.";
    }
    try {
      const parsedUrl = new URL(params.url);
      if (parsedUrl.username || parsedUrl.password) {
        return "The 'url' must not include credentials.";
      }
    } catch {
      return "The 'url' is malformed and could not be parsed.";
    }
    if (!params.prompt || params.prompt.trim() === '') {
      return "The 'prompt' parameter cannot be empty.";
    }
    return null;
  }

  protected createInvocation(
    params: WebFetchToolParams,
  ): ToolInvocation<WebFetchToolParams, ToolResult> {
    return new WebFetchToolInvocation(this.config, params);
  }

  override toAutoClassifierInput(
    params: WebFetchToolParams,
  ): Record<string, unknown> {
    // Do not forward the prompt — it may contain sensitive context.
    return { url: params.url };
  }
}
