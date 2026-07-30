/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { evaluateResearchCollection } from '@lal/protocol/agent-runtime';


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
  /** The user asked for research to stop. Nothing may nudge after this. */
  stopRequested: boolean;
};

/**
 * PLAN 4.2 — the quota is gone; these are the floors of an evidence test.
 *
 * The old gate was "6 successful distinct searches and 4 successfully opened
 * sources", and it was wrong in both directions at once. Four pages from the
 * same site satisfied it while being one source's opinion repeated, so it passed
 * work that was not independently evidenced; and a question genuinely settled by
 * two strong primary sources was forced through four more calls, each a full
 * model turn on a box that runs one model at a time. Counting calls measures
 * effort, not evidence.
 *
 * What is actually checkable from a trace, without pretending to judge content:
 *
 * - **breadth** — were distinct sub-questions asked at all (distinct queries).
 * - **independence** — do the opened sources come from different origins. Two
 *   registrable domains is the minimum for "independent evidence"; it is what
 *   makes a single site's claim corroborated rather than repeated.
 * - **marginal return** — has opening more sources stopped adding new origins.
 *   A plateau means further fetching is not reducing uncertainty, which is the
 *   honest answer to "does material uncertainty remain" from the evidence side.
 *
 * Deliberately NOT claimed: that the sub-questions were answered *correctly*.
 * That is a judgement about content, and inventing a number for it would be the
 * "plausible-looking default" PLAN rule 7 forbids.
 */
export const RESEARCH_MIN_QUERIES = 3;
export const RESEARCH_MIN_INDEPENDENT_DOMAINS = 2;
/** Successful fetches in a row that introduced no new origin. */
export const RESEARCH_PLATEAU_FETCHES = 3;
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
    stopRequested: false,
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
  // PLAN 2.5 — "research must not open real Firefox windows; fetch is headless."
  // The computer-use driver opens a REAL window on the operator's desktop and
  // steals focus. Reading a source needs none of that: web_fetch is an HTTP GET
  // plus html-to-text. So a research turn that tries to launch a browser at a URL
  // is redirected to the headless path.
  if (
    (name === 'launch_app' || name === 'page') &&
    typeof args['url'] === 'string' &&
    /^https?:\/\//i.test(args['url'].trim())
  ) {
    return 'web_fetch';
  }
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
  if (
    (originalName === 'launch_app' || originalName === 'page') &&
    routedName === 'web_fetch'
  ) {
    return { url: args['url'], prompt: RESEARCH_FETCH_PROMPT };
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

/**
 * The origin a source belongs to, for independence counting. Deliberately naive
 * — last two labels of the hostname, with `www.` dropped — because the goal is
 * "is this the same site I already read", not correct public-suffix handling. A
 * URL we cannot parse counts as its own origin rather than being silently merged
 * with something else.
 */
export function sourceOrigin(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const labels = host.split('.');
    return labels.length > 2 ? labels.slice(-2).join('.') : host;
  } catch {
    return url.toLowerCase();
  }
}

export function researchCoverage(trace: ResearchTrace) {
  const fetched = [...trace.fetchedSources];
  const shared = evaluateResearchCollection({
    queries: [...trace.queries],
    sources: fetched,
    minQueries: RESEARCH_MIN_QUERIES,
    minOrigins: RESEARCH_MIN_INDEPENDENT_DOMAINS,
    plateauFetches: RESEARCH_PLATEAU_FETCHES,
  });

  return {
    ...shared,
    attemptedQueryCount: trace.attemptedQueries.size,
    attemptedSourceCount: trace.attemptedSources.size,
  };
}

/**
 * Does the synthesis actually cite what was opened?
 *
 * `isResearchSynthesis` only requires *a* URL, which a model can produce from
 * memory — and a fabricated citation is worse than none, because it looks
 * verified. This checks the text against the origins genuinely fetched in this
 * run, which is the one citation fact the runtime holds.
 */
