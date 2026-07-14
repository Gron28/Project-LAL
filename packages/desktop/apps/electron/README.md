# LAL Electron App

Electron + React desktop interface for LAL.

The desktop app provides:

- Qwen-backed multi-session chat
- Workspace and source management
- Onboarding for local LAL setup
- Permission modes and plan approval flow
- File previews, diffs, browser panes, and automations

## Development

```bash
bun install
bun run electron:start
```

## Structure

```text
src/main/       Electron main process
src/preload/    Context bridge
src/renderer/   React UI
src/transport/  RPC client/server transport
resources/      Built-in docs and release assets
```
