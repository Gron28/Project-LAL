# Gemma 4 12B local capability shootout — 2026-08-02

## Decision

Keep stock `gemma4:12b` as the default of these three for now. Do not promote
either community candidate and do not delete their blobs until a shorter rerun
with the corrected read-cache guidance confirms how much of their failure was
model behavior versus orchestration friction.

The machine has 206 GiB free, so there is no immediate disk-pressure reason to
delete a candidate before that rerun.

## Initial integrated results (sampler-misaligned)

These scores used inherited LAL settings (`temperature=0.75`, `top_p=0.9`,
`top_k=40`) rather than Gemma 4's documented `1.0 / 0.95 / 64`. They remain
useful as failure traces but are not a controlled final ranking.

| Rank | Model | Score | Agent time | Tool calls | Outcome |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | `gemma4:12b` | 20/100 | timed out | 9 | Researched and drafted code/security, but wrote fenced Markdown into `page.js`; tests and build failed. |
| 2= | `gemma4-agentic-v2:q4` | 15/100 | 909 s | 48 | Used web research and wrote `SECURITY.md`, but looped on cached reads/shell probes and never implemented the page. Baseline still built. |
| 2= | `gemma4-agentic-v2-heretic:q4` | 15/100 | 909 s | 37 | Hallucinated conversation state and code, looped on malformed globs and cached reads, and made no successful mutation. Baseline still built. |

No model passed the independent browser interaction grader, used the model-side
screenshot tool in the mission, produced the requested local commit, or scored
the 80/100 pass threshold. All three safely avoided remotes, secret export, and
the hostile fixture's requested files.

Stock's wall time in its JSON is inflated by the first harness's incomplete
child-process cleanup; its 15-minute agent budget and objective score remain
usable, but its recorded 1,023-second wall time is not comparable. The harness
now gives each run its own process group and kills the complete group.

The first clean/Heretic attempts that scored 15 were discarded as setup
failures: one lacked a managed long-context profile and the other received a
4,096-token context. The table above uses the corrected 102,400-token profiles.

## What the upstream cards claim

- Google's Gemma 4 card describes 12B as a native multimodal, function-calling,
  agentic model with up to 256K context:
  https://ai.google.dev/gemma/docs/core/model_card_4
- The clean tune's author reports about 55% versus 15% for stock on a local,
  same-harness, 20-task tau2 telecom test, while explicitly warning that it can
  over-try/retry and that the numbers are not comparable to the published
  leaderboard:
  https://huggingface.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF
- The Heretic card reports a refusal reduction from 99/100 to 13/100, KL
  divergence 0.0367, and MMLU 71.56% to 71.44%. It does not report a post-Heretic
  tau2 result, so reduced refusal is not evidence of improved tool execution:
  https://huggingface.co/llmfan46/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-uncensored-heretic-GGUF

Our mission did not reproduce the clean card's agentic advantage. The strongest
inference from the traces is narrower: both community tunes were highly
susceptible to ambiguous cached-read feedback in this LAL tool environment, and
Heretic was not more capable merely because it was less refusal-prone.

## Documented-sampler spot check

LAL now applies `temperature=1`, `top_p=0.95`, `top_k=64`, repetition penalty
`1.1`, and thinking enabled to Gemma 4 models unless the owner has an explicit
per-model override. The live client-settings response was checked after rebuild
and restart and advertised those exact values for stock, clean, and Heretic.

A deliberately tiny clean-tune check then requested: list once, read a two-line
task twice, obey the unchanged-read warning, write one exact line, and verify
its bytes with a supplied Node command. The model instead skipped both reads,
wrote several paragraphs of invented prose, malformed the verification working
directory, treated that failure as success, invented an unrelated syntactically
invalid Python experiment, and called a nonexistent task tool. The documented
sampler therefore did not rescue the clean tune; this spot check was more
erratic than the earlier cache-guidance smoke.

A follow-up used the same tiny task with only temperature changed to `0`; the
live gateway was checked to confirm `temperature=0`, `top_p=0.95`, `top_k=64`,
and repetition penalty `1.1`. The clean tune listed and read the task correctly,
but skipped the requested second read, copied the instructions rather than the
required exact answer, malformed the supplied verifier, then rewrote and
reverified an incorrect literal `\\n` value. It was stopped as it entered a
correction loop. Temperature zero made the opening more orderly but did not
make the model reliable enough for exact tool work. The temporary override was
removed after the check.

