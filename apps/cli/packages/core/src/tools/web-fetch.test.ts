/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebFetchTool } from './web-fetch.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import * as fetchUtils from '../utils/fetch.js';

// Mocks the underlying call BaseLlmClient.generateText makes; web-fetch's
// `runSideQuery` text-mode path lands on this mock.
const mockGenerateContent = vi.fn();
const mockGetBaseLlmClient = vi.fn(() => ({
  generateText: mockGenerateContent,
}));

vi.mock('../utils/fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof fetchUtils>();
  return {
    ...actual,
    fetchWithTimeout: vi.fn(),
    isPrivateIp: vi.fn(),
    isPrivateNetworkUrl: vi.fn(),
  };
});

describe('WebFetchTool', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.resetAllMocks();
    mockConfig = {
      getApprovalMode: vi.fn(),
      setApprovalMode: vi.fn(),
      getProxy: vi.fn(),
      getBaseLlmClient: mockGetBaseLlmClient,
      getFastModel: vi.fn(() => undefined),
      getSessionId: vi.fn(() => 'test-session-id'),
      getModel: vi.fn(() => 'qwen-coder'),
    } as unknown as Config;
  });

  describe('execute', () => {
    it('should throw validation error when url parameter is missing', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = { prompt: 'no url here' };
      /* @ts-expect-error - we are testing validation */
      expect(() => tool.build(params)).toThrow(
        "params must have required property 'url'",
      );
    });

    it.each(['HTTPS://example.com', 'Http://example.com'])(
      'should accept uppercase http url schemes: %s',
      (url) => {
        const tool = new WebFetchTool(mockConfig);
        expect(() =>
          tool.build({ url, prompt: 'summarize this' }),
        ).not.toThrow();
      },
    );

    it.each([
      [
        'ftp://example.com',
        "The 'url' must be a valid URL starting with http:// or https://.",
      ],
      [
        'http:example.com',
        "The 'url' must be a valid URL starting with http:// or https://.",
      ],
      [
        'http:/example.com',
        "The 'url' must be a valid URL starting with http:// or https://.",
      ],
      ['https://', "The 'url' is malformed and could not be parsed."],
      ['http://[::1', "The 'url' is malformed and could not be parsed."],
    ])(
      'should reject invalid or unsupported urls: %s',
      (url, expectedError) => {
        const tool = new WebFetchTool(mockConfig);
        expect(() => tool.build({ url, prompt: 'summarize this' })).toThrow(
          expectedError,
        );
      },
    );

    it.each([
      'https://user:secret@example.com/page',
      'http://user@example.com/page',
      'https://:secret@example.com/page',
      'https://%75ser@example.com/page',
    ])('should reject URLs containing credentials: %s', (url) => {
      const tool = new WebFetchTool(mockConfig);
      expect(() => tool.build({ url, prompt: 'summarize this' })).toThrow(
        "The 'url' must not include credentials.",
      );
    });

    it('should return WEB_FETCH_FALLBACK_FAILED on fetch failure', async () => {
      vi.spyOn(fetchUtils, 'isPrivateIp').mockReturnValue(true);
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockRejectedValue(
        new Error('fetch failed'),
      );
      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://private.ip', prompt: 'summarize this' };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
    });

    it('refuses a navigation-menu page instead of reporting it as a source', async () => {
      // Yahoo returned exactly this shape on 2026-07-25 and web_fetch called it a
      // success; the model then counted it toward the research coverage gate and
      // reported "4 sources opened" when this one had no prose in it.
      const nav = [
        'NEWS',
        ...Array.from({ length: 30 }, (_, i) => ` * item ${i}`),
        'LIFE',
        ' * Health',
        ' * Parenting',
      ].join('\n');
      vi.spyOn(fetchUtils, 'isPrivateIp').mockReturnValue(false);
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: () => Promise.resolve(nav),
      } as Response);

      const tool = new WebFetchTool(mockConfig);
      const result = await tool
        .build({ url: 'https://news.example/x', prompt: 'the chef tips' })
        .execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(String(result.llmContent)).toContain('navigation menu');
    });

    it('accepts a short but substantive page rather than judging it by length', async () => {
      // The counterweight to the test above: a small JSON body or plain-text file
      // has no long lines either and must NOT be rejected for being brief. This
      // is why the nav check requires many lines as well as low prose.
      vi.spyOn(fetchUtils, 'isPrivateIp').mockReturnValue(false);
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"cook_minutes":3,"eggs":2}'),
      } as Response);

      const tool = new WebFetchTool(mockConfig);
      const result = await tool
        .build({ url: 'https://api.example/omelette', prompt: 'cook time' })
        .execute(new AbortController().signal);

      expect(result.error).toBeUndefined();
      expect(String(result.llmContent)).toContain('cook_minutes');
    });

    it('returns page text directly and never calls a second model', async () => {
      // web_fetch used to summarise every page with a full generation on the
      // MAIN model, so a research pass paid for N extra generations serialised
      // behind the GPU lease the outer turn already held. That made a model
      // outage or a busy GPU a web_fetch failure. Now there is no second call
      // to fail, and this test is what keeps it that way.
      vi.spyOn(fetchUtils, 'isPrivateIp').mockReturnValue(false);
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: () => Promise.resolve('<html><body>Test content</body></html>'),
      } as Response);
      mockGenerateContent.mockRejectedValue(new Error('API error'));
      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://public.ip', prompt: 'summarize this' };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(String(result.llmContent)).toContain('Test content');
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('blocks a research redirect to a private network target', async () => {
      vi.mocked(fetchUtils.isPrivateNetworkUrl)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      vi.mocked(fetchUtils.fetchWithTimeout).mockResolvedValueOnce({
        ok: false,
        status: 302,
        statusText: 'Found',
        headers: new Headers({ location: 'http://127.0.0.1/private' }),
      } as Response);
      const tool = new WebFetchTool({
        ...mockConfig,
        getGeminiClient: () => ({ isResearchModeActive: () => true }),
      } as unknown as Config);
      const invocation = tool.build({
        url: 'https://example.com/redirect',
        prompt: 'extract evidence',
      });

      const result = await invocation.execute(new AbortController().signal);

      expect(result.error?.type).toBe(ToolErrorType.WEB_FETCH_FALLBACK_FAILED);
      expect(result.llmContent).toContain(
        'blocked a private or unresolved network target',
      );
      expect(fetchUtils.fetchWithTimeout).toHaveBeenCalledTimes(1);
    });
  });

  describe('format parameter', () => {
    it('should default to auto format when not specified', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithTimeout')
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('<html><body>Test content</body></html>'),
        } as Response);

      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Summary' },
      });

      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://example.com', prompt: 'summarize' };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Number),
        {
          Accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1',
        },
      );
    });

    it('should prefer markdown when format is markdown', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithTimeout')
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'text/markdown' }),
          text: () => Promise.resolve('# Test Content'),
        } as Response);

      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Summary' },
      });

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize',
        format: 'markdown' as const,
      };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Number),
        { Accept: 'text/markdown, */*;q=0.1' },
      );
    });

    it('should prefer HTML when format is html', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithTimeout')
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: () => Promise.resolve('<html><body>Test content</body></html>'),
        } as Response);

      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Summary' },
      });

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize',
        format: 'html' as const,
      };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Number),
        { Accept: 'text/html, */*;q=0.1' },
      );
    });

    it('should prefer plain text when format is text', async () => {
      const fetchSpy = vi
        .spyOn(fetchUtils, 'fetchWithTimeout')
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'text/plain' }),
          text: () => Promise.resolve('Plain text content'),
        } as Response);

      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Summary' },
      });

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize',
        format: 'text' as const,
      };
      const invocation = tool.build(params);
      await invocation.execute(new AbortController().signal);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com',
        expect.any(Number),
        { Accept: 'text/plain, */*;q=0.1' },
      );
    });

    it('should process JSON content returned by fallback content negotiation', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () =>
          Promise.resolve(
            JSON.stringify({
              published_at: '2026-01-27T11:50:52Z',
              body: '<p>Release <b>notes</b></p>',
              desc: 'Use &amp; for ampersand',
            }),
          ),
      } as Response);

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://api.github.com/repos/openai/codex/releases/tags/rust-v0.92.0',
        prompt: 'report the published date',
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      receivedContent = String(result.llmContent);

      expect(receivedContent).toContain('published_at');
      expect(receivedContent).toContain('2026-01-27T11:50:52Z');
      expect(receivedContent).toContain('<p>Release <b>notes</b></p>');
      expect(receivedContent).toContain('Use &amp; for ampersand');
    });

    it('should include markdown content in prompt when server returns markdown', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        headers: new Headers({
          'content-type': 'text/markdown; charset=utf-8',
        }),
        text: () =>
          Promise.resolve('# Hello World\n\nThis is markdown content.'),
      } as Response);

      const tool = new WebFetchTool(mockConfig);
      const params = { url: 'https://example.com', prompt: 'summarize' };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      receivedContent = String(result.llmContent);

      expect(receivedContent).toContain('# Hello World');
    });

    it('should include plain text content in prompt when server returns plain text', async () => {
      let receivedContent = '';
      vi.spyOn(fetchUtils, 'fetchWithTimeout').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: () => Promise.resolve('Plain text content here'),
      } as Response);

      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize',
        format: 'text' as const,
      };
      const invocation = tool.build(params);
      const result = await invocation.execute(new AbortController().signal);
      receivedContent = String(result.llmContent);

      expect(receivedContent).toContain('Plain text content here');
    });
  });

  describe('getConfirmationDetails', () => {
    it('allows public sources during an explicit research request', async () => {
      const tool = new WebFetchTool({
        ...mockConfig,
        getGeminiClient: () => ({ isResearchModeActive: () => true }),
      } as unknown as Config);
      vi.mocked(fetchUtils.isPrivateNetworkUrl).mockResolvedValue(false);
      const invocation = tool.build({
        url: 'https://sqlite.org/isolation.html',
        prompt: 'extract transaction behavior',
      });

      expect(await invocation.getDefaultPermission()).toBe('allow');
    });

    it.each([
      'http://127.0.0.1:8770/api/models',
      'http://localhost:8770/api/models',
      'http://service.local/private',
      'http://169.254.169.254/latest/meta-data',
    ])(
      'still asks before research fetches a private target: %s',
      async (url) => {
        vi.mocked(fetchUtils.isPrivateNetworkUrl).mockResolvedValue(true);
        const tool = new WebFetchTool({
          ...mockConfig,
          getGeminiClient: () => ({ isResearchModeActive: () => true }),
        } as unknown as Config);
        const invocation = tool.build({ url, prompt: 'extract data' });

        expect(await invocation.getDefaultPermission()).toBe('ask');
      },
    );

    it('should return confirmation details with the correct prompt and urls', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize this page',
      };
      const invocation = tool.build(params);
      expect(await invocation.getDefaultPermission()).toBe('ask');

      const confirmationDetails = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'Fetch content from https://example.com and process with: summarize this page',
        urls: ['https://example.com'],
        permissionRules: ['WebFetch(example.com)'],
        onConfirm: expect.any(Function),
      });
    });

    it('should return github urls as-is in confirmation details', async () => {
      const tool = new WebFetchTool(mockConfig);
      const params = {
        url: 'https://github.com/google/gemini-react/blob/main/README.md',
        prompt: 'summarize the README',
      };
      const invocation = tool.build(params);
      expect(await invocation.getDefaultPermission()).toBe('ask');

      const confirmationDetails = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'Fetch content from https://github.com/google/gemini-react/blob/main/README.md and process with: summarize the README',
        urls: ['https://github.com/google/gemini-react/blob/main/README.md'],
        permissionRules: ['WebFetch(github.com)'],
        onConfirm: expect.any(Function),
      });
    });

    it('should return ask even if approval mode is AUTO_EDIT (approval mode handled by scheduler)', async () => {
      const tool = new WebFetchTool({
        ...mockConfig,
        getApprovalMode: () => ApprovalMode.AUTO_EDIT,
      } as unknown as Config);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize this page',
      };
      const invocation = tool.build(params);
      expect(await invocation.getDefaultPermission()).toBe('ask');

      const confirmationDetails = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      expect(confirmationDetails).toEqual({
        type: 'info',
        title: 'Confirm Web Fetch',
        prompt:
          'Fetch content from https://example.com and process with: summarize this page',
        urls: ['https://example.com'],
        permissionRules: ['WebFetch(example.com)'],
        onConfirm: expect.any(Function),
      });
    });

    it('should have onConfirm as a no-op (approval mode handled by scheduler)', async () => {
      const setApprovalMode = vi.fn();
      const testConfig = {
        ...mockConfig,
        setApprovalMode,
      } as unknown as Config;
      const tool = new WebFetchTool(testConfig);
      const params = {
        url: 'https://example.com',
        prompt: 'summarize this page',
      };
      const invocation = tool.build(params);
      const confirmationDetails = await invocation.getConfirmationDetails(
        new AbortController().signal,
      );

      if (
        confirmationDetails &&
        typeof confirmationDetails === 'object' &&
        'onConfirm' in confirmationDetails
      ) {
        await confirmationDetails.onConfirm(
          ToolConfirmationOutcome.ProceedAlways,
        );
      }

      // setApprovalMode should NOT be called — onConfirm is a no-op
      expect(setApprovalMode).not.toHaveBeenCalled();
    });
  });
});
