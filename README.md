# Project-LAL

Project-LAL is a private, local-first AI system for running, training, and using
your own models on hardware you control. **LAL** is its terminal command and
short product name.

The point is ownership: your models, data, tools, projects, and long-running
work remain under your control. The interface should show the real state of the
system—runs, model loading, context, GPU use, storage, and failures—instead of
hiding it behind decorative status.

## What this is, and what it is not

Researched against the field on 2026-07-25 rather than asserted.

The local-LLM landscape is almost entirely **inference frontends**. Ollama is a model
server whose API is the product. LM Studio is a polished desktop GUI with a Hugging
Face browser. Open WebUI is a ChatGPT-style web UI that runs no models of its own.
AnythingLLM is RAG workspaces plus an agent. Jan is an offline desktop chat. The
recommended "serious local AI stack" is literally Ollama + Open WebUI + LM Studio —
three tools composed to do one thing: talk to a model.

Fine-tuning lives in a separate world (Unsloth, Axolotl, QLoRA recipes). You train in
one place, serve in another, and nothing carries a measured verdict between them.

**Project-LAL is not a better chat window, and should not be judged as one.** LM Studio
is more polished, Open WebUI has more integrations, and neither is the point.

What is actually different here is that the loop is closed on one machine:

    use  ->  measure  ->  diagnose  ->  train  ->  benchmark  ->  promote or roll back

- **Measure.** HTML-001 and the suites are gates, not dashboards. The working rule is
  that a fix without a before/after number is not done, and it has repeatedly
  overturned changes that felt right — including a token-loop "fix" that measured
  509s/1.55M tokens against 110s/130k and was reverted.
- **Diagnose.** Runs are recorded as event logs with autopsies and model report cards,
  and `/export` produces a full forensic transcript. That transcript is not a nicety:
  it is what root-caused a UTF-8 BOM reaching an HTTP header and silently killing every
  web search on Windows, a failure invisible from the server side.
- **Train.** `scripts/finetune_hqq.py` exists because bitsandbytes has no RDNA2
  kernels. Confirmed again on 2026-07-25: `pip install unsloth` resolves to the CUDA
  stack — 5.5 GB of `nvidia-*` wheels on an AMD box — so the mainstream toolchain does
  not run here at all.
- **Promote.** Trained candidates are accepted or rejected on measured suites, and the
  rejections are the evidence the gate works: victory7 regressed 5 of 7 suites and was
  rolled back; victory9 tied 5, won 1, lost 2, and was not promoted.

The hardware is the other half of the difference. This runs on an **RX 6650 XT
(gfx1032, 8 GB)** where the ecosystem assumes NVIDIA. Every capability figure here is
measured on that card with a desktop session running, not extrapolated — e.g. Gemma
12B at 102,400 context: 8.3 GB resident, 23%/77% CPU/GPU, 11.4 tok/s generation and
~336 tok/s prefill.

### Where it is genuinely weaker

- HTML-001 does not yet pass its bar (9 of 10 unattended on Windows). Until it does,
  reliability claims are aspirations.
- 3,173 of 3,491 tracked files are an inherited CLI fork; only ~1,200 lines are
  provably dead, so reduction is product surgery, not cleanup.
- There is no RAG story. AnythingLLM does that properly and this does not.
- One GPU means one model at a time; concurrency is serialised no matter what the
  scheduler believes.

### Who it is for

Someone who wants to *improve* a local model against their own tasks, on hardware the
ecosystem ignores, with measurements they can audit — not someone who wants the
smoothest way to chat with a downloaded model. For the latter, use LM Studio.

Sources consulted: [iunera top-20 local LLM tools
2026](https://www.iunera.com/kraken/enterprise-ai/top-20-tools-to-run-llms-locally-in-2026-ollama-anythingllm-open-webui-lm-studio-vllm-and-every-real-alternative-compared/),
[gudz.ai Ollama vs LM Studio vs Open WebUI](https://gudz.ai/posts/local-ai-llm-tools-2026),
[ModelPiper platform comparison](https://modelpiper.com/blog/local-ai-platforms-compared-mac),
[SitePoint fine-tuning local LLMs 2026](https://www.sitepoint.com/fine-tune-local-llms-2026/),
[Daily Dose of DS fine-tuning in 2026](https://blog.dailydoseofds.com/p/how-to-fine-tune-llms-in-2026).

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

Two documents, and only two:

- [**The plan**](docs/PLAN.md) — the only plan. Stages, exit gates, and what is
  deliberately frozen. If work is not in here, it is not committed work.
- [**Architecture**](docs/ARCHITECTURE.md) — what exists today: the request
  spine, every directory's purpose, host assumptions, porting notes, and the
  operational runbook.

`CHANGELOG.md` is the append-only engineering log.

## Current local use

### Complete update

`./update-all.sh` is the one command for bringing an already provisioned host
fully up to date. It builds the CLI and web app, deploys/restarts the local
service, refreshes the installed `lal` command and settings, publishes the
connected-client release, and refreshes the standard Tailscale URL for phone
access when Tailscale is connected:

```bash
./update-all.sh
```

The intended result is a running and current system, rather than a collection
of separate scripts an operator has to discover and execute. Any future change
that requires a build, install, migration, service action, deployment, or
external-route refresh must be added to `update-all.sh` before it is treated as
complete. One-time machine provisioning remains explicitly documented rather
than being silently assumed.

On the present Linux host, `./start.sh` rebuilds and starts the web app. It is
an internal launcher for the current machine, not a general installer yet.
On a fresh Linux setup, run `./scripts/install-project-lal-service.sh` once
before using the launcher; it installs the tracked `project-lal.service` user
unit and refuses to switch while LAL-owned work is active.

From the repository root, the supported checks are intentionally few:

```text
npm run test          # web, protocol, and Windows-release contracts
npm run smoke          # guarded real-model host smoke; idle host only
npm run smoke:attach   # durable attach/replay contract
npm run smoke:terminal # terminal-run host lifecycle bridge; idle host only
```

The terminal client remains its own npm workspace under `apps/cli/` while its
inherited dependency graph is reduced. `npm run cli:test` runs its test suite;
`npm run release:lal` creates the internal Windows release archive.

On the Linux host, run `./start.sh --install-cli` once to make `lal` use the
current source client. `lab-agent` remains available only as an explicitly
named recovery client; it is not the `lal` command.

With the host already running and idle, `./scripts/smoke-project-lal.sh` runs a
guarded one-line model/run/replay/cleanup check. It refuses to interrupt live
work and is intentionally not part of the ordinary static test suite.

`./scripts/smoke-attach-replay.sh` checks the durable stream replay and resume
cursor used by phone attach and `lal /attach`. See the
[Windows/phone attach guide](docs/guides/windows-phone-attach-smoke.md) for the
real-device smoke procedure.

The old `lab-agent` client is transitional. The intended client is `lal`; the
recovery client will be retired once the full LAL flow is reliable.
