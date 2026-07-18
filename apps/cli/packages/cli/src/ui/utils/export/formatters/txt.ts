/**
 * @license
 * Copyright 2026 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExportSessionData, ExportMessage } from '../types.js';

const RULE_HEAVY = '='.repeat(80);
const RULE_LIGHT = '-'.repeat(80);

/**
 * Forensic plain-text transcript: everything the session contained, verbatim
 * and in order — system prompt, user prompts, thinking, responses, every tool
 * call with full input and output, failures made loud, and per-message token
 * usage. The output is designed to be handed to another LLM (or a human) to
 * diagnose exactly why a run went wrong, and to serve as raw material for
 * failure→training-data conversion.
 */
export function toTxt(sessionData: ExportSessionData): string {
  const lines: string[] = [];
  const metadata = sessionData.metadata;

  lines.push(RULE_HEAVY);
  lines.push('LAL CLI SESSION REPORT — full forensic transcript');
  lines.push(RULE_HEAVY);
  lines.push(`Session:   ${sessionData.sessionId}`);
  lines.push(`Started:   ${sessionData.startTime}`);
  lines.push(
    `Exported:  ${metadata?.exportTime ?? new Date().toISOString()}`,
  );
  if (metadata?.cwd) lines.push(`Cwd:       ${metadata.cwd}`);
  if (metadata?.gitRepo || metadata?.gitBranch) {
    lines.push(
      `Git:       ${metadata?.gitRepo ?? ''}${metadata?.gitBranch ? ` @ ${metadata.gitBranch}` : ''}`,
    );
  }
  if (metadata?.model) lines.push(`Model:     ${metadata.model}`);
  if (metadata?.promptCount !== undefined) {
    lines.push(`Prompts:   ${metadata.promptCount}`);
  }
  const tokenBits: string[] = [];
  if (metadata?.totalTokens !== undefined) {
    tokenBits.push(`total=${metadata.totalTokens}`);
  }
  if (metadata?.contextWindowSize !== undefined) {
    tokenBits.push(`window=${metadata.contextWindowSize}`);
  }
  if (metadata?.contextUsagePercent !== undefined) {
    tokenBits.push(`context-used=${metadata.contextUsagePercent}%`);
  }
  if (tokenBits.length > 0) lines.push(`Tokens:    ${tokenBits.join('  ')}`);
  if (metadata?.filesWritten !== undefined) {
    lines.push(
      `Files:     ${metadata.filesWritten} written (+${metadata.linesAdded ?? 0}/-${metadata.linesRemoved ?? 0} lines)`,
    );
  }
  if (metadata?.uniqueFiles && metadata.uniqueFiles.length > 0) {
    lines.push('Touched:');
    for (const file of metadata.uniqueFiles) {
      lines.push(`  - ${file}`);
    }
  }
  lines.push('');

  if (sessionData.systemPrompt) {
    lines.push(RULE_LIGHT);
    lines.push('SYSTEM PROMPT (as active at export time)');
    lines.push(RULE_LIGHT);
    lines.push(sessionData.systemPrompt.trimEnd());
    lines.push('');
  }

  lines.push(RULE_HEAVY);
  lines.push('TRANSCRIPT');
  lines.push(RULE_HEAVY);

  const failedCalls: string[] = [];
  let toolCallCount = 0;
  let index = 0;
  for (const message of sessionData.messages) {
    index += 1;
    lines.push('');
    if (message.type === 'user') {
      lines.push(header(index, 'USER', message.timestamp));
      lines.push(extractText(message));
    } else if (message.type === 'assistant') {
      const isThinking = message.message?.role === 'thinking';
      const label = isThinking ? 'ASSISTANT — THINKING' : 'ASSISTANT';
      lines.push(header(index, label, message.timestamp, usage(message)));
      lines.push(extractText(message));
    } else if (message.type === 'system') {
      lines.push(header(index, 'SYSTEM MESSAGE', message.timestamp));
      lines.push(extractText(message));
    } else if (message.type === 'tool_call' && message.toolCall) {
      toolCallCount += 1;
      const call = message.toolCall;
      const title =
        typeof call.title === 'string' ? call.title : JSON.stringify(call.title);
      const failed = call.status === 'failed';
      const statusLabel = failed
        ? '!! FAILED !!'
        : call.status.toUpperCase();
      if (failed) failedCalls.push(`#${index} ${title}`);
      lines.push(
        header(
          index,
          `TOOL CALL — ${title} [${statusLabel}]`,
          message.timestamp,
        ),
      );
      if (call.rawInput !== undefined) {
        lines.push('INPUT:');
        lines.push(
          indent(
            typeof call.rawInput === 'string'
              ? call.rawInput
              : safeStringify(call.rawInput),
          ),
        );
      }
      if (call.locations && call.locations.length > 0) {
        lines.push('FILES:');
        for (const loc of call.locations) {
          lines.push(`  - ${loc.path}${loc.line ? `:${loc.line}` : ''}`);
        }
      }
      const outputs = renderToolOutputs(message);
      if (outputs.length > 0) {
        lines.push('OUTPUT:');
        lines.push(indent(outputs.join('\n')));
      } else {
        lines.push('OUTPUT: (none recorded)');
      }
    }
  }

  lines.push('');
  lines.push(RULE_HEAVY);
  lines.push('SUMMARY');
  lines.push(RULE_HEAVY);
  lines.push(`Messages:   ${sessionData.messages.length}`);
  lines.push(`Tool calls: ${toolCallCount} (${failedCalls.length} failed)`);
  if (failedCalls.length > 0) {
    lines.push('Failed tool calls:');
    for (const failure of failedCalls) {
      lines.push(`  - ${failure}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function header(
  index: number,
  label: string,
  timestamp?: string,
  extra?: string,
): string {
  const time = timestamp ? ` @ ${timestamp}` : '';
  const suffix = extra ? `  (${extra})` : '';
  return `[#${index}] ${label}${time}${suffix}\n${RULE_LIGHT}`;
}

function usage(message: ExportMessage): string | undefined {
  const u = message.usageMetadata;
  if (!u) return undefined;
  const bits: string[] = [];
  if (u.promptTokenCount !== undefined) bits.push(`in=${u.promptTokenCount}`);
  if (u.candidatesTokenCount !== undefined) {
    bits.push(`out=${u.candidatesTokenCount}`);
  }
  if (u.thoughtsTokenCount !== undefined) {
    bits.push(`think=${u.thoughtsTokenCount}`);
  }
  if (u.totalTokenCount !== undefined) bits.push(`total=${u.totalTokenCount}`);
  return bits.length > 0 ? `tokens: ${bits.join(' ')}` : undefined;
}

function extractText(message: ExportMessage): string {
  if (!message.message?.parts) return '(empty)';
  const text = message.message.parts
    .map((part) => ('text' in part ? part.text : ''))
    .filter(Boolean)
    .join('\n');
  return text || '(empty)';
}

function renderToolOutputs(message: ExportMessage): string[] {
  const outputs: string[] = [];
  for (const item of message.toolCall?.content ?? []) {
    if (item.type === 'content' && item['content']) {
      const contentData = item['content'] as { type: string; text?: string };
      if (contentData.type === 'text' && contentData.text) {
        outputs.push(contentData.text);
      }
    } else if (item.type === 'diff') {
      outputs.push(`--- diff for ${item['path'] as string} ---`);
      outputs.push((item['newText'] as string) ?? '');
    } else {
      outputs.push(safeStringify(item));
    }
  }
  return outputs;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