export function synthesisCitesFetchedSources(
  text: string,
  trace: ResearchTrace,
): { ok: boolean; cited: number; available: number } {
  const origins = new Set([...trace.fetchedSources].map(sourceOrigin));
  const lower = text.toLowerCase();
  let cited = 0;
  for (const origin of origins) if (lower.includes(origin)) cited += 1;
  // One cited origin is enough when only one was ever opened; otherwise two, so
  // a corroborated claim shows both of its legs.
  const required = Math.min(2, origins.size);
  return { ok: origins.size === 0 || cited >= required, cited, available: origins.size };
}

/**
 * How many failed attempts, with zero successes, prove the tool is broken rather
 * than the model unlucky. Two is enough: one failure is a bad URL, two in a row
 * with nothing succeeding is infrastructure.
 */
const RESEARCH_BROKEN_PROVIDER_ATTEMPTS = 2;

/**
 * Distinguish "the model has not searched enough yet" from "searching does not
 * work here" (PLAN 4.1, the `Search provider broken` row).
 *
 * The coverage gate counts only SUCCESSFUL calls — "failed calls are not
 * evidence" — so when web_search or web_fetch is broken, coverage stays pinned
 * at zero and the controller spends every remaining nudge, each a full model
 * turn, demanding more of the thing that cannot work. That converts a broken
 * tool into the slowest and most expensive failure the product has, and it is
 * the operator's report of "I would run research, and it could not do it"
 * (2026-07-24).
 *
 * Nudging is only useful when calls are landing. If they are not, stop and say
 * so.
 */
export function researchProviderLooksBroken(trace: ResearchTrace): {
  broken: boolean;
  what: string;
} {
  const queriesFailing =
    trace.queries.size === 0 &&
    trace.attemptedQueries.size >= RESEARCH_BROKEN_PROVIDER_ATTEMPTS;
  const fetchesFailing =
    trace.fetchedSources.size === 0 &&
    trace.attemptedSources.size >= RESEARCH_BROKEN_PROVIDER_ATTEMPTS;
  if (queriesFailing && fetchesFailing) {
    return { broken: true, what: 'web_search and web_fetch are both' };
  }
  if (queriesFailing) return { broken: true, what: 'web_search is' };
  if (fetchesFailing) return { broken: true, what: 'web_fetch is' };
  return { broken: false, what: '' };
}

export function researchBrokenProviderReport(trace: ResearchTrace): string {
  const { what } = researchProviderLooksBroken(trace);
  return (
    `Research stopped: ${what} failing, not merely incomplete. ` +
    `${trace.attemptedQueries.size} search(es) and ${trace.attemptedSources.size} ` +
    `fetch(es) were attempted and ${trace.queries.size} / ${trace.fetchedSources.size} ` +
    `succeeded. Continuing would repeat a call that does not work, so the ` +
    `coverage gate is abandoned rather than enforced.\n\n` +
    `This is an infrastructure problem, not a reasoning one. Report it plainly: ` +
    `say what you could not reach and why, answer from what you already have if ` +
    `that is honest, and label anything unverified as unverified. Do not present ` +
    `an unresearched answer as researched.`
  );
}

/**
 * "Stop" from the user stops it immediately (PLAN 4.2). The observed failure was
 * the controller continuing to force quota after an explicit stop, which is the
 * worst possible time to ignore an instruction: every nudge is another model turn
 * the user has already said they do not want.
 *
 * Matched narrowly. "stop" as a standalone instruction is unambiguous; "stop
 * using the cache" inside a longer request is not, so anything with more than a
 * few words has to look like an explicit halt.
 */
export function isResearchStopRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (!normalized) return false;
  if (/^(stop|halt|cancel|abort|enough|nevermind|never mind|forget it)$/.test(normalized)) {
    return true;
  }
  return /\b(stop|cancel|abort|halt)\b.{0,24}\b(research|researching|search|searching|looking|digging)\b/.test(
    normalized,
  ) || /\b(that'?s enough|no more)\b.{0,24}\b(research|search)/.test(normalized);
}