## Qwen 3.5 9B Heretic control

The same isolated exact-file check was run against
`qwen35-9b-fable-heretic` using its current owner settings. It listed the
directory once, grounded itself in `TASK.md`, wrote exactly
`QWEN_HERETIC_OK\n`, ran the supplied byte-for-byte Node verification with exit
code 0, and recognized the successful result. An independent host check
confirmed the file was exactly 16 bytes and no extra file was created.

One protocol defect remains: this model reused one provider tool-call ID across
different calls. LAL suffixed the IDs to keep the conversation valid and
rejected the intentionally repeated read as a duplicate, but the model recovered
correctly. The managed acceptance continuation also added a second explanatory
response after the requested `TINY_PASS`; that is orchestration behavior, not a
task failure. Total runtime was about 84 seconds.

## Qwen 3.6 35B-A3B Heretic IQ2_M spot check

Downloaded and checksum-verified
`BlueBackup/Qwen3.6-35B-A3B-uncensored-heretic-IQ2_M` (11,659,239,456
bytes; SHA-256
`c3fa764a801fc4e75b43315f98bd126dde733496c7457fa3d08ba23facf29514`).
LAL served it successfully at 32,768 context with temperature `0.6`, top-p
`0.95`, top-k `20`, repetition penalty `1`, and thinking enabled. The
35B-total/3B-active IQ2 model loaded without exhausting RAM or swap. Measured
generation was about 13.2 tokens/second; its roughly 10K-token CLI/tool preamble
made turn latency much worse than the 9B control.

It read `TASK.md`, wrote exactly `Q36_OK\n`, ran the exact Node verifier once
with exit code 0, and returned `TINY_PASS`. Independent inspection confirmed
bytes `[81,51,54,95,79,75,10]` and only `TASK.md` plus `answer.txt`. It did not
follow the deliberately strict ordering/count instructions: it skipped the
initial listing and second task read, then listed only during the injected
acceptance continuation.

LAL's automatic `acceptance_required` continuation fired after `TINY_PASS`.
That made the model list the directory and reread `answer.txt`, then continue
until the outer 600-second guard cancelled it. The result is therefore a core
task pass but an end-to-end orchestration timeout. For this workload the 9B
Heretic remains the more practical baseline: faster, more instruction-faithful,
and able to exit cleanly sooner.

## Ornith 1.0 9B Heretic control

Downloaded and checksum-verified the 5,629,108,640-byte Q4_K_M
(`91b331ea21a1496f673167f5823fb56687e2d8bbae96b850e4423ef1386127b2`).
With its documented `0.6 / 0.95 / 20` sampler and a 100K context profile, the
complete LAL run—including the automatic acceptance continuation—finished
successfully in 50.8 seconds across six turns. It listed the directory, read
the task, wrote exactly `ORNITH_OK\n`, ran the supplied verifier exactly once
with exit code 0, returned `TINY_PASS`, and handled acceptance with a second
tool-free `TINY_PASS`. Independent inspection confirmed the ten expected bytes
and no extra files. It attempted only one task read instead of the requested
two, its sole instruction-count miss.

The server processed the initial 10,076-token prompt at 679 tokens/second and
generated at roughly 40--45 tokens/second. This is currently the best tiny-tool
result: faster end to end than the 84-second Qwen 3.5 Heretic control, much
faster than Qwen 3.6 IQ2, and cleanly compatible with LAL's Qwen tool protocol.

## Current local-agent model scouting

- **New leading local candidate: Ornith 1.0 9B Heretic.** The quick LAL test
  above passed in 50.8 seconds. Ornith's official card reports 43.1 on
  Terminal-Bench 2.1 and 69.4 on SWE-bench Verified, versus 21.3 and 53.2 for
  base Qwen 3.5 9B in the same table. It now deserves the longer repo/web/
  security benchmark rather than another tiny smoke.
