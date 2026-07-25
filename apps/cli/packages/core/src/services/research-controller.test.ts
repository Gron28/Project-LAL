/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createResearchTrace,
  isExplicitWebResearchRequest,
  isResearchSynthesis,
  recordResearchCall,
  recordResearchResults,
  researchContinuation,
  researchCoverage,
  researchProviderLooksBroken,
  researchBrokenProviderReport,
  researchSynthesisContinuation,
  routeResearchToolArgs,
  routeResearchToolCall,
  RESEARCH_CONTROLLER_INSTRUCTION,
  RESEARCH_MAX_SYNTHESIS_NUDGES,
  isResearchStopRequest,
  researchStopReport,
  sourceOrigin,
  synthesisCitesFetchedSources,
} from './research-controller.js';

describe('research controller', () => {
  it('requires a substantive synthesis with a direct evidence link', () => {
    expect(isResearchSynthesis('Done.')).toBe(false);
    expect(isResearchSynthesis('x'.repeat(250))).toBe(false);
    expect(
      isResearchSynthesis(
        `${'SQLite transaction evidence and qualifications. '.repeat(6)} https://sqlite.org/isolation.html`,
      ),
    ).toBe(true);
    expect(RESEARCH_MAX_SYNTHESIS_NUDGES).toBeGreaterThan(0);
  });

  it('requests synthesis without encouraging redundant tool calls', () => {
    const trace = createResearchTrace('p', true);
    for (let i = 0; i < 6; i++) trace.queries.add(`query ${i}`);
    for (let i = 0; i < 4; i++) trace.fetchedSources.add(`https://source/${i}`);
    const continuation = researchSynthesisContinuation(trace);
    expect(continuation).toContain('Evidence collection is complete');
    expect(continuation).toContain('direct source URLs');
    expect(continuation).toContain('do not make another tool call');
  });

  it('detects external research without hijacking local repository research', () => {
    expect(
      isExplicitWebResearchRequest(
        'Deep research the latest local LLM context techniques',
      ),
    ).toBe(true);
    expect(
      isExplicitWebResearchRequest(
        'Research this repository for the parser implementation',
      ),
    ).toBe(false);
    expect(
      isExplicitWebResearchRequest(
        'Research current upstream documentation for this repo',
      ),
    ).toBe(true);
  });

  it('requires diverse searches and opened sources', () => {
    const trace = createResearchTrace('p', true);
    const successfulParts: unknown[] = [];
    for (let index = 0; index < 6; index++) {
      const id = `search-${index}`;
      recordResearchCall(trace, id, 'web_search', { query: `angle ${index}` });
      successfulParts.push({
        functionResponse: { id, response: { output: 'results' } },
      });
    }
    for (let index = 0; index < 4; index++) {
      const id = `fetch-${index}`;
      recordResearchCall(trace, id, 'web_fetch', {
        url: `https://source${index}.example/report`,
      });
      successfulParts.push({
        functionResponse: { id, response: { output: 'source' } },
      });
    }
    recordResearchResults(trace, successfulParts);
    recordResearchCall(trace, 'duplicate', 'web_search', { query: 'angle 0' });
    expect(researchCoverage(trace)).toMatchObject({
      passed: true,
      queryCount: 6,
      sourceCount: 4,
    });
  });

  it('does not count failed search or fetch attempts as evidence', () => {
    const trace = createResearchTrace('p', true);
    recordResearchCall(trace, 'search', 'web_search', {
      query: 'failed query',
    });
    recordResearchCall(trace, 'fetch', 'web_fetch', {
      url: 'https://source.example/report',
    });
    recordResearchResults(trace, [
      { functionResponse: { id: 'search', response: { error: 'offline' } } },
      { functionResponse: { id: 'fetch', response: { error: 'denied' } } },
    ]);
    expect(researchCoverage(trace)).toMatchObject({
      passed: false,
      queryCount: 0,
      sourceCount: 0,
      attemptedQueryCount: 1,
      attemptedSourceCount: 1,
    });
  });

  it('produces an observable continuation when coverage is shallow', () => {
    const trace = createResearchTrace('p', true);
    expect(researchContinuation(trace)).toContain(
      'only 0 of 3 distinct sub-questions',
    );
    // The message must not read as a quota — that framing is what produced
    // four fetches of the same site (PLAN 4.2).
    expect(researchContinuation(trace)).toContain('This is not a call quota');
    expect(researchContinuation(trace)).toContain(
      'tool_search only discovers tool names',
    );
    expect(RESEARCH_CONTROLLER_INSTRUCTION).toContain(
      'Never pass a web query to tool_search',
    );
  });

  it('routes mistaken internet tool discovery calls to web search', () => {
    const trace = createResearchTrace('p', true);
    expect(
      routeResearchToolCall(trace, 'tool_search', {
        query: 'SQLite transaction modes',
      }),
    ).toBe('web_search');
    expect(
      routeResearchToolCall(trace, 'tool_search', {
        query: 'select:web_fetch',
      }),
    ).toBe('tool_search');
    expect(
      routeResearchToolCall(trace, 'tool_search', {
        query: 'web fetch tool capability',
      }),
    ).toBe('tool_search');
    expect(
      routeResearchToolArgs('tool_search', 'web_search', {
        query: 'SQLite transaction modes',
        max_results: 5,
      }),
    ).toEqual({ query: 'SQLite transaction modes' });
  });

  it('unwraps model-emitted web commands instead of requesting shell access', () => {
    const trace = createResearchTrace('p', true);
    const searchArgs = {
      command:
        'web_search "SQLite transaction isolation levels official documentation"',
      timeout: 30_000,
    };
    expect(routeResearchToolCall(trace, 'run_shell_command', searchArgs)).toBe(
      'web_search',
    );
    expect(
      routeResearchToolArgs('run_shell_command', 'web_search', searchArgs),
    ).toEqual({
      query: 'SQLite transaction isolation levels official documentation',
    });
    const unsafe = { command: 'web_search "SQLite"; touch /tmp/nope' };
    expect(routeResearchToolCall(trace, 'run_shell_command', unsafe)).toBe(
      'run_shell_command',
    );
    const curlArgs = {
      command:
        'curl -sL "https://sqlite.org/lang_transaction.html" 2>/dev/null | head -1000',
    };
    expect(routeResearchToolCall(trace, 'run_shell_command', curlArgs)).toBe(
      'web_fetch',
    );
    expect(
      routeResearchToolArgs('run_shell_command', 'web_fetch', curlArgs),
    ).toMatchObject({
      url: 'https://sqlite.org/lang_transaction.html',
      prompt: expect.stringMatching(/current research question/i),
    });
  });

  it('supplies the extraction prompt required by a bare source fetch', () => {
    const routed = routeResearchToolArgs('web_fetch', 'web_fetch', {
      url: 'https://sqlite.org/isolation.html',
    });
    expect(routed).toMatchObject({
      url: 'https://sqlite.org/isolation.html',
    });
    expect(routed['prompt']).toMatch(/current research question/i);
  });
});

