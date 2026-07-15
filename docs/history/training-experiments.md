# Training experiment history

Status: retained lessons, not an active training plan. Last updated: 2026-07-14.

Project-LAL began with experiments in local model training, including an early
fractal-oriented direction that did not produce a useful result. Later work
created instruction, coding, research, planning, and Hive-specialist datasets
and ran LoRA/QLoRA/HQQ experiments on constrained local hardware.

## What the experiments established

- Small local fine-tunes can run on the available hardware and can produce
  adapters, datasets, manifests, benchmark records, and model artifacts.
- The current training datasets did not yield a significant practical capability
  improvement worth treating as a product model.
- Hive's early evaluation established a useful workflow/evaluation harness, but
  did not show that the specialist/multi-agent approach reliably beats a capable
  single model on task completion.
- Reliability problems in serving, process lifecycle, storage, and telemetry
  currently matter more than another training campaign.

## Decision

Do not preserve bulky generated datasets, model outputs, scratch applications,
or failed candidate artifacts in the working repository merely as historical
evidence. Keep this short record, the small reproducible fixtures needed for
tests, compiler source, and any future result that passes a clearly defined
evaluation gate.

Training returns to the roadmap only after the core host/client workflow is
stable, storage retention is bounded, and an evaluation can demonstrate a
meaningful improvement rather than a successful-looking run.
