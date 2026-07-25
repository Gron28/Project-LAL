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

## Getting started on any machine

Three commands, identical on Windows, Linux and macOS:

```bash
git clone <this repo> && cd local-ai-lab
npm --prefix web install
npm --prefix apps/cli install
npm run doctor
```

`npm run doctor` is the contract. It reports three separate tiers and the
distinction is the point:

- **REQUIRED** — Node 20+, npm, git, both dependency trees. Nothing runs without
  these, on any platform.
- **OPTIONAL** — ollama, python3, `llama/`, `models/`, bash. Each enables a
  capability; absence degrades, it does not break.
- **LINUX-ONLY** — `systemctl`, the AMD `HSA_OVERRIDE_GFX_VERSION`, tailscale.
  On Windows these print `n/a`, not red. They are specific to the development
  host and **an NVIDIA machine must not copy them.**

Every missed item prints the command that fixes it. Only REQUIRED misses fail
the exit code.

## Two topologies, both supported

**A — Attach to a host (the everyday setup).** The CLI runs on your machine and
uses another machine's GPU. Nothing but Node is needed locally; no models, no
llama.cpp, no Python.

```text
Windows laptop:  lal, in a local project     ── tools run HERE
        │  Tailscale / LAN
Linux main-pc:   web app :8770, models, GPU  ── inference runs HERE
```

**B — Standalone.** Everything on one machine. Needs a model source (ollama, or
a GGUF plus a llama-server build) and enough VRAM. Start the host with:

```bash
npm --prefix web run build && npm --prefix web start     # any platform
bash scripts/rebuild-local-ai-lab.sh                     # Linux, systemd-managed
```

The Linux script exists because this host runs the web app as a `--user` systemd
unit; it builds a candidate, health-checks it, and only then activates it. On
Windows, `npm start` is the whole story — there is no service to install.

## Working across two machines

The repository holds source only. Everything machine-shaped is untracked, so a
clone carries no assumption about the machine that made it:

| Not tracked | Why |
|---|---|
| `models/`, `llama/`, `out/`, `*.gguf` | 34 GB of weights and binaries |
| `web/.data/` | runs, benchmarks, context profiles, usage ledger — local truth |
| `node_modules/`, `.next/` | rebuilt per platform; native deps differ |
| `web/public/lal/releases/` | ~60 MB archives, reproducible on demand |

So the round trip is ordinary git, in both directions:

```bash
git pull --rebase        # take the other machine's work
npm run doctor           # confirm this machine can run it
npm --prefix web install # only when package.json moved
```

Two things to know before pushing from either side:

1. **A push does not update a Windows client.** The connected CLI is a built
   release, so it needs a version bump plus `scripts/release-lal-cli.sh`, then a
   host redeploy. `./update-all.sh` does all of it on Linux.
2. **Hardware settings live in data and environment, never in code.** Serving
   context, GPU layers and quantisation come from `web/.data/context-profiles.json`,
   which is untracked — so this box's 8 GB compromises cannot follow the repo onto
   a machine that does not need them. `HSA_OVERRIDE_GFX_VERSION=10.3.0` is an AMD
   gfx1032 workaround set in the environment, not a project setting.

## What is portable, and what is this card's scar tissue

Answered honestly, because the two look identical in a file listing.

**Portable — the actual product.** The measure → diagnose → train → promote loop.
HTML-001 and the suites. Forensic `/export`. The token ledger and analytics. Tool
dispatch, loop control, the write-resume path, acceptance validation. All of it is
plain Node and TypeScript with no hardware assumptions.

**Scar tissue — exists only because of an RX 6650 XT (gfx1032, 8 GB).**

- `scripts/finetune_hqq.py`: a streaming HQQ loader, chunked cross-entropy and
  CPU-offloaded embeddings, written because bitsandbytes has no RDNA2 kernels and
  8 GB will not hold a normal QLoRA. On a 24 GB NVIDIA card, standard Unsloth or
  Axolotl is strictly better and this file should be ignored.
- One-model-at-a-time serialisation and `LAL_MAX_CONCURRENT_AGENTS=1`. A bound on
  one GPU, not a design principle — raise it on a bigger machine.
- The long-context work (16k → 100k for Gemma 12B) buys headroom this card barely
  has. A machine that fits the model has nothing to reclaim.
- `-b/-ub 512` batch limits in `ensureServing`, added because larger cold prompts
  tripped an amdgpu ring watchdog.

**Not yet portable.** HTML-001 has not met its bar (9 of 10 unattended on
Windows), so the reliability work is measured on Linux and asserted on Windows.

## Current local use on the development host

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
cursor used by phone attach and `lal /attach`. The real-device
procedure for phone/Windows attach lives with the script itself; the separate
guide was removed in the Stage 0 documentation collapse.

The old `lab-agent` client is transitional. The intended client is `lal`; the
recovery client will be retired once the full LAL flow is reliable.