describe('researchProviderLooksBroken', () => {
  // PLAN 4.1 "Search provider broken → stop, report infrastructure problem".
  // The coverage gate counts only successful calls, so a broken web_search
  // pinned coverage at zero and the controller spent every remaining nudge —
  // each a full model turn — demanding more of a tool that cannot work.
  const trace = (over: {
    attemptedQueries?: string[];
    attemptedSources?: string[];
    queries?: string[];
  } = {}) => {
    const t = createResearchTrace('p', true);
    for (const q of over.attemptedQueries ?? []) t.attemptedQueries.add(q);
    for (const u of over.attemptedSources ?? []) t.attemptedSources.add(u);
    for (const q of over.queries ?? []) t.queries.add(q);
    return t;
  };

  it('is not broken before enough attempts have failed', () => {
    expect(
      researchProviderLooksBroken(
        trace({ attemptedQueries: ['a'] }),
      ).broken,
    ).toBe(false);
  });

  it('is not broken while some calls are succeeding', () => {
    expect(
      researchProviderLooksBroken(
        trace({ attemptedQueries: ['a', 'b', 'c'], queries: ['a'] }),
      ).broken,
    ).toBe(false);
  });

  it('reports web_search broken when every search fails', () => {
    const result = researchProviderLooksBroken(
      trace({ attemptedQueries: ['a', 'b'] }),
    );
    expect(result.broken).toBe(true);
    expect(result.what).toContain('web_search');
  });

  it('reports both broken when searches and fetches all fail', () => {
    const result = researchProviderLooksBroken(
      trace({ attemptedQueries: ['a', 'b'], attemptedSources: ['u1', 'u2'] }),
    );
    expect(result.broken).toBe(true);
    expect(result.what).toContain('web_search and web_fetch');
  });

  it('names the failure as infrastructure, not reasoning', () => {
    const report = researchBrokenProviderReport(
      trace({ attemptedQueries: ['a', 'b'] }),
    );
    expect(report).toContain('infrastructure problem');
    expect(report).toContain('unverified');
  });
});

/**
 * PLAN 4.2 — evidence, not quota.
 *
 * Helper writes a successful call pair straight into the trace so each case
 * states only the evidence it is about.
 */
function succeed(
  trace: ReturnType<typeof createResearchTrace>,
  { queries = [], sources = [] }: { queries?: string[]; sources?: string[] },
) {
  queries.forEach((q, i) => {
    recordResearchCall(trace, `q${i}`, 'web_search', { query: q });
    recordResearchResults(trace, [
      { functionResponse: { id: `q${i}`, response: { ok: true } } },
    ]);
  });
  sources.forEach((url, i) => {
    recordResearchCall(trace, `s${i}`, 'web_fetch', { url });
    recordResearchResults(trace, [
      { functionResponse: { id: `s${i}`, response: { ok: true } } },
    ]);
  });
}

