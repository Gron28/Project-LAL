/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type ResearchTrace = {
  promptId: string;
  enabled: boolean;
  attemptedQueries: Set<string>;
  attemptedSources: Set<string>;
  queries: Set<string>;
  fetchedSources: Set<string>;
  pendingCalls: Map<string, { kind: 'query' | 'source'; value: string }>;
  nudges: number;
  synthesisNudges: number;
  announcedPass: boolean;
};

export const RESEARCH_MIN_QUERIES = 6;
export const RESEARCH_MIN_FETCHED_SOURCES = 4;
export const RESEARCH_MAX_NUDGES = 3;
export const RESEARCH_MAX_SYNTHESIS_NUDGES = 2;
const RESEARCH_FETCH_PROMPT =
  "Extract the page's claims relevant to the current research question. Preserve concrete details, qualifications, and source context for citation.";

export function isExplicitWebResearchRequest(text: string): boolean {
  const asksResearch =
    /\b(deep[- ]research|research|investigate|look up|search (?:the )?web|find (?:reliable|current|recent|primary) sources?)\b/i.test(
      text,
    );
  if (!asksResearch) return false;
  const localOnly =
    /\b(codebase|repository|repo|local files?|this project|workspace)\b/i.test(
      text,
    );
  const explicitlyExternal =
    /\b(web|online|internet|sources?|latest|current|recent|today|news|papers?|documentation)\b/i.test(
      text,
    );
  return !localOnly || explicitlyExternal;
}

export function createResearchTrace(
  promptId: string,
  enabled: boolean,
): ResearchTrace {
  return {
    promptId,
    enabled,
    attemptedQueries: new Set(),
    attemptedSources: new Set(),
    queries: new Set(),
    fetchedSources: new Set(),
    pendingCalls: new Map(),
    nudges: 0,
    synthesisNudges: 0,
    announcedPass: false,
  };
}

export function isResearchSynthesis(text: string): boolean {
  const normalized = text.trim();
  return normalized.length >= 200 && /https?:\/\/[^\s)\]]+/i.test(normalized);
}

export function researchSynthesisContinuation(trace: ResearchTrace): string {
  const coverage = researchCoverage(trace);
  return `Evidence collection is complete: ${coverage.queryCount} successful distinct searches and ${coverage.sourceCount} successfully opened sources. Now write the final evidence-linked synthesis for the user's original request. Include direct source URLs next to the claims they support, distinguish observed facts from inference, and disclose failed calls or unresolved gaps. Do not emit XML/tool-call markup and do not make another tool call unless a genuinely essential evidence gap remains.`;
}

export function recordResearchCall(
  trace: ResearchTrace,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): void {
  if (!trace.enabled) return;
  const query = args['query'];
  const url = args['url'];
  if (name === 'web_search' && typeof query === 'string' && query.trim()) {
    const value = query.trim().toLowerCase();
    trace.attemptedQueries.add(value);
    trace.pendingCalls.set(callId, { kind: 'query', value });
  }
  if (name === 'web_fetch' && typeof url === 'string' && url.trim()) {
    const value = url.trim();
    trace.attemptedSources.add(value);
    trace.pendingCalls.set(callId, { kind: 'source', value });
  }
}

/** Small local models sometimes narrate the correct internet-search intent but
 * emit `tool_search`, whose only purpose is deferred-tool discovery. Route only
 * unmistakable non-discovery queries; explicit tool/capability lookups retain
 * the original behavior. */
export function routeResearchToolCall(
  trace: ResearchTrace,
  name: string,
  args: Record<string, unknown>,
): string {
  if (!trace.enabled) return name;
  const embedded = embeddedResearchCommand(args);
  if (name === 'run_shell_command' && embedded) return embedded.name;
  if (name !== 'tool_search') return name;
  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (!query) return name;
  const explicitToolDiscovery =
    /^select:/i.test(query) ||
    /\b(?:tool|capabilit(?:y|ies)|integration|mcp)\b|web[_ -](?:search|fetch)/i.test(
      query,
    );
  return explicitToolDiscovery ? name : 'web_search';
}

export function routeResearchToolArgs(
  originalName: string,
  routedName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (originalName === 'tool_search' && routedName === 'web_search') {
    return { query: args['query'] };
  }
  if (originalName === 'run_shell_command') {
    const embedded = embeddedResearchCommand(args);
    if (embedded?.name === routedName) {
      return routedName === 'web_search'
        ? { query: embedded.value }
        : { url: embedded.value, prompt: RESEARCH_FETCH_PROMPT };
    }
  }
  if (
    routedName === 'web_fetch' &&
    typeof args['url'] === 'string' &&
    args['url'].trim() &&
    (typeof args['prompt'] !== 'string' || !args['prompt'].trim())
  ) {
    return {
      ...args,
      prompt: RESEARCH_FETCH_PROMPT,
    };
  }
  return args;
}

