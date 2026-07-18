import OpenAI, { type ClientOptions } from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DEFAULT_MAX_RETRIES, resolveRequestTimeout } from '../constants.js';
import type { OpenAICompatibleProvider } from './types.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import {
  tokenLimit,
  hasExplicitOutputLimit,
  defaultOutputCeiling,
  parsePositiveIntegerEnvValue,
} from '../../tokenLimits.js';

type AssistantMessageWithReasoningFields =
  OpenAI.Chat.ChatCompletionAssistantMessageParam & {
    reasoning_content?: string | null;
    reasoning?: string | null;
  };

function shouldMirrorReasoningContentForQwen3(model: string): boolean {
  return model.toLowerCase().includes('qwen3');
}

/**
 * Cap on replayed reasoning. The tail is kept — conclusions and decisions
 * live at the end of a think block, and small local context windows cannot
 * afford the whole thing.
 */
const REPLAY_REASONING_DEFAULT_MAX_CHARS = 4000;

function replayReasoningMaxChars(): number {
  const raw = process.env['LAL_REPLAY_REASONING_CHARS'];
  if (raw === undefined || raw === '') {
    return REPLAY_REASONING_DEFAULT_MAX_CHARS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * Inference servers ignore `reasoning_content` on INPUT (it is an output
 * field), and chat templates that do understand it (Qwen3) deliberately strip
 * reasoning from every assistant message before the latest user query. Either
 * way the model never re-reads what it just reasoned, so on the next message
 * it redoes the work. Inline the most recent assistant reasoning into that
 * message's visible content, using tags a chat template will not strip
 * (anything but `</think>` survives Qwen3's split). Only the LAST assistant
 * message is replayed to bound the context cost.
 */
function replayLatestAssistantReasoning(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const maxChars = replayReasoningMaxChars();
  if (maxChars <= 0) return messages;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;

    const assistant = message as AssistantMessageWithReasoningFields;
    const reasoning =
      typeof assistant.reasoning_content === 'string' &&
      assistant.reasoning_content.trim().length > 0
        ? assistant.reasoning_content
        : undefined;
    // Only the latest assistant message is replayed; if it carried no
    // reasoning there is nothing trustworthy to recall.
    if (!reasoning) return messages;

    const clipped =
      reasoning.length > maxChars
        ? `…${reasoning.slice(-maxChars)}`
        : reasoning;
    const recall = `<recalled_thinking>\n${clipped.trim()}\n</recalled_thinking>`;

    const {
      reasoning_content: _dropReasoningContent,
      reasoning: _dropReasoning,
      ...rest
    } = assistant;
    let replayed: AssistantMessageWithReasoningFields;
    if (typeof assistant.content === 'string' && assistant.content.length > 0) {
      replayed = { ...rest, content: `${recall}\n\n${assistant.content}` };
    } else if (Array.isArray(assistant.content)) {
      replayed = {
        ...rest,
        content: [{ type: 'text', text: recall }, ...assistant.content],
      };
    } else {
      replayed = { ...rest, content: recall };
    }

    const next = [...messages];
    next[i] = replayed as OpenAI.Chat.ChatCompletionMessageParam;
    return next;
  }
  return messages;
}

function mirrorReasoningContentToReasoning(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'assistant') {
    return message;
  }

  const assistant = message as AssistantMessageWithReasoningFields;
  if (
    typeof assistant.reasoning_content !== 'string' ||
    assistant.reasoning_content.length === 0 ||
    typeof assistant.reasoning === 'string'
  ) {
    return message;
  }

  return {
    ...assistant,
    reasoning: assistant.reasoning_content,
  } as OpenAI.Chat.ChatCompletionMessageParam;
}

/**
 * Default provider for standard OpenAI-compatible APIs
 */
export class DefaultOpenAICompatibleProvider
  implements OpenAICompatibleProvider
{
  protected contentGeneratorConfig: ContentGeneratorConfig;
  protected cliConfig: Config;

  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    this.cliConfig = cliConfig;
    this.contentGeneratorConfig = contentGeneratorConfig;
  }

  buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { customHeaders } = this.contentGeneratorConfig;
    const defaultHeaders = {
      'User-Agent': userAgent,
    };

    return customHeaders
      ? { ...defaultHeaders, ...customHeaders }
      : defaultHeaders;
  }

  buildClient(): OpenAI {
    const {
      apiKey,
      baseUrl,
      maxRetries = DEFAULT_MAX_RETRIES,
    } = this.contentGeneratorConfig;
    const timeout = resolveRequestTimeout(this.contentGeneratorConfig.timeout);
    const defaultHeaders = this.buildHeaders();
    // Configure fetch options for proxy support and timeout handling.
    // With proxy, dispatcher timeouts are disabled so SDK timeout controls the
    // request; without proxy, no custom dispatcher is installed.
    const runtimeOptions = buildRuntimeFetchOptions(
      'openai',
      this.cliConfig.getProxy(),
    );
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
      // The OpenAI SDK's public RequestInit type does not expose undici's
      // dispatcher or Bun's timeout:false extension.  Both are intentional
      // runtime options supplied by our transport helper.
      ...((runtimeOptions || {}) as Pick<
        ClientOptions,
        'fetch' | 'fetchOptions'
      >),
    });
  }

  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    _userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const extraBody = this.contentGeneratorConfig.extra_body;

    // Apply output token limits to ensure max_tokens is set appropriately
    // This prevents occupying too much context window with output reservation
    const requestWithTokenLimits = this.applyOutputTokenLimit(request);
    const replayedMessages = this.shouldReplayReasoningInline()
      ? replayLatestAssistantReasoning(requestWithTokenLimits.messages)
      : requestWithTokenLimits.messages;
    const messages = shouldMirrorReasoningContentForQwen3(request.model)
      ? replayedMessages.map(mirrorReasoningContentToReasoning)
      : replayedMessages;

    return {
      ...requestWithTokenLimits,
      messages,
      ...(extraBody ? extraBody : {}),
    };
  }

  getDefaultGenerationConfig(): GenerateContentConfig {
    return {};
  }

  /**
   * Providers whose API accepts `reasoning_content` on INPUT (DeepSeek, MiMo)
   * replay reasoning natively and must not also inline it. Generic servers
   * ignore the field, so the default inlines the latest assistant reasoning
   * into visible content (see replayLatestAssistantReasoning).
   */
  protected shouldReplayReasoningInline(): boolean {
    return true;
  }

  /**
   * Apply output token limit to a request's max_tokens parameter.
   *
   * Purpose:
   * Some APIs (e.g., OpenAI-compatible) default to a very small max_tokens value,
   * which can cause responses to be truncated mid-output. This function ensures
   * a reasonable default is set while respecting user configuration.
   *
   * Logic:
   * 1. If user explicitly configured max_tokens:
   *    - For known models (in OUTPUT_PATTERNS): use the user's value, but cap at
   *      model's max output limit to avoid API errors
   *      (input + max_output > contextWindowSize would cause 400 errors on some APIs)
   *    - For unknown models (deployment aliases, self-hosted): respect user's
   *      configured value entirely (backend may support larger limits)
   * 2. If user didn't configure max_tokens:
   *    - Check QWEN_CODE_MAX_OUTPUT_TOKENS env var first
   *    - Otherwise use the model's output limit, clipped to
   *      OUTPUT_TOKEN_CEILING (64K)
   * 3. If model has no specific limit (tokenLimit returns default):
   *    - Use DEFAULT_OUTPUT_TOKEN_LIMIT
   *
   * Examples:
   * - User sets 4K, known model limit 64K → uses 4K (respects user preference)
   * - User sets 100K, known model limit 64K → uses 64K (capped to avoid API error)
   * - User sets 100K, unknown model → uses 100K (respects user, backend may support it)
   * - User not set, model limit 64K → uses 64K
   * - User not set, model limit 4K → uses 4K (model limit is lower)
   * - User not set, env QWEN_CODE_MAX_OUTPUT_TOKENS=16000 -> uses 16K
   *
   * @param request - The chat completion request parameters
   * @returns The request with max_tokens adjusted according to the logic
   */
  protected applyOutputTokenLimit<
    T extends { max_tokens?: number | null; model: string },
  >(request: T): T {
    // When samplingParams is set, it is the source of truth for the wire shape.
    // Don't inject a max_tokens default — honor the user's explicit choice.
    if (this.contentGeneratorConfig.samplingParams !== undefined) {
      return request;
    }

    const userMaxTokens = request.max_tokens;

    // Get model-specific output limit and check if model is known
    const modelLimit = tokenLimit(request.model, 'output');
    const isKnownModel = hasExplicitOutputLimit(request.model);

    // Determine the effective max_tokens
    let effectiveMaxTokens: number;

    if (userMaxTokens !== undefined && userMaxTokens !== null) {
      // User explicitly configured max_tokens
      if (isKnownModel) {
        // Known model: respect user config but cap at model limit to avoid API errors
        effectiveMaxTokens = Math.min(userMaxTokens, modelLimit);
      } else {
        // Unknown model (deployment aliases, self-hosted): respect user's value
        // The backend may support larger limits than our default
        effectiveMaxTokens = userMaxTokens;
      }
    } else {
      // No explicit user config — check env var, then use the model limit
      // clipped to the flat output ceiling (models advertising huge output
      // limits must not request the whole window; users who need more set
      // max_tokens explicitly).
      const envMaxTokens = parsePositiveIntegerEnvValue(
        process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'],
      );
      if (envMaxTokens !== undefined) {
        effectiveMaxTokens = isKnownModel
          ? Math.min(envMaxTokens, modelLimit)
          : envMaxTokens;
      } else {
        effectiveMaxTokens = defaultOutputCeiling(request.model);
      }
    }

    return {
      ...request,
      max_tokens: effectiveMaxTokens,
    };
  }
}