describe('research evidence gate (PLAN 4.2)', () => {
  const threeQueries = ['alpha', 'beta', 'gamma'];

  it('passes on independent evidence with far fewer calls than the old quota', () => {
    const trace = createResearchTrace('p', true);
    succeed(trace, {
      queries: threeQueries,
      sources: ['https://a.example.com/x', 'https://docs.other.org/y'],
    });
    const coverage = researchCoverage(trace);
    expect(coverage.passed).toBe(true);
    expect(coverage.originCount).toBe(2);
    // The old gate demanded 6 searches and 4 sources for this same evidence.
    expect(coverage.sourceCount).toBe(2);
  });

  it('rejects four sources that are all the same site — the old gate passed this', () => {
    const trace = createResearchTrace('p', true);
    succeed(trace, {
      queries: threeQueries,
      sources: [
        'https://example.com/a',
        'https://www.example.com/b',
        'https://blog.example.com/c',
        'https://example.com/d',
      ],
    });
    const coverage = researchCoverage(trace);
    expect(coverage.sourceCount).toBe(4);
    expect(coverage.originCount).toBe(1);
    expect(coverage.independenceMet).toBe(false);
    // ...but it does pass, via the plateau: three consecutive fetches added no
    // new origin, so demanding more is spending turns for nothing.
    expect(coverage.plateaued).toBe(true);
    expect(coverage.passed).toBe(true);
    expect(coverage.reason).toBe('plateau');
  });

  it('does not treat one site with two pages as either independent or plateaued', () => {
    const trace = createResearchTrace('p', true);
    succeed(trace, {
      queries: threeQueries,
      sources: ['https://example.com/a', 'https://example.com/b'],
    });
    const coverage = researchCoverage(trace);
    expect(coverage.passed).toBe(false);
    expect(coverage.redundantTail).toBe(1);
  });

  it('never plateaus at zero evidence — that is a broken provider, not a plateau', () => {
    const trace = createResearchTrace('p', true);
    succeed(trace, { queries: threeQueries });
    expect(researchCoverage(trace).plateaued).toBe(false);
    expect(researchCoverage(trace).passed).toBe(false);
  });

  it('counts subdomains as one origin and unparseable urls as their own', () => {
    expect(sourceOrigin('https://www.example.com/a')).toBe('example.com');
    expect(sourceOrigin('https://docs.example.com/b')).toBe('example.com');
    expect(sourceOrigin('https://example.co/b')).toBe('example.co');
    expect(sourceOrigin('not a url')).toBe('not a url');
  });

  it('requires the synthesis to cite origins that were actually opened', () => {
    const trace = createResearchTrace('p', true);
    succeed(trace, {
      queries: threeQueries,
      sources: ['https://a.example.com/x', 'https://docs.other.org/y'],
    });
    // A plausible URL the model produced from memory is not a citation.
    expect(
      synthesisCitesFetchedSources('See https://wikipedia.org/foo', trace).ok,
    ).toBe(false);
    expect(
      synthesisCitesFetchedSources(
        'Per https://a.example.com/x and https://docs.other.org/y ...',
        trace,
      ).ok,
    ).toBe(true);
  });

  it('imposes no citation requirement when nothing was ever fetched', () => {
    const trace = createResearchTrace('p', true);
    expect(synthesisCitesFetchedSources('anything', trace).ok).toBe(true);
  });
});

describe('research stop request (PLAN 4.2)', () => {
  it('recognises a bare stop', () => {
    for (const text of ['stop', 'Stop.', 'halt', 'cancel', 'enough', 'nevermind']) {
      expect(isResearchStopRequest(text)).toBe(true);
    }
  });

  it('recognises an explicit stop aimed at the research', () => {
    expect(isResearchStopRequest('stop researching this')).toBe(true);
    expect(isResearchStopRequest("that's enough research")).toBe(true);
    expect(isResearchStopRequest('cancel the search please')).toBe(true);
  });

  it('does not fire on ordinary requests that merely contain the word', () => {
    expect(isResearchStopRequest('stop using the cache when you read files')).toBe(false);
    expect(isResearchStopRequest('research the best way to stop a docker container')).toBe(false);
    expect(isResearchStopRequest('')).toBe(false);
  });

  it('reports what was gathered and forbids further calls', () => {
    const trace = createResearchTrace('p', true);
    succeed(trace, { queries: ['alpha'], sources: ['https://a.example.com/x'] });
    const report = researchStopReport(trace);
    expect(report).toContain("user's request");
    expect(report).toContain('abandoned, not satisfied');
    expect(report).toContain('Do not make another search or fetch call');
  });
});
