# LAL CLI

LAL is Local AI Lab's terminal-native coding and research agent. Run `lal` in
any project on a Tailscale-connected computer: tools execute on that computer
while model inference is served by `main-pc`.

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
- Use `lal --safe-terminal` if a terminal cannot reliably redraw an interactive
  viewport. The default Linux renderer uses an alternate-screen viewport and
  suppresses idle animation and telemetry churn so output cannot accumulate as
  repeated blank or stale lines.
