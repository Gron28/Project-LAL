/**
 * @license
 * Copyright 2025 Project-LAL
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { WebSearchTool } from './web-search.js';
import { WebFetchTool } from './web-fetch.js';
import { RESEARCH_CONTROLLER_INSTRUCTION } from '../services/research-controller.js';

/**
 * The prompt and the registry must agree about what exists.
 *
 * Root cause of PLAN 2.1's shell fallback, confirmed from two field sessions on
 * 2026-07-25: `web_search` and `web_fetch` were deferred (hidden until
 * `tool_search` revealed them) while the system prompt and the research
 * controller both stated they were already available. The model, told to use a
 * tool it could not see, passed the name to the shell.
 *
 * This is a regression test for an *absence*, which is why it has to be explicit:
 * nothing else fails when a tool quietly becomes invisible. The symptom shows up
 * only as a model that "keeps using the shell wrong".
 */
describe('research tools are visible to the model, not deferred', () => {
  it('web_search is not deferred', () => {
    const tool = new WebSearchTool();
    expect(tool.shouldDefer).toBe(false);
  });

  it('web_fetch is not deferred', () => {
    const tool = new WebFetchTool({
      getProxy: () => undefined,
      getApprovalMode: () => 'default',
    } as never);
    expect(tool.shouldDefer).toBe(false);
  });

  it('the research instruction claims they are available — so they must be', () => {
    // If this sentence is ever reworded, the assertions above are what keep the
    // claim honest.
    expect(RESEARCH_CONTROLLER_INSTRUCTION).toContain(
      'web_search and web_fetch are already available',
    );
    expect(new WebSearchTool().shouldDefer).toBe(false);
    expect(
      new WebFetchTool({
        getProxy: () => undefined,
        getApprovalMode: () => 'default',
      } as never).shouldDefer,
    ).toBe(false);
  });
});
