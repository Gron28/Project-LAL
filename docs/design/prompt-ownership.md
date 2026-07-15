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

The Library → Prompts registry exposes separate editable entries for the Code
agent base instruction, helper-agent instruction, each automatic action /
verification / research-depth intervention, and every Hive role profile. These
are distinct controls: editing one never changes another. An override applies
to the next matching run and can be restored to its managed base individually.

Still to register: deliberate-research templates, training/evaluation prompts,
mode addenda, repair/compression templates, and prompt revision IDs in the run
ledger. They must remain visibly separate rather than becoming one opaque
"system prompt" field.

No prompt is considered product-ready merely because it lives in source code.
