# Managed CLI autonomy and context

LAL's managed CLI profile should not impose arbitrary run-length limits on top
of the selected model and local runtime. Managed sessions therefore use the
CLI's unlimited values for session turns and per-turn tool calls, and skip the
broad headless loop heuristics. The exact consecutive-identical-call guard
remains active because repeating the same call with the same arguments cannot
make progress and may trigger a provider-side rejection.

The policy is reconciled into existing paired clients while they are running,
not only written during first installation. CLI workflow modes keep their
prompt, reasoning, and sampling behavior but no longer replace the unlimited
session policy with mode-specific 8–120 turn ceilings. The provider
next-speaker recursion fuse remains finite at 1,000 to contain malformed
responses that request continuation forever; it is not a session limit.

Context optimization should probe every supported hardware tier through 256K.
The probe remains explicit and disruptive, verifies real inference at each
tier, retains the last passing profile, and falls back when a larger allocation
fails. This exposes the native 262,144-token window already recorded for the
Qwen 3.5 and Ministral models without claiming that every machine can run it.
An already-verified model resumes above its verified tier instead of retesting
smaller nominal tiers at the saved context floor. The highest passing tier is
persisted as the model setting, and a failed higher probe restores the last
working runtime before returning.

Legacy `-lal-cli-16k` Ollama profiles are internal runtime aliases, just like
the current context-agnostic `-lal-cli-ctx` profile, and are excluded from the
public model picker during migration.

## Completion and runtime reliability

The headless acceptance continuation is tied to the last workspace mutation,
not merely to whether the run ever entered an acceptance turn. A successful
mechanical verifier after that mutation (tests, type checking, linting, build,
validation scripts, `git diff --check`, or a browser screenshot) satisfies the
gate. This prevents the CLI from asking the model to repeat work it already
verified, while an edit followed only by inspection still receives one focused
acceptance continuation.

Managed clients use a 10-minute foreground-shell default instead of the
upstream two-minute default. An explicit per-command timeout still wins, and
the cap remains finite so an accidental foreground server cannot live forever.
Shell results also report the concrete working directory; the old `(root)`
label was repeatedly mistaken for filesystem `/` by local models.

The managed llama.cpp server uses one inference slot on this single-stream
host at every context size. llama.cpp otherwise defaults to four slots, which
multiplies KV-cache allocation and can make an otherwise viable model fail or
run with substantially less useful context.
