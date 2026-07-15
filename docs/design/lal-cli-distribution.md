# LAL CLI distribution and update channel

> Status: internal bootstrap reference, deferred until the foundation roadmap's
> reliable core workflow is complete. Host-specific `main-pc` addresses are
> current-machine configuration, not a portable product contract.

## Goal

Install `lal` once on another tailnet computer, run it from any local folder, and update the managed client in place without touching project chats or repeating provider setup.

## Split

- `main-pc` owns model inference, GPU scheduling, model discovery, and the client release channel.
- Each client owns its working directory, shell/file/Git tools, trust decisions, and `~/.lal` session history.
- The LAL fork supplies the terminal agent. Its small launcher supplies device identity, authenticated configuration, the Tailscale endpoint, and managed updates.
- Upstream Qwen Code remains credited as the Apache-2.0 foundation; it is not the installed Windows command, product identity, or update channel.

## Install contract

Linux/macOS:

```bash
curl -fsSL https://main-pc.tail3ba909.ts.net:8443/lal/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://main-pc.tail3ba909.ts.net:8443/lal/install.ps1 | iex
```

The bare hostname (443) is reserved for a separate app on this box (the inbox
service); LAL's install/update endpoints live on `:8443` specifically. Every
script here must use the explicit port — see the tailscale-serve drift memory
if this regresses again.

The installer prompts once for the shared prototype pairing token printed by `./start.sh --show-cli-token`. It then:

1. installs the checksum-pinned native LAL standalone runtime if missing or outdated (Windows; the Unix recovery channel is still transitioning);
2. writes the LAL wrapper into the user's PATH;
3. stores the token in `~/.lal/.env` with user-only permissions where available;
4. downloads initial provider settings from the authenticated `main-pc` endpoint;
5. never removes or replaces the chats directory.

## Update contract

`lal update` reruns the idempotent installer from the recorded LAL host. Managed wrappers and release metadata are replaced atomically. The runtime is replaced only when the manifest pins a different runtime version. User settings and sessions are preserved.

The release manifest separates launcher `clientVersion` from `lalRuntimeVersion`. Runtime replacements remain deliberate and checksum-pinned.

## Inference API

- `GET /api/llm/v1/models`
- `POST /api/llm/v1/chat/completions`
- `GET /api/lal/client-settings`
- `POST /api/lal/heartbeat`

All require `Authorization: Bearer <pairing token>`. The token lives in ignored `web/.data/cli-token` and is generated locally. Tailscale limits reachability; the token prevents an unauthenticated LAN caller from consuming GPU time.

The first implementation permits local GGUF models only. Requests are serialized through one global lease because this machine has one 8GB GPU. The gateway loads at least a 32k context for the full agent schema and passes the OpenAI-compatible stream through without moving tool execution to the server.

## Connection security registry

Every installation owns a random persistent device ID plus a locally derived computer name and platform label. Install, launch, model discovery, and inference activity update `web/.data/cli-devices.json`; invalid-token attempts update a separate aggregate counter. `./start.sh --list-cli-devices` reads that main-pc-only file and correlates recorded Tailscale addresses with the live tailnet when available. The registry stores no prompt bodies, working directories, tool arguments, or file contents.

## Compatibility boundary

The default profile is `qwen3-4b-stock` at 32k because the live compatibility test passed there. Larger 8B/9B 32k profiles remain selectable but can be slower or fall back to partial/CPU offload. Ollama vision models are excluded from the first coding-client catalog.

## Native fork releases

`apps/cli/` now builds LAL-branded standalone archives from the maintained
source tree. Windows downloads the `main-pc`-hosted artifact, verifies its
SHA-256 digest, stages it, and swaps it with rollback protection. This changed
neither the `lal` command nor `~/.lal` sessions. Linux/macOS will move to the
same artifact channel after their platform archives are built and verified.
