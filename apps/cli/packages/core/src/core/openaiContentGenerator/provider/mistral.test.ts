/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { determineProvider } from '../index.js';
import { normalizeForStrictAlternation } from './mistral.js';

function createCliConfig(): Config {
  return {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;
}

function createProviderConfig(
  overrides: Partial<ContentGeneratorConfig>,
): ContentGeneratorConfig {
  return {
    apiKey: 'test-api-key',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    ...overrides,
  } as ContentGeneratorConfig;
}

function createReasoningRequest(): OpenAI.Chat.ChatCompletionCreateParams {
  return {
    model: 'mistral-large-latest',
    messages: [
      { role: 'user', content: 'Say OK' },
      {
        role: 'assistant',
        content: 'OK',
        reasoning_content: 'User asked for a short response.',
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam & {
        reasoning_content: string;
      },
      { role: 'user', content: 'Say OK again' },
      // Trailing assistant turn without reasoning keeps the inline-replay
      // pass out of these strip/preserve assertions on messages[1].
      { role: 'assistant', content: 'OK again' },
    ],
    max_tokens: 1000,
  };
}

describe('Mistral provider outbound compatibility filtering', () => {
  it('strips reasoning_content from outgoing requests for api.mistral.ai without mutating the source history', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.mistral.ai/v1',
        model: 'strict-chat-alias',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(result.messages?.[1]).toEqual({
      role: 'assistant',
      content: 'OK',
    });
    expect(
      (originalRequest.messages[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('User asked for a short response.');
  });

  it('also strips reasoning_content when a Mistral model is served behind a custom base URL', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://strict-proxy.example.com/v1',
        model: 'Mistral-Large-Latest',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(result.messages?.[1]).toEqual({
      role: 'assistant',
      content: 'OK',
    });
  });

  it('preserves reasoning_content for non-Mistral OpenAI-compatible providers', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(
      (result.messages?.[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('User asked for a short response.');
  });

  it('inlines the latest assistant reasoning into content instead of deleting it outright', () => {
    // The Ministral amnesia fix: without inlining, the strip pass erased the
    // model's most recent reasoning entirely.
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://strict-proxy.example.com/v1',
        model: 'ministral-8b',
      }),
      createCliConfig(),
    );
    const request: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'ministral-8b',
      messages: [
        { role: 'user', content: 'Say OK' },
        {
          role: 'assistant',
          content: 'OK',
          reasoning_content: 'Latest reasoning.',
        } as OpenAI.Chat.ChatCompletionAssistantMessageParam & {
          reasoning_content: string;
        },
      ],
    };

    const result = provider.buildRequest(request, 'prompt-123');

    expect(result.messages?.[1]).toEqual({
      role: 'assistant',
      content:
        '<recalled_thinking>\nLatest reasoning.\n</recalled_thinking>\n\nOK',
    });
  });

  it('does not treat hostile hostnames containing api.mistral.ai as Mistral', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.mistral.ai.evil.example/v1',
        model: 'gpt-4o',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(
      (result.messages?.[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('User asked for a short response.');
  });
});

describe('normalizeForStrictAlternation', () => {
  // Shapes validated against the actual Ministral chat template rendered
  // locally (scratchpad harness, 2026-07-19): user-after-tool, consecutive
  // same-role, and mid-history system all raise; the empty-bridge shapes pass.
  const SYS = { role: 'system', content: 'sys' } as const;
  const user = (t: string) => ({ role: 'user', content: t }) as const;
  const asst = (t: string) => ({ role: 'assistant', content: t }) as const;
  const asstTc = {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'c1',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
    ],
  } as const;
  const tool = { role: 'tool', tool_call_id: 'c1', content: 'ok' } as const;

  const run = (messages: unknown[]) =>
    normalizeForStrictAlternation(
      messages as OpenAI.Chat.ChatCompletionMessageParam[],
    );

  it('passes already-legal histories through unchanged', () => {
    const legal = [SYS, user('a'), asstTc, tool, asst('done'), user('next')];
    expect(run(legal)).toEqual(legal);
  });

  it('bridges a user message that directly follows tool results', () => {
    const result = run([SYS, user('a'), asstTc, tool, user('nudge')]);
    expect(result.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    expect(result[4]).toEqual({ role: 'assistant', content: '' });
    expect(result[5]).toEqual(user('nudge'));
  });

  it('merges adjacent user messages', () => {
    const result = run([SYS, user('a'), user('b')]);
    expect(result).toEqual([SYS, user('a\n\nb')]);
  });

  it('merges adjacent assistant messages', () => {
    const result = run([SYS, user('a'), asst('x'), asst('y')]);
    expect(result).toEqual([SYS, user('a'), asst('x\n\ny')]);
  });

  it('re-roles a mid-history system message as user text and keeps alternation legal', () => {
    const result = run([SYS, user('a'), asstTc, tool, { role: 'system', content: 'mid' }]);
    expect(result.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    expect(result[5]).toEqual(user('mid'));
  });

  it('bridges an assistant-first history with an empty user turn', () => {
    const result = run([SYS, asst('continuation')]);
    expect(result).toEqual([SYS, user(''), asst('continuation')]);
  });

  it('concatenates part arrays when merging users with non-text parts', () => {
    const img = { type: 'image_url', image_url: { url: 'data:x' } };
    const result = run([
      SYS,
      { role: 'user', content: [{ type: 'text', text: 'a' }, img] },
      user('b'),
    ]);
    expect(result).toHaveLength(2);
    expect((result[1] as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'a' },
      img,
      { type: 'text', text: 'b' },
    ]);
  });

  it('is applied by the Mistral provider buildRequest', () => {
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'http://127.0.0.1:8770/api/llm/v1',
        model: 'ministral-3-8b-instruct',
      }),
      createCliConfig(),
    );
    const result = provider.buildRequest(
      {
        model: 'ministral-3-8b-instruct',
        messages: [
          SYS,
          user('a'),
          asstTc,
          tool,
          user('reminder'),
        ] as OpenAI.Chat.ChatCompletionMessageParam[],
      },
      'prompt-1',
    );
    expect(result.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
  });
});