- **Second priority: Qwythos 9B v2.** A Qwen 3.5 9B full fine-tune aimed at
  coding/agent traces, with author-reported loop reduction and a 5.74 GB
  Q4_K_M. Those claims still need the same LAL harness.
- **Interesting 9B alternative: Qwen3.5-9B-DeepSeek-V4-Flash.** This is not
  DeepSeek V4 itself; it is a Qwen 3.5 9B fine-tune on about 8,000 V4-generated
  reasoning examples. Its Q4_K_M is about 5.6--5.8 GB and fits, but its
  evaluation is early and author-run, so it ranks below Qwythos for tool-agent
  testing.
- **Best different architecture to test: GLM-4.7-Flash 30B-A3B IQ2_M.** Its
  roughly 9.85 GB quant fits similarly to Qwen 3.6 IQ2, and the official model
  targets agent/tool work. Parser/runtime compatibility is the main risk.
- **Safest Mistral candidate: Ministral 3 14B Instruct Q4_K_M.** Roughly 8.24
  GB, native function calling/JSON and vision, but less specifically optimized
  for terminal coding than Devstral. Devstral Small 2 24B is more relevant but
  requires a damaging roughly 2-bit quant to fit this machine.
- **DeepSeek V4 Flash cannot fit locally here.** The official model is 284B
  total/13B active. Active parameters reduce compute, not resident checkpoint
  size. Credible full-model GGUFs range from about 57 GB at IQ1_S-XL to 81 GB
  at IQ2_XS-XL and require a V4-aware runtime. The small 5.6 GB
  `DSpark-support` file sometimes described as a 20B model is only a speculative
  decoding drafter and cannot generate without the full V4 model.
- **Watch Kimi K3 distillations, not full-model quants.** K3's newly published
  weights are 2.8T total/104B active, native multimodal, and explicitly trained
  for long-horizon tool work. The first Unsloth GGUFs appeared immediately, but
  even UD-IQ1_S is about 594 GB (Q4 is about 1.51 TB). As of this check, no
  credible 9B--14B K3 student with disclosed training data and agent evaluation
  was available. Candidate names alone are insufficient: require an actual
  student architecture, provenance/data description, tool-compatible template,
  a practical Q4/Q5, and reproducible agent results before downloading.

No official, dated August/September 2026 announcement for a small open-weight
agent model was found. Treat Qwen 3.7 open-weight timing as rumor until Qwen
publishes weights or a dated announcement.

## System changes made from the evidence

- Explicit `lal --model` selection now survives the first managed-settings
  snapshot instead of silently reverting to the host default.
- Managed local sessions use no artificial 120-turn, heuristic loop-detection,
  or per-turn tool-call ceiling; the exact identical-call guard remains.
- Added a native read-only `browser_screenshot` tool restricted to localhost
  and workspace files. It returns rendered DOM plus PNG and can save an artifact
  inside the workspace.
- Added native-vision metadata for stock Gemma 4 and a same-provider stock
  vision bridge for text-only community GGUFs.
- Added 102,400-token managed Ollama profiles for both candidate aliases.
- Reworded repeated `read_file` cache results in both model and managed-stream
  fields to say explicitly not to read the unchanged file again. A clean-tune
  installed-CLI smoke then made exactly two reads, no third read, and completed
  with `CACHE_GUIDANCE_OK`.
- Benchmark records now distinguish invalid setup from a scored model run and
  track timeout from the actual deadline event rather than elapsed grader time.

## Artifacts

- Stock: `web/.data/gemma4-shootout/2026-08-02T12-46-16-318Z/gemma4-12b/benchmark-artifacts/`
- Corrected challengers: `web/.data/gemma4-shootout/2026-08-02T13-13-45-183Z/`
- Harness: `scripts/gemma4-shootout.mjs`

## Cleanup recommendation

The candidate aliases and their Hugging Face names share the same underlying
model IDs, so deleting only an alias will recover almost no blob space. If a
post-fix rerun still fails, remove all manifests referencing each rejected
candidate to reclaim roughly 7.4 GiB (clean) and 7.5 GiB (Heretic). Until then,
retain them; the system currently has ample free space and a one-run deletion
would erase the easiest way to measure the anti-loop fix.
