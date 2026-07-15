# Project-LAL

Project-LAL is a private, local-first AI system for running, training, and using
your own models on hardware you control. **LAL** is its terminal command and
short product name.

The point is ownership: your models, data, tools, projects, and long-running
work remain under your control. The interface should show the real state of the
system—runs, model loading, context, GPU use, storage, and failures—instead of
hiding it behind decorative status.

## Current status

This is an internal early-stage project, not a public release. The immediate
work is reliability: slow inference, failed workflows, orphaned processes,
incomplete telemetry, and fragile session recovery must be fixed before adding
new product surface or publishing the project.

The currently supported working topology is:

```text
Windows laptop: lal in a local project
          │
          │ Tailscale / local network
          ▼
Linux main-pc: Project-LAL web app, models, GPU, runs, training
          │
          └── Phone browser: observe or continue the same server-side session
```

Project-LAL must later be portable enough to run entirely on a Windows machine
when that is the available host. That is a portability requirement, not a
second system being built today.

## Design commitments

- Local ownership and graceful operation without cloud dependencies.
- Tools execute on the computer that owns the project.
- Cross-device sessions are first-class: start on a laptop, inspect or continue
  from a phone, and resume without losing the run.
- Real observability by default; no fake progress or hidden background work.
- Small, maintainable product surface before integrations, SDKs, or marketing.
- Security research is defensive and authorized; Project-LAL does not collect
  user project content or depend on external model-provider telemetry.

## Documentation

- [Architecture](docs/design/project-lal-architecture.md)
- [Reliability-first roadmap](docs/plans/project-lal-foundation-roadmap.md)
- [Single-repository migration plan](docs/plans/project-lal-repository-migration.md)
- [Documentation map](docs/README.md)

## Current local use

On the present Linux host, `./start.sh` rebuilds and starts the web app. It is
an internal launcher for the current machine, not a general installer yet.

The old `lab-agent` client is transitional. The intended client is `lal`; the
recovery client will be retired once the full LAL flow is reliable.
