# LAL reliability consolidation plan

Status: **not started — planning only.** Captured 2026-07-23 from live Windows
testing feedback. Nothing in this doc has been implemented yet; treat it as
the backlog to work from next session, in roughly the priority order below.

Source material: user testing notes pasted directly in-session (the polished
"ADDITIONAL CRITICAL FINDINGS FROM TESTING" list) plus the raw testing notes
saved at `~/Downloads/LAL notes(1).txt` / `LAL notes(1)(1).txt` (identical
content, different save times). The two documents do not overlap 1:1 — both
are preserved below.

## The user's own stated priority

> The main bottleneck is currently not model intelligence. The next
> development phase should freeze unnecessary capability expansion and make
> one ordinary agentic workflow work professionally from beginning to end.
> Give LAL a normal website request, and it must continue until a complete,
> working, validated website exists on disk.

Everything else in this doc serves that one benchmark (`HTML-001`, defined
below). Don't add HIVE features, more agents, bigger context, or fine-tuning
work ahead of this.

## Recommended starting point (discussed, not yet started)

**Tool-dispatch routing bug** — the model correctly calls typed tools
(`web_search`, `web_fetch`, `agent`, `tool_search`) but LAL sometimes sends
them through the raw Windows shell as literal commands instead of native
dispatch, producing `'agent' is not recognized as a command`,
`'tool_search' is not recognized as a command`, and repeated `web_search`
failures. Working hypothesis: this may be the same root cause as raw-notes
item 1 below (research opening real Firefox windows) — if a fetch/search
call falls through to shell execution, a URL argument could be getting
shelled out as `start <url>` on Windows. Fixing dispatch is comparatively
contained (a routing bug, not a redesign) and could resolve several
symptoms — shell errors, wasted retry turns, and possibly the Firefox
popups — with one fix, before touching anything architectural.

Not yet investigated. This is the suggested next session's first move.

## Backlog — polished findings (pasted in-session)

1. **Tool routing is broken** — see above. Need one clear tool registry,
   strict schemas, native dispatch, explicit errors when a tool is
   unavailable — never a raw shell fallback for a typed tool name.
2. **Research workflows must be cancellable and adaptive** — the research
   controller kept forcing fixed search/fetch quotas even after the user
   explicitly said stop. Completion should be evidence-based (were the
   questions answered, is there credible/independent evidence, does
   uncertainty remain) rather than an arbitrary counter (e.g. "exactly six
   searches"). If the search tool repeatedly fails, stop retrying, report
   the infrastructure problem, and let the user choose whether to continue
   without research.
3. **Failure circuit breakers** — after ~2-3 identical failures for the same
   reason, classify the failure and change strategy instead of blind retry
   (search provider broken → stop and report; 403 → try an alternate source;
   truncated write → resume via the artifact writer; missing edit anchor →
   reread and regenerate a revision-aware patch). Repeated failed actions
   should never burn dozens of turns / hundreds of thousands of tokens.
4. **File writing must be transactional and resumable** — currently a
   truncated model response causes the write to be rejected outright,
   forcing a full manual restart in small fragments. Needed instead: begin a
   draft, persist completed chunks as they land, record the last
   successfully-written position, resume from exactly that position after
   an interruption, keep the previous valid file untouched during this, only
   atomically replace the original after the completed draft validates. No
   already-accepted generated code should ever need to be regenerated.
5. **Exact-string editing is too fragile** — anchor-based literal-text edits
   fail on whitespace/content drift, causing accidental removal of unrelated
   controls, duplicate CSS rules, and repeated re-reads just to find a valid
   anchor. Edits should be revision-aware (line ranges, symbols, DOM nodes,
   hashes), and every mutation should verify unrelated content wasn't
   removed, with automatic rollback on a damaging patch.
6. **Context compaction must not erase working state** — after compaction the
   model still remembered enough to continue, but the file-editing system
   forgot the file had already been read. Conversation history and runtime
   working state need to be separate; the following must survive
   compaction: current objective/task, decisions/constraints, current plan
   revision, files already inspected, file revision hashes, active artifact
   drafts, completed tool actions, validation results, and failed actions
   that shouldn't repeat.
7. **Session turn limits shouldn't interrupt real work** — need visible CLI
   controls for max session turns, an unlimited-turn mode, continue-latest
   vs. resume-a-specific-session, remaining turn budget, and a clear reason
   the session stopped (turns / context / cancellation / error). Resuming
   must preserve exact project state without starting a new chat or
   redeploying LAL.
8. **Completion must be decided by acceptance tests, not model confidence** —
   the agent described HTML as "complete and functional" without proving it.
   For website work, LAL should automatically: parse the HTML/JS, open the
   page, inspect browser console errors, confirm required DOM elements
   exist, exercise important controls, capture visual evidence, repair
   defects, and repeat validation. "Done" from the model is a proposal; the
   runtime decides completion.
9. **Reliability benchmark before more capability — `HTML-001`**: "create a
   single-file interactive website." Passes only when: `index.html` exists;
   the full requested implementation is present; HTML/JS parse; the page
   loads without fatal errors; required controls function; the requested
   visualization appears; an interrupted write resumes instead of
   restarting; previously-accepted code isn't regenerated; the agent
   validates the result before claiming completion. Run repeatedly and
   track: completion rate, browser-load rate, functional pass rate, tool
   failures, retry count, tokens consumed, repeated-generation waste, time
   spent on discarded work. Don't scale context/agents/fine-tuning/HIVE
   until this is consistently reliable.
10. **Telemetry**: strip external/vendor telemetry and inherited analytics
    reporting, but keep and improve *local* observability — tool calls and
    failures, model invocations, context/token usage, compaction events,
    file revisions, state transitions, resource usage, research evidence,
    validation results, recovery/resume events. The problem is external
    reporting, not diagnostic visibility — without local observability LAL's
    own failures become unexplainable.
11. **One authoritative execution kernel** — research, subagents, HIVE,
    coding workflows, file ops, and validation currently each maintain their
    own interpretation of state/retries/budgets/completion. Needed: one
    execution kernel owning workflow state, tool dispatch, model scheduling,
    resource leases, events, retry policy, cancellation, compaction
    persistence, recovery, validation, and completion. Models propose
    actions; the kernel controls what actually happens.
12. **Overall reliability consolidation is the current priority** — the
    session showed failures across tool dispatch, research control, file
    transport, editing, state persistence, session continuity, validation,
    and resource scheduling. Freeze capability expansion; get one ordinary
    agentic workflow (a normal website request → complete, working,
    validated site on disk) working professionally end to end before
    anything else.

## Backlog — raw testing notes (`~/Downloads/LAL notes(1).txt`)

1. **Research opens real Firefox windows** — every page the research
   controller searches/fetches pops open in the user's actual Firefox. This
   should not be necessary for the tool to function and needs to stop
   (headless fetch, not a visible browser window). Possibly the same root
   cause as the tool-dispatch shell-routing bug above — worth checking
   together.
2. **Subagents: differentiate "context preservation" from "parallel
   compute"** — the agent spawned subagents and reasoned "while that
   subagent researches, I'll research too," which is good instinct in
   general but wrong for this hardware: the box can run roughly one model
   at a time. On this machine, subagents should be used as a context
   -preservation tool (isolate a sub-task's context so it doesn't bloat the
   main transcript), not as a genuine concurrency mechanism. Don't remove
   the multitasking instinct from the model's reasoning — just make LAL's
   own scheduling reflect the real one-GPU constraint underneath it,
   regardless of what the model believes is happening in parallel.
3. **File writing still gets stopped mid-generation even at 100K context,
   and the partial code is deleted** — duplicate of finding #3/#4 above:
   the user suspects a hidden size/token limiter on a single file's content
   that ignores the other (context-level) limits. Forcing a rewrite from
   scratch burns more context in the end, sometimes to the point the file
   never completes. Needed: let it write freely, and when interrupted,
   preserve the partial code and resume from exactly where it left off
   instead of hiding/discarding it.
   - Note: earlier in this same session, the write_file/edit 8,000-char
     model-authored caps were removed, the toolloop per-round `max_tokens`
     floor was raised 512 → 40,960, and mode `ctx` was raised to 65,536 —
     but this note was written *after* that work, on Windows lal.30, and
     still describes the same symptom. Either the fix hadn't reached that
     client yet, another truncation path exists that wasn't found, or the
     resumable-writer described in finding #4 above (which does not exist
     yet) is the actual missing piece — a raised ceiling only delays the
     wall, it doesn't remove the "discard partial work on hitting it"
     behavior. Needs fresh investigation, not an assumption that the
     earlier fix covers it.