export function researchStopReport(trace: ResearchTrace): string {
  const coverage = researchCoverage(trace);
  return (
    `Research stopped at the user's request after ${coverage.queryCount} search(es) ` +
    `and ${coverage.sourceCount} source(s) across ${coverage.originCount} independent ` +
    `origin(s). The evidence gate is abandoned, not satisfied.\n\n` +
    `Answer now from what was already gathered. State plainly that research was ` +
    `cut short, cite only what was actually opened, and label everything else as ` +
    `unverified. Do not make another search or fetch call.`
  );
}

/**
 * Does this shell command reach the network to gather evidence?
 *
 * Diagnosed 2026-07-25 from a real session. The model was asked to research
 * peppers and never called `web_search` once. It ran `python3 << 'EOF'` heredocs
 * using `requests.get("https://www.google.com/search?q=...")` — thirteen times —
 * scraped the HTML with regexes, built the deliverable, and reported success.
 *
 * Every consequence followed from that one substitution:
 *
 * - The evidence gate saw zero searches and zero sources, because none of it went
 *   through a tool it can observe. It correctly refused the synthesis — AFTER the
 *   model had already finished and delivered the page, which is what the operator
 *   experienced as "research triggered that the research was not enough even when
 *   the model already finished the whole plan".
 * - `researchProviderLooksBroken` could not save it either: that fires on failed
 *   ATTEMPTS, and there were none to fail.
 * - Trying to comply, the model then ran
 *   `subprocess.run(['web_search', query])` — invoking a typed tool as a shell
 *   binary. That is PLAN 2.1's `'agent' is not recognized as a command`, observed
 *   here on Linux.
 * - Scraping Google's SERP HTML with a regex returns nothing useful anyway, so the
 *   "research" was near-empty and the images were never found.
 *
 * `embeddedResearchCommand` handles the cases that can be REWRITTEN into a proper
 * tool call (`web_search "q"`, a bare curl). This is the residue: network access
 * this module cannot faithfully translate. It is refused rather than guessed at —
 * a python heredoc may do anything, and silently turning it into a fetch would be
 * worse than declining it.
 */
/**
 * Whether a research turn is currently active, readable from the tool scheduler.
 *
 * The scheduler is the only layer that can refuse a call before it executes, and
 * it has no reference to the client's `ResearchTrace`. A process-wide flag is the
 * smallest honest coupling — the alternative is threading a trace through the
 * scheduler's constructor for one boolean.
 */
let researchTurnActive = false;

export function setResearchTurnActive(active: boolean): void {
  researchTurnActive = active;
}

export function isResearchTurnActive(): boolean {
  return researchTurnActive;
}

