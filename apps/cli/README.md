# LAL terminal client

This is the terminal client for Project-LAL. Run `lal` inside a project on the
computer that owns that project; file, shell, Git, LSP, and MCP tools execute
locally while the configured Project-LAL host provides inference.

This client is derived from Qwen Code under Apache-2.0. Its retained foundation
is the terminal UI, local tool loop, session recovery, approvals, sandboxing,
MCP/LSP, Git/worktree support, and headless operation. See `NOTICE-LAL.md` and
`LICENSE` for attribution.

The current project is private and reliability-first. Its release/update path is
owned by Project-LAL; the client must not contact upstream provider onboarding,
telemetry, or update channels by default.
