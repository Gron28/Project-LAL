/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Same-session workflow resume via a JSONL journal. Every
 * `agent()` dispatch in a run appends a `started` entry, then (once its
 * side effect returns) an `effect_complete` entry, then a `result` entry,
 * to `<projectDir>/workflows/<runId>/journal.jsonl`. Re-running the
 * workflow with `Workflow({resumeFromRunId})` loads the journal and serves
 * cached results for the longest UNCHANGED PREFIX of `agent()` calls — the
 * first call whose (rolling prefix + prompt + opts) hash diverges, or that
 * has no journaled result, runs live, and every call after it runs live
 * too. The exception is a key whose effect status cannot be trusted as
 * "never ran": either it is known to have completed (`effect_complete` with
 * no matching `result`, the "crashed between effect and result" window), or
 * it is genuinely unknown whether it ran (`effect_unknown`, written when
 * the dispatch itself rejected, or when the `effect_complete` write failed
 * right after the effect resolved — e.g. a dropped backend connection or an
 * ENOSPC on that one append, no crash required). Resume refuses to blindly
 * re-run that dispatch's non-idempotent side effect in either case and
 * surfaces an explicit error instead — see `ambiguousEffects` below and
 * `WorkflowOrchestrator.run`.
 *
 * Key derivation (matches upstream `v2`): each dispatch's key is
 * `v2:sha256(prefixHash ‖ prompt ‖ canonicalOpts)`, where `prefixHash` is
 * the PREVIOUS dispatch's key (rolling chain, empty for the first call).
 * Chaining is what gives "longest unchanged prefix" semantics: editing
 * call #3 changes its key, which changes #4's prefix, which changes #4's
 * key, and so on — so the cache naturally invalidates from the edit point.
 *
 * The `canonicalOpts` projection keeps only the dispatch-affecting opts
 * (`schema`, `model`, `isolation`, `agentType`) with object keys sorted, so
 * cosmetic opt differences (a re-ordered schema, a `label` change) don't
 * bust the cache.
 *
 * Determinism requirement: workflow scripts are deterministic (`Date.now`
 * / `Math.random` throw in the sandbox), so the sequence of `agent()`
 * calls — and therefore the key chain — is stable across runs. That is the
 * precondition that makes prefix-hash caching correct.
 */

import { createHash } from 'node:crypto';
import { read, writeLine } from '../../utils/jsonl-utils.js';
import type { WorkflowAgentOpts } from './workflow-sandbox.js';

/** Journal-format version tag, prefixed onto every key. */
export const JOURNAL_KEY_VERSION = 'v2';

export interface JournalStartedEntry {
  type: 'started';
  key: string;
  agentId: string;
}

/**
 * Written immediately after a dispatch's side effect (`this.dispatch(...)`)
 * resolves, before its `result` entry is persisted. This is the seam
 * ACCEPTANCE.md names as "crash after effect but before result": the old
 * two-entry (`started` / `result`) vocabulary could not represent it — a
 * `started`-without-`result` key was structurally identical whether the
 * effect never ran or ran to completion, so resume always assumed the
 * former and blindly re-executed non-idempotent tool calls.
 *
 * Presence of `effect_complete` for a key with no matching `result` proves
 * the effect (arbitrary write_file/shell calls inside `subagent.execute`)
 * already ran at least once. It does NOT create a bigger backward-compat
 * surface: journals written before this change never contain this entry
 * type, so `buildReplay` simply never populates `ambiguousEffects` for them
 * (see the class doc on `WorkflowJournal` for what that means on resume).
 */
export interface JournalEffectCompleteEntry {
  type: 'effect_complete';
  key: string;
  agentId: string;
}

/**
 * Written when `this.dispatch(...)` itself REJECTS — i.e. there was no
 * chance to write `effect_complete` because the orchestrator never observed
 * a resolution to persist a fact about. This is deliberately NOT the same
 * claim as `effect_complete` (which asserts the effect is KNOWN to have
 * run): a rejected dispatch might have failed before touching the
 * workspace, or it might have failed after an internal side effect (a
 * write_file/shell tool call inside `subagent.execute`) already landed —
 * e.g. a dropped backend connection after a tool call executed but before
 * the model's turn (and hence the dispatch promise) resolved. The
 * orchestrator cannot tell which happened, so it records the honest,
 * weaker claim: "this key's effect status is UNKNOWN, not provably safe to
 * re-run." Resume treats it exactly like `effect_complete` — refuse to
 * blindly re-dispatch — because "unknown" must fail closed the same way
 * "known to have run" does; the only difference is which claim is true.
 *
 * This is also written as a best-effort fallback when an `effect_complete`
 * append itself fails (e.g. ENOSPC) right after the effect resolved: the
 * orchestrator still has a live journal handle at that point and attempts
 * one more write recording the same "unknown" status rather than recording
 * nothing. See `WorkflowOrchestrator.run`'s `countedDispatch` for both call
 * sites and the module doc on `persist` there for what happens when this
 * write ALSO fails (an irreducible loss of durable evidence — the journal
 * medium itself is unwritable, so nothing can be recorded, but the run
 * still fails rather than reporting success).
 */
