/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

const MISTRAL_API_HOST = 'api.mistral.ai';
const MISTRAL_MODEL_MARKERS = [
  'mistral',
  'mixtral',
  'codestral',
  'ministral',
  'pixtral',
  'magistral',
  'devstral',
] as const;

function isMistralHostname(config: ContentGeneratorConfig): boolean {
  const baseUrl = config.baseUrl ?? '';
  if (!baseUrl) return false;

  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === MISTRAL_API_HOST || hostname.endsWith(`.${MISTRAL_API_HOST}`)
    );
  } catch {
    return false;
  }
}

export function isMistralProvider(config: ContentGeneratorConfig): boolean {
  if (isMistralHostname(config)) return true;

  const model = config.model?.toLowerCase() ?? '';
  return MISTRAL_MODEL_MARKERS.some((marker) => model.includes(marker));
}

/**
 * Mistral's OpenAI-compatible endpoint rejects non-standard
 * `messages[].reasoning_content` fields. Keep shared conversation history
 * intact and remove the field only at the outbound request boundary.
 */
export class MistralOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isMistralProvider = isMistralProvider;

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    return {
      ...baseRequest,
      messages: normalizeForStrictAlternation(
        baseRequest.messages.map(stripReasoningContent),
      ),
    };
  }
}

type Message = OpenAI.Chat.ChatCompletionMessageParam;

/**
 * Mistral/Ministral chat templates enforce strict alternation: only `user`
 * and `assistant`-without-tool-calls messages are counted, and counted
 * messages must alternate user, assistant, user, … after the optional
 * leading system message. Agentic histories legitimately violate this —
 * system reminders, loop-recovery nudges and acceptance continuations all
 * inject a user message directly after tool results — and llama-server then
 * rejects the whole request at template render time with a 500
 * ("conversation roles must alternate…", observed in retry bursts
 * 2026-07-13..17 on ministral-3-8b-instruct).
 *
 * Repair instead of dropping content:
 * - a system message after index 0 becomes user text (the template only
 *   allows system at the head),
 * - adjacent same-role counted messages merge into one,
 * - a counted message at the wrong parity with uncounted messages before it
 *   (e.g. user directly after tool results) gets an empty bridge message of
 *   the opposite role — template-legal, verified by rendering the extracted
 *   Ministral template locally.
 */
export function normalizeForStrictAlternation(messages: Message[]): Message[] {
  const out: Message[] = [];
  // Parity of counted messages so far: even → a user message is expected
  // next, odd → an assistant message is expected next.
  let counted = 0;

  const isCountedUser = (m: Message) => m.role === 'user';
  const isCountedAssistant = (m: Message) =>
    m.role === 'assistant' &&
    !(Array.isArray(m.tool_calls) && m.tool_calls.length > 0);

  for (let i = 0; i < messages.length; i++) {
    let message = messages[i];

    if (message.role === 'system') {
      if (out.length === 0) {
        out.push(message);
        continue;
      }
      // Mid-history system message: the template rejects it outright, so
      // re-role it as user text and let the alternation handling below place
      // it legally.
      message = {
        role: 'user',
        content: contentToText(message.content),
      };
    }

    if (isCountedUser(message)) {
      if (counted % 2 === 0) {
        out.push(message);
        counted++;
      } else {
        const previous = out[out.length - 1];
        if (previous && isCountedUser(previous)) {
          // Adjacent user messages: merge, parity unchanged.
          out[out.length - 1] = mergeUserMessages(
            previous as OpenAI.Chat.ChatCompletionUserMessageParam,
            message as OpenAI.Chat.ChatCompletionUserMessageParam,
          );
        } else {
          // User at assistant parity with uncounted messages (tool results)
          // in between: bridge with an empty assistant turn.
          out.push({ role: 'assistant', content: '' });
          counted++;
          out.push(message);
          counted++;
        }
      }
      continue;
    }

    if (isCountedAssistant(message)) {
      if (counted % 2 === 1) {
        out.push(message);
        counted++;
      } else {
        const previous = out[out.length - 1];
        if (previous && isCountedAssistant(previous)) {
          out[out.length - 1] = mergeAssistantMessages(
            previous as OpenAI.Chat.ChatCompletionAssistantMessageParam,
            message as OpenAI.Chat.ChatCompletionAssistantMessageParam,
          );
        } else {
          out.push({ role: 'user', content: '' });
          counted++;
          out.push(message);
          counted++;
        }
      }
      continue;
    }

    // Uncounted (tool results, assistant messages carrying tool calls):
    // exempt from alternation, pass through.
    out.push(message);
  }

  return out;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function hasNonTextPart(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type !== 'text',
    )
  );
}

function mergeUserMessages(
  a: OpenAI.Chat.ChatCompletionUserMessageParam,
  b: OpenAI.Chat.ChatCompletionUserMessageParam,
): OpenAI.Chat.ChatCompletionUserMessageParam {
  // Preserve non-text parts (images) by concatenating part arrays; pure-text
  // messages merge into a single string so the rendered prompt stays close
  // to what two separate [INST] blocks would have said.
  if (hasNonTextPart(a.content) || hasNonTextPart(b.content)) {
    const partsA = Array.isArray(a.content)
      ? a.content
      : [{ type: 'text' as const, text: String(a.content ?? '') }];
    const partsB = Array.isArray(b.content)
      ? b.content
      : [{ type: 'text' as const, text: String(b.content ?? '') }];
    return { ...a, content: [...partsA, ...partsB] };
  }
  const text = [contentToText(a.content), contentToText(b.content)]
    .filter(Boolean)
    .join('\n\n');
  return { ...a, content: text };
}

function mergeAssistantMessages(
  a: OpenAI.Chat.ChatCompletionAssistantMessageParam,
  b: OpenAI.Chat.ChatCompletionAssistantMessageParam,
): OpenAI.Chat.ChatCompletionAssistantMessageParam {
  const text = [contentToText(a.content), contentToText(b.content)]
    .filter(Boolean)
    .join('\n\n');
  return { ...a, ...b, content: text };
}

function stripReasoningContent(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (!('reasoning_content' in message)) {
    return message;
  }

  const next = { ...(message as unknown as Record<string, unknown>) };
  delete next['reasoning_content'];
  return next as unknown as OpenAI.Chat.ChatCompletionMessageParam;
}
