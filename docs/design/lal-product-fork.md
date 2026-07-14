# LAL product fork

## Decision

LAL is the product and command presented to users. Qwen Code is an
Apache-2.0-derived implementation foundation, acknowledged in the license and
source history, but its binary, update channel, command name, banner, help text,
and product prompts are not shipped as the LAL client.

## First release boundary

- Build the client from this `lal-cli` fork.
- Present `lal` and `LAL` in command help, the TUI, notifications, attribution,
  and agent identity.
- Store user state in `~/.lal` through the existing isolated runtime-home
  mechanism.
- Disable the inherited upstream update checker; `lal update` is the only
  managed update path.
- Host the compiled LAL bundle and checksum on `main-pc`.
- Reuse the pinned standalone private Node runtime and native dependencies for
  the first release. They are plumbing, not the invoked application: the LAL
  wrapper launches the fork's bundle directly.
- Preserve upstream copyright/license notices and add a clear derivation notice.

## Update contract

The distribution manifest versions the LAL bundle independently from the
private runtime. Server-only changes need no client update. A new LAL bundle
increments `clientVersion`; a Node/native dependency change increments
`runtimeVersion`. Existing settings, credentials, stable device identity, and
project chats are never removed.

## Follow-on product work

LAL modes, Hive, deliberate research, effort controls, and the browser-backed
voice bridge are implemented in this fork after the product/distribution boundary
is real. They are not simulated by renaming upstream menu entries.