function embeddedResearchCommand(
  args: Record<string, unknown>,
): { name: 'web_search' | 'web_fetch'; value: string } | null {
  const command = typeof args['command'] === 'string' ? args['command'] : '';
  const match = command.match(
    /^\s*(web_search|web_fetch)\s+(?:"([^"]+)"|'([^']+)'|([^;&|`]+))\s*$/i,
  );
  const value = (match?.[2] ?? match?.[3] ?? match?.[4] ?? '').trim();
  if (match && value) {
    return {
      name: match[1].toLowerCase() as 'web_search' | 'web_fetch',
      value,
    };
  }
  // Some local models serialize a known URL as a read-only curl pipeline even
  // after explicitly deciding to use web_fetch. Accept only curl + optional
  // stderr suppression + head; any other shell syntax retains normal approval.
  const curl = command.match(
    /^\s*curl(?:\s+-[A-Za-z]+)*\s+["']?(https?:\/\/[^"'\s]+)["']?(?:\s+2>\/dev\/null)?(?:\s*\|\s*head\s+-\d+)?\s*$/i,
  );
  return curl?.[1] ? { name: 'web_fetch', value: curl[1] } : null;
}

export function recordResearchResults(
  trace: ResearchTrace,
  parts: ReadonlyArray<unknown>,
): void {
  if (!trace.enabled) return;
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const response = (part as { functionResponse?: unknown }).functionResponse;
    if (!response || typeof response !== 'object') continue;
    const value = response as { id?: unknown; response?: unknown };
    if (typeof value.id !== 'string') continue;
    const pending = trace.pendingCalls.get(value.id);
    if (!pending) continue;
    trace.pendingCalls.delete(value.id);
    const payload = value.response;
    if (!payload || typeof payload !== 'object' || 'error' in payload) continue;
    if (pending.kind === 'query') trace.queries.add(pending.value);
    else trace.fetchedSources.add(pending.value);
  }
}

export function researchCoverage(trace: ResearchTrace) {
  const queryCount = trace.queries.size,
    sourceCount = trace.fetchedSources.size;
  return {
    passed:
      queryCount >= RESEARCH_MIN_QUERIES &&
      sourceCount >= RESEARCH_MIN_FETCHED_SOURCES,
    queryCount,
    sourceCount,
    attemptedQueryCount: trace.attemptedQueries.size,
    attemptedSourceCount: trace.attemptedSources.size,
    missingQueries: Math.max(0, RESEARCH_MIN_QUERIES - queryCount),
    missingSources: Math.max(0, RESEARCH_MIN_FETCHED_SOURCES - sourceCount),
  };
}

export function researchContinuation(trace: ResearchTrace): string {
  const coverage = researchCoverage(trace);
  return `Research coverage gate rejected synthesis: ${coverage.queryCount}/${RESEARCH_MIN_QUERIES} successful distinct searches and ${coverage.sourceCount}/${RESEARCH_MIN_FETCHED_SOURCES} successfully opened sources (${coverage.attemptedQueryCount} searches and ${coverage.attemptedSourceCount} fetches attempted). Continue the same investigation now. IMPORTANT TOOL DISTINCTION: call web_search for every internet query; tool_search only discovers tool names and never searches the internet. Use genuinely different web_search queries for uncovered sub-questions, open the strongest primary/reliable URLs with web_fetch, follow contradictions, and do not repeat a query. Failed calls are not evidence. Do not write the final synthesis until this gate passes.`;
}

export const RESEARCH_CONTROLLER_INSTRUCTION = `[research_controller]
This request requires observable, evidence-backed deep research. First show a decomposition into distinct sub-questions. TOOL NAMES ARE STRICT: use web_search for internet queries and web_fetch to open source URLs. Never pass a web query to tool_search: tool_search only discovers hidden tool names/capabilities and does not search the internet. In this session web_search and web_fetch are already available unless the tool list explicitly says otherwise. Search iteratively, open full sources instead of relying on snippets, and expose each query/fetch through tool calls so progress is visible in real time. The runtime requires at least ${RESEARCH_MIN_QUERIES} successful distinct searches and ${RESEARCH_MIN_FETCHED_SOURCES} successfully opened sources before accepting synthesis. For an efficient pass, finish at least ${RESEARCH_MIN_QUERIES} genuinely different searches across the decomposed sub-questions, then open the strongest ${RESEARCH_MIN_FETCHED_SOURCES} primary/reliable sources; once both thresholds are satisfied, synthesize instead of making redundant calls. Failed calls are not evidence and do not satisfy the coverage gate. The final answer must link claims to fetched sources, distinguish observed/inferred/speculative statements, and list unresolved gaps.
[/research_controller]`;