export interface JournalEffectUnknownEntry {
  type: 'effect_unknown';
  key: string;
  agentId: string;
}

export interface JournalResultEntry {
  type: 'result';
  key: string;
  agentId: string;
  result: unknown;
}

export type JournalEntry =
  | JournalStartedEntry
  | JournalEffectCompleteEntry
  | JournalEffectUnknownEntry
  | JournalResultEntry;

/**
 * Why a key lands in `ambiguousEffects` — surfaced only for honest error
 * messaging (`WorkflowAmbiguousEffectError`); the resume-refusal DECISION
 * itself never branches on this, both reasons are refused identically.
 *   'effect-complete' — the effect is DURABLY KNOWN to have run to
 *                        completion (an `effect_complete` entry landed).
 *   'effect-unknown'  — the dispatch rejected (or the `effect_complete`
 *                        write itself failed) and it is genuinely unknown
 *                        whether the effect ran.
 */
export type AmbiguousEffectReason = 'effect-complete' | 'effect-unknown';

/** Parsed journal: completed results + started-but-maybe-incomplete markers. */
export interface JournalReplay {
  /** key → the completed result entry (last write wins). */
  results: Map<string, JournalResultEntry>;
  /** key → all `started` entries seen (length > 1 ⇒ prior respawns). */
  started: Map<string, JournalStartedEntry[]>;
  /**
   * Keys whose effect status is NOT safe to treat as "never ran" — either
   * because it is durably KNOWN to have run to completion
   * (`effect_complete`, no matching `result`: the "crash after effect but
   * before result" window), or because it is genuinely UNKNOWN whether it
   * ran (`effect_unknown`: the dispatch rejected, or the `effect_complete`
   * write itself failed, before the orchestrator could learn or record
   * which). A key lands here only when a NEWER journal (written by
   * orchestrator code that persists `effect_complete` / `effect_unknown`)
   * recorded one of those entries; older journals can never populate this
   * set, because they never wrote either. Resume must refuse to silently
   * re-dispatch these keys; see `WorkflowOrchestrator.run`'s
   * `countedDispatch`. `ambiguousEffectReasons` (below) carries WHICH of the
   * two claims is true, for error-message honesty only — the refusal
   * decision itself does not branch on it.
   */
  ambiguousEffects: Set<string>;
  /** key → why it is in `ambiguousEffects` (see `AmbiguousEffectReason`). */
  ambiguousEffectReasons: Map<string, AmbiguousEffectReason>;
}

/**
 * Project the dispatch-affecting opts into a stable canonical string. Only
 * `schema` / `model` / `isolation` / `agentType` change what the dispatch
 * does; `label` / `phase` / `stallMs` are cosmetic or operational and must
 * NOT bust the cache. Object keys are sorted recursively so a re-serialized
 * schema with reordered keys hashes the same.
 */
export function canonicalizeAgentOpts(opts: WorkflowAgentOpts): string {
  const projected: Record<string, unknown> = {};
  for (const k of ['schema', 'model', 'isolation', 'agentType'] as const) {
    const v = opts[k];
    if (v === undefined || typeof v === 'function') continue;
    projected[k] = v;
  }
  const sortDeep = (val: unknown): unknown => {
    if (typeof val === 'function') return undefined;
    if (Array.isArray(val)) return val.map(sortDeep);
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(val as Record<string, unknown>).sort()) {
        if (key === '__proto__') continue;
        out[key] = sortDeep((val as Record<string, unknown>)[key]);
      }
      return out;
    }
    return val;
  };
  try {
    return JSON.stringify(sortDeep(projected));
  } catch {
    // A non-serializable opt (shouldn't happen — opts are JSON-revived
    // before crossing the vm boundary) falls back to an empty projection
    // so the dispatch still gets a stable (prompt-only) key.
    return '{}';
  }
}

