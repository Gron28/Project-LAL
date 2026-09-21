# LAL CLI

LAL is Local AI Lab's terminal-native coding and research agent. Run `lal` in
any project on a Tailscale-connected computer: tools execute on that computer
while model inference is served by `main-pc`.

The CLI is the primary working interface. The web app is the testing lab,
advanced settings, model training, and observation surface. Native CLI tasks
and workflows execute beside the project opened in the terminal.

The client is built and distributed by Local AI Lab from its own fork. It
contains Apache-2.0-derived portions of Qwen Code and Gemini CLI; see
`NOTICE-LAL.md` and `LICENSE` for attribution.

Updates are managed by Local AI Lab:

```text
lal update
```

## Useful local workflows

- Run `/research <question>` inside `lal` for evidence-backed external research. The
  controller shows each search and source fetch, rejects failed searches as
  evidence, and keeps working until its minimum source coverage is met or the
  bounded research budget is exhausted.
- Run `/mode` to inspect or change the work mode. Modes retain the context size
  verified for the active local model instead of replacing it with a fixed
  preset value.
- `/hive` now has two paths. `/hive <objective>` runs a sequential native
  coding workflow (inspect → implement → check → repair) in-process via the
  Workflow tool, against the terminal's current, trusted project folder — no
  host round trip. Bare `/hive` (no objective) still opens the legacy dialog
  that talks to the separate **host-side** executor: it asks for an absolute
  project path on that host, uses the existing paired gateway unless
  `LAL_HIVE_URL` explicitly overrides it, and is the only path that can
  list/resume/reattach a mission already in flight or show supervised
  approvals (which still require the web interface). Consolidating these
  paths is the active rework, documented in `docs/design/hive-rework.md`.
- Native `/hive <objective>` requires the Workflow tool, which is
  **experimental and off by default**. Set `QWEN_CODE_ENABLE_WORKFLOWS=1` in
  your environment and restart `lal` to turn it on (`QWEN_CODE_DISABLE_WORKFLOWS=1`
  forces it back off); once enabled, `/workflows` also becomes available to
  show workflow status and history.
- Use `lal --safe-terminal` if a terminal cannot reliably redraw an interactive
  viewport. The default Linux renderer uses an alternate-screen viewport and
  suppresses idle animation and telemetry churn so output cannot accumulate as
  repeated blank or stale lines.
