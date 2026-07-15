# Prompt ownership

Status: active foundation requirement. Every prompt that can influence Project-LAL
must have a named owner, source, visibility state, and edit path. Hidden prompt
injection is a defect.

## Terminal LAL

- **Managed base prompt:** `web/public/lal/system.md`; served to enrolled
  terminals as `~/.lal/system.base.md`.
- **Owner override:** `~/.lal/system.local.md`; created on install, never
  overwritten by `lal update`, and appended to the effective
  `~/.lal/system.md` used by the terminal.
- **Tool contract:** the host gateway owns the small allowlist in
  `web/src/app/api/llm/v1/chat/completions/route.ts`. It is deliberately
  enforced server-side so stale client configuration cannot introduce hidden
  tools or their prompt-sized schemas.
- **Project instructions:** `LAL.md`, `AGENTS.md`, and `QWEN.md` in the local
  project, listed visibly in the Code UI and controlled by the project owner.

## Host workflows

The next prompt-registry slice must expose, with source links and editable
overrides, the system prompts used by Chat/Code (`web/src/lib/toolloop.ts` and
its routes), deliberate research (`web/src/lib/deliberate.ts`), Hive role
profiles (already editable in the Hive role UI), training/evaluation, and any
automatic nudge/repair/compression prompt. A run ledger must identify the
prompt revision used, without storing a duplicate secret or project contents.

No prompt is considered product-ready merely because it lives in source code.
