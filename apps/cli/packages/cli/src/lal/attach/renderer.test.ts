/**
 * @license
 * Copyright 2025 Local AI Lab
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { KNOWN_EVENT_KINDS } from '@qwen-code/qwen-code-core';
import { RENDERED_KINDS, renderEvent, type RenderContext } from './renderer.js';

describe('renderer dispatch table', () => {
  it('has an explicit handler for every kind protocol.ts knows about', () => {
    const missing = [...KNOWN_EVENT_KINDS].filter(
      (k) => !RENDERED_KINDS.has(k),
    );
    expect(missing).toEqual([]);
  });

  it('renders a completely unrecognized kind as a single dim debug line instead of throwing', () => {
    const ctx: RenderContext = {};
    const result = renderEvent(
      { k: 'some_future_kind_v99', v: { anything: true } },
      42,
      ctx,
    );
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('dim');
    expect(result[0].text).toContain('some_future_kind_v99');
    expect(result[0].text).toContain('not in protocol.ts');
  });

  it('never throws even when a known kind gets a malformed payload', () => {
    const ctx: RenderContext = {};
    // tool_result normally carries {id,name,ok,output} — feed it garbage.
    expect(() =>
      renderEvent({ k: 'tool_result', v: null }, 1, ctx),
    ).not.toThrow();
    expect(() =>
      renderEvent({ k: 'tool_result', v: 'not-an-object' }, 1, ctx),
    ).not.toThrow();
    expect(() =>
      renderEvent({ k: 'usage', v: undefined }, 1, ctx),
    ).not.toThrow();
    expect(() =>
      renderEvent({ k: 'inner', v: { event: 'not-an-object' } }, 1, ctx),
    ).not.toThrow();
  });

  it('renders text/think as appendable content', () => {
    const ctx: RenderContext = {};
    const text = renderEvent({ k: 'text', v: 'hello' }, 1, ctx);
    expect(text).toEqual([
      { severity: 'info', text: 'hello', kind: 'text', append: true },
    ]);
    const think = renderEvent({ k: 'think', v: 'pondering' }, 2, ctx);
    expect(think).toEqual([
      { severity: 'dim', text: 'pondering', kind: 'think', append: true },
    ]);
  });

  it('renders tool_request/tool_progress/tool_result with the ✔/✖ status grammar', () => {
    const ctx: RenderContext = {};
    const req = renderEvent(
      {
        k: 'tool_request',
        v: { id: '1', name: 'write_file', args: { path: 'a.ts' } },
      },
      1,
      ctx,
    );
    expect(req[0].text).toContain('write_file');
    expect(req[0].text).toContain('▶');

    const ok = renderEvent(
      {
        k: 'tool_result',
        v: { id: '1', name: 'write_file', ok: true, output: 'wrote 12 bytes' },
      },
      2,
      ctx,
    );
    expect(ok[0].severity).toBe('success');
    expect(ok[0].text).toContain('✔');

    const fail = renderEvent(
      {
        k: 'tool_result',
        v: { id: '1', name: 'write_file', ok: false, output: 'ENOENT' },
      },
      3,
      ctx,
    );
    expect(fail[0].severity).toBe('error');
    expect(fail[0].text).toContain('✖');
  });

  it('classifies status kinds correctly, including error message passthrough', () => {
    const ctx: RenderContext = {};
    expect(renderEvent({ k: 'status', v: 'done' }, 1, ctx)[0].severity).toBe(
      'success',
    );
    expect(renderEvent({ k: 'status', v: 'stopped' }, 1, ctx)[0].severity).toBe(
      'warning',
    );
    const err = renderEvent({ k: 'status', v: 'error', error: 'boom' }, 1, ctx);
    expect(err[0].severity).toBe('error');
    expect(err[0].text).toContain('boom');
  });

  it('classifies convergence verdicts to matching severities', () => {
    const ctx: RenderContext = {};
    expect(
      renderEvent(
        { k: 'convergence', v: { round: 1, verdict: 'converged' } },
        1,
        ctx,
      )[0].severity,
    ).toBe('success');
    expect(
      renderEvent(
        { k: 'convergence', v: { round: 1, verdict: 'unresolved' } },
        1,
        ctx,
      )[0].severity,
    ).toBe('warning');
    expect(
      renderEvent(
        { k: 'convergence', v: { round: 1, verdict: 'continue' } },
        1,
        ctx,
      )[0].severity,
    ).toBe('info');
  });

  it('recurses into inner events with a phase/role prefix', () => {
    const ctx: RenderContext = {};
    const result = renderEvent(
      {
        k: 'inner',
        v: {
          phase: 'research',
          role: 'skeptic',
          event: { k: 'text', v: 'checking claim' },
        },
      },
      1,
      ctx,
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('inner');
    expect(result[0].text).toBe('[research/skeptic] checking claim');
    expect(result[0].append).toBe(true); // preserved from the inner text handler
  });

  it('warns once on a protocol version mismatch and not again', () => {
    const ctx: RenderContext = { expectedProtocolVersion: 1 };
    const first = renderEvent({ k: 'protocol', v: 2 }, undefined, ctx);
    expect(first[0].severity).toBe('warning');
    const second = renderEvent({ k: 'protocol', v: 2 }, undefined, ctx);
    expect(second).toEqual([]);
  });
});
