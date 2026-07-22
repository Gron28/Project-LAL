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
  researchSynthesisContinuation,
  routeResearchToolArgs,
  routeResearchToolCall,
  RESEARCH_CONTROLLER_INSTRUCTION,
  RESEARCH_MAX_SYNTHESIS_NUDGES,
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
      '0/6 successful distinct searches',
    );
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
