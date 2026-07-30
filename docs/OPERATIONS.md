# Project-LAL operations

## Owner-data backup and restore

Create a dated, private backup:

```sh
npm run backup:owner -- /path/to/private/backup-destination
```

The backup includes `web/.data`, training/evaluation data, and model manifests.
Large reproducible model weights are intentionally excluded and are listed in
the generated manifest. Backup directories are mode `0700`; copied files,
including tokens or secrets inside owner data, are mode `0600`.

Verify a restore into an empty temporary directory:

```sh
node scripts/backup-owner-data.mjs --restore /path/to/project-lal-owner-DATE --to /tmp/lal-restore-drill
```

Every file is hash-checked before and after copying. Keep backups on
owner-controlled encrypted storage and apply the destination's normal snapshot
retention policy.

## Health checks

`npm run health:daily` probes the web host and system-information API, checks
disk headroom, and parses owner JSON state without loading a model.

`npm run health:weekly` first checks for live runs and jobs. It skips the deeper
repository smoke while work is active; otherwise it runs the release test gate.

Systemd timer templates live under `deploy/systemd/`. Failures are visible in
the bounded system journal:

```sh
journalctl --user -u project-lal-health.service
journalctl --user -u project-lal-weekly.service
```

## Runtime logs

`out/llama-server.log` rotates at 5 MiB with three retained copies. Rotation
uses copy-truncate so a resident model process keeps writing to the active log.

## Service shutdown

The user unit calls the local `DELETE /api/sysinfo` owner endpoint before
signalling the Next.js process. This removes any resident managed model while
the owner is still reachable; failure of that best-effort request does not
prevent systemd from stopping or recovering the web process. The control group
remains the final containment boundary, with a 30-second stop timeout.

## Hive data integrity and retention

`npm run hive:data:check` is the safe dry-run. It checks SQLite integrity and
foreign references, event-sequence uniqueness, artifact hashes and sizes, then
lists expired unreferenced artifacts and old token streams that could be
compacted. Active or recoverable workflows and workflows pinned by evaluation
trajectories are protected.

`npm run hive:data:apply` moves eligible artifacts into
`web/.data/hive/.trash/<timestamp>/` and removes only their unreferenced catalog
rows. The trash directory is intentionally recoverable and should be removed
only after a verified owner-data backup. Existing token streams are reported but
not rewritten; new Hive text is already stored in bounded chunks.