export function shellReachesNetworkForResearch(
  args: Record<string, unknown>,
): { detected: boolean; what: string } {
  const command = typeof args['command'] === 'string' ? args['command'] : '';
  if (!command) return { detected: false, what: '' };
  const patterns: Array<[RegExp, string]> = [
    [/\brequests\s*\.\s*(?:get|post|Session)\b/, 'python requests'],
    [/\b(?:urllib|urllib2|urllib3|httpx|aiohttp)\b/, 'a python http client'],
    [/\bBeautifulSoup\b|\bbs4\b/, 'BeautifulSoup scraping'],
    [/\bwget\b/, 'wget'],
    [/\bcurl\b/, 'curl'],
    [/\bnode\b[^\n]*\bfetch\s*\(/, 'node fetch'],
    [/\blynx\b|\bw3m\b|\belinks\b/, 'a terminal browser'],
  ];
  for (const [pattern, what] of patterns) {
    if (pattern.test(command)) return { detected: true, what };
  }
  return { detected: false, what: '' };
}

export function shellResearchRefusal(what: string): string {
  return (
    `Refused: this is a research turn, and web access must go through the ` +
    `research tools, not the shell. This command uses ${what}.\n\n` +
    `Use web_search for queries and web_fetch to open a source URL. They are ` +
    `registered tools in this session — call them as tools, do NOT try to run ` +
    `them as shell commands or through subprocess.\n\n` +
    `Two reasons this is not a style preference:\n` +
    `1. Evidence gathered through the shell is invisible to the runtime, so the ` +
    `evidence gate cannot see it and will reject your synthesis no matter how ` +
    `much work you did.\n` +
    `2. Scraping a search engine's HTML returns markup, not results. web_search ` +
    `returns actual results, and web_fetch converts a page to readable text.\n\n` +
    `The shell is still available for everything that is not fetching from the web.`
  );
}

export function researchContinuation(trace: ResearchTrace): string {
  const coverage = researchCoverage(trace);

  // Nothing was ever ATTEMPTED through the observable tools. That is a different
  // situation from "searched too little", and the generic message made it worse:
  // it said "0 of 3 sub-questions have been searched", which a model that had
  // just finished the entire task read as "throw the work away and start over"
  // — observed 2026-07-25, where it abandoned a delivered HTML page and began
  // re-researching. Name the actual problem and protect the deliverable.
  if (coverage.attemptedQueryCount === 0 && coverage.attemptedSourceCount === 0) {
    return (
      `The evidence gate cannot see any research. web_search and web_fetch were ` +
      `never called in this turn, so whatever sources you used are unverifiable ` +
      `from the runtime's side — most likely the web was reached through the ` +
      `shell (curl, python requests) instead of the research tools.

` +
      `KEEP everything you have already produced. Do not restart the task, do not ` +
      `rewrite files that are already correct, and do not re-plan.

` +
      `Do only this: call web_search as a TOOL for the questions your answer ` +
      `already relies on, open the best sources with web_fetch, then correct or ` +
      `confirm the claims you made and cite the URLs. If a claim turns out to be ` +
      `unsupported, fix that specific claim.`
    );
  }

  const missing: string[] = [];
  if (!coverage.breadthMet) {
    missing.push(
      `only ${coverage.queryCount} of ${RESEARCH_MIN_QUERIES} distinct sub-questions have been searched successfully`,
    );
  }
  if (!coverage.independenceMet) {
    missing.push(
      `the ${coverage.sourceCount} source(s) opened come from ${coverage.originCount} independent origin(s), and a claim needs ${RESEARCH_MIN_INDEPENDENT_DOMAINS} to be corroborated rather than repeated${coverage.origins.length ? ` (so far: ${coverage.origins.join(', ')})` : ''}`,
    );
  }
  return `The evidence gate rejected synthesis: ${missing.join('; ')}. ${coverage.attemptedQueryCount} search(es) and ${coverage.attemptedSourceCount} fetch(es) were attempted. Continue the same investigation now. IMPORTANT TOOL DISTINCTION: call web_search for every internet query; tool_search only discovers tool names and never searches the internet. This is not a call quota — opening another page on a site you have already read does not advance it. Search a sub-question you have not covered, and open a source from an origin you have not yet used. Follow contradictions. Failed calls are not evidence. Do not write the final synthesis until this gate passes.`;
}

export const RESEARCH_CONTROLLER_INSTRUCTION = `[research_controller]
This request requires observable, evidence-backed deep research. First show a decomposition into distinct sub-questions. TOOL NAMES ARE STRICT: use web_search for internet queries and web_fetch to open source URLs. Never pass a web query to tool_search: tool_search only discovers hidden tool names/capabilities and does not search the internet. In this session web_search and web_fetch are already available unless the tool list explicitly says otherwise. Search iteratively, open full sources instead of relying on snippets, and expose each query/fetch through tool calls so progress is visible in real time. Before accepting synthesis the runtime checks EVIDENCE, not call count: at least ${RESEARCH_MIN_QUERIES} successful searches of genuinely different sub-questions, and sources from at least ${RESEARCH_MIN_INDEPENDENT_DOMAINS} independent origins, so a claim is corroborated instead of one site repeated. Opening a second page on a site you already read does not advance the gate. Once the evidence is independent, synthesize — there is no quota to fill and redundant calls are waste. If further sources stop adding new origins, say what remains uncertain rather than fetching more. Failed calls are not evidence. If the user says stop, stop immediately and answer from what you have, labelling it as cut short. The final answer must link claims to fetched sources, distinguish observed/inferred/speculative statements, and list unresolved gaps.
[/research_controller]`;