/**
 * Derive a dispatch's resume key from the rolling prefix hash, the prompt,
 * and the canonical opts. Returns `{key}`; the caller chains by setting the
 * next `prefixHash = key`.
 */
export function deriveAgentKey(
  prefixHash: string,
  prompt: string,
  opts: WorkflowAgentOpts,
): string {
  const hash = createHash('sha256');
  hash.update(prefixHash);
  hash.update('\0');
  hash.update(prompt);
  hash.update('\0');
  hash.update(canonicalizeAgentOpts(opts));
  return `${JOURNAL_KEY_VERSION}:${hash.digest('hex')}`;
}

/**
 * Seed for the resume prefix-hash chain, derived from the run's `args`. Folding
 * `args` into the chain root means a resume with DIFFERENT args produces a
 * disjoint key space: every `agent()` call misses the journal and re-runs live
 * instead of silently replaying the previous run's results. (The tool documents
 * "pass the same args" as a user obligation; this enforces it.)
 */
export function deriveArgsSeed(args: unknown): string {
  const hash = createHash('sha256');
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? null) ?? 'null';
  } catch {
    // `args` is contractually JSON; a non-serializable value (cycle/BigInt)
    // hashes to a stable sentinel so the chain stays deterministic.
    serialized = 'non-serializable-args';
  }
  hash.update(serialized);
  return `${JOURNAL_KEY_VERSION}:${hash.digest('hex')}`;
}

/**
 * Build the replay maps from a flat list of journal entries. `result`
 * entries win last-write; `started` entries accumulate (so a key started
 * N times surfaces N prior attempts for the respawn telemetry). A key with
 * an `effect_complete` OR `effect_unknown` entry and no later `result` lands
 * in `ambiguousEffects` — the effect's outcome was never committed, whether
 * because it definitely ran (`effect_complete`) or because that itself could
 * not be determined (`effect_unknown`) — a `result` entry for the same key,
 * if one follows in the log, resolves the ambiguity either way
 * (reconciliation is exactly "append the real result").
 */
export function buildReplay(entries: JournalEntry[]): JournalReplay {
  const results = new Map<string, JournalResultEntry>();
  const started = new Map<string, JournalStartedEntry[]>();
  const ambiguousEffects = new Set<string>();
  const ambiguousEffectReasons = new Map<string, AmbiguousEffectReason>();
  for (const e of entries) {
    if (e.type === 'result') {
      results.set(e.key, e);
      ambiguousEffects.delete(e.key);
      ambiguousEffectReasons.delete(e.key);
    } else if (e.type === 'started') {
      const list = started.get(e.key);
      if (list) list.push(e);
      else started.set(e.key, [e]);
    } else if (e.type === 'effect_complete') {
      ambiguousEffects.add(e.key);
      ambiguousEffectReasons.set(e.key, 'effect-complete');
    } else if (e.type === 'effect_unknown') {
      ambiguousEffects.add(e.key);
      ambiguousEffectReasons.set(e.key, 'effect-unknown');
    }
  }
  return { results, started, ambiguousEffects, ambiguousEffectReasons };
}

/**
 * Append-only JSONL journal for one workflow run. Reads tolerate a missing
 * file (fresh run). The orchestrator awaits intent and result appends before
 * executing or publishing a dispatch, so recovery evidence is not optional.
 *
 * Backward compatibility: a journal written before `effect_complete` (or,
 * later, `effect_unknown`) existed contains only `started` / `result`
 * entries. `buildReplay` never invents an entry type it didn't see, so such
 * a journal always replays with an empty `ambiguousEffects` set — a
 * `started`-without-`result` key from an old journal is treated exactly as
 * before either change: an ordinary cache miss that the orchestrator safely
 * re-dispatches. This is a real, known limitation, not an oversight: an old
 * journal cannot prove whether its effect ran, or whether that was ever
 * even knowable, because it was never instrumented to say so. Each fix only
 * protects runs recorded by orchestrator code that writes the corresponding
 * entry — i.e. resumes of journals produced from that change onward.
 */
export class WorkflowJournal {
  constructor(readonly path: string) {}

  /** Load + parse all entries into replay maps. Empty maps if no file. */
  async load(): Promise<JournalReplay> {
    const entries = await read<JournalEntry>(this.path, { throwOnNonEnoentError: true });
    return buildReplay(entries);
  }

  /** Append one entry; serialization and I/O failures reject the operation. */
  append(entry: JournalEntry): Promise<void> {
    return writeLine(this.path, entry);
  }
}
