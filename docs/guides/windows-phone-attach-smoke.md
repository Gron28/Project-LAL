# Windows and phone attach smoke

Use this only when the Linux host is idle. It creates one short chat run and
unloads its model afterward.

On the Linux host, exercise the durable stream contract used by the phone UI
and `lal /attach`:

```bash
./scripts/smoke-attach-replay.sh
```

For the real Windows check, set the HTTPS Tailscale endpoint and pairing token
in PowerShell, then start the installed `lal` client in any project:

```powershell
$env:LAL_GATEWAY_URL = 'https://<tailnet-host>:8443'
$env:LAL_API_KEY = '<pairing token from ./start.sh --show-cli-token>'
lal
```

In LAL, run `/attach list`, then `/attach <run-id>` (or `/attach` for the
newest live run). Open the same run in the phone web UI. Disconnect one client
briefly, reconnect it, and confirm the event stream resumes without duplicate
text. `/attach stop` only detaches the terminal; it must not stop the host run.