4. **Basic agentic reliability** — blunt version of finding #9/#12 above:
   the model doesn't need to be top-tier, but LAL should reliably get it to
   produce at least a loading HTML file. Define one clear goal and don't
   stop until the tool can accomplish it professionally and reliably.
5. **CLI visual issues**:
   - The scrollable chat region is squeezed to a ~40px strip between the
     header (logo/details/subtitle) and the footer on some screens — not
     enough room to see even one short reply without constant scrolling.
     Needs a leaner header/footer, or the header folding into the scrolling
     chat area itself (keep the logo — reuse it elsewhere if it moves).
   - **Cannot select or copy text in the CLI** — called out as a crucial,
     separate bug from the layout squeeze.
   - The web UI's look doesn't match the CLI's branding at all — needs a
     paint/logo/feel pass to bring it in line.

## Backlog — raw testing notes, "ON STRUCTURE WORK" section

Full repo audit + cleanup pass requested, to run **before** any of the
functional work above, or as a parallel independent track — the user framed
it as similarly important, not lower priority:

- Properly scan and understand the *entire* repo — every folder, every file
  — because "right now it's an absolute mess": a ton of one-off plans,
  random notes, single-use scripts, test scripts.
- Strip the remaining "qwen code cadaver" out of the CLI — this fork started
  as a reference/copy of qwen-code and was never fully de-branded.
- Remove the **Qwen** and **Gemini** names from the system entirely (the
  product may still *run* Qwen models — that's fine — but the code/UI/branding
  itself shouldn't carry those names, credit given separately/elsewhere, not
  baked into the product identity). Left as-is, it reads as a cheap clone
  rather than LAL's own product.
- Strip out "bullshit telemetry" and accumulated cruft layers from
  generations of changes — this overlaps with finding #10 above (keep local
  observability, remove external/vendor telemetry).
- **Before doing any cleanup work**: genuinely study the repo first, then
  report back a good overview of the whole thing — every folder, every file,
  every significant section within files. Goal stated explicitly: by the end,
  the user should understand every single thing present "like the back of my
  hand," and LAL should stop being a black box. Only after that
  understanding is established should cruft be identified and removed.

## Open questions / discrepancy noted to the user

- The polished "ADDITIONAL CRITICAL FINDINGS" text pasted in-session does
  not exist verbatim in either `~/Downloads/LAL notes(1).txt` or
  `LAL notes(1)(1).txt` — both files contain only the rawer, shorter notes
  reproduced under "raw testing notes" above. Flagged to the user in-session;
  unresolved whether the polished version was meant to be saved somewhere
  and wasn't, or only ever existed as pasted chat text.
