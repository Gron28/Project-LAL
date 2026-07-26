# Running Project LAL on Windows

Project LAL was originally built for Linux. This compatibility layer adds a
native Windows path without changing the existing Linux runtime.

## Quick start

1. Double-click `start-local-windows.cmd`.
2. Open <http://127.0.0.1:8771>.
3. Use the CLI opened by the launcher.

## What was needed

| Area | Windows behavior |
|------|------------------|
| Isolation | CLI state is stored under `.local-windows/cli-home`. |
| Web host | Binds only to `127.0.0.1:8771`. |
| Ollama | Binds only to `127.0.0.1:11434`. |
| Models | Uses `%USERPROFILE%\.ollama\models` when available. |
| Runtime | Ollama models use the native Windows Ollama server. |
| Context | New Windows models start with a conservative 8,192-token context. |
| Hardware | CPU and RAM use cross-platform Node.js APIs. |
| CLI | Uses isolated state and authenticates with the local gateway token. |
| Model features | Thinking mode is enabled only when Ollama reports support for it. |

## Linux remains unchanged

Windows compatibility is additive:

- Linux keeps its existing llama.cpp/Vulkan routing.
- Linux keeps its existing managed Gemma context profile.
- Windows-specific runtime choices are guarded by `process.platform === "win32"`.

Models and the selected default remain in the user's local Ollama and web data
directories; they are not committed to the repository. CPU inference is
supported, although larger models respond more slowly without a dedicated GPU.

## Startup behavior

`start-local-windows.cmd` starts the local web host, Ollama, and CLI when needed.

If the same isolated LAL host is already running, the launcher verifies that it
is bound to loopback and reuses it instead of starting a duplicate.

## Clear failure messages

The Windows path now distinguishes these conditions:

- Ollama is not installed.
- Ollama is installed but not responding.
- Port `8771` belongs to an unknown process.
- The isolated CLI runtime is missing.
- A model does not support thinking mode.

## Known limitations

- Windows GPU telemetry is not implemented yet.
- Ollama models are the supported Windows model path.
- Linux GGUF/llama.cpp and training workflows have not been ported to native
  Windows.
- CPU-only responses from larger models can take noticeably longer.

## Verification

Run the Windows launcher checks:

```powershell
python -m unittest tests.test_lal_local_windows_launcher -v
```

Check the web TypeScript code:

```powershell
cd web
npm exec tsc -- --noEmit
```

Finally, confirm the web interface loads at <http://127.0.0.1:8771> and that the
CLI can send a prompt through one of the installed Ollama models.
