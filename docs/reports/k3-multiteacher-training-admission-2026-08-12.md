# K3 multi-teacher corpus — training admission review (2026-08-12)

## Verdict

**Rejected for Project-LAL training or promotion.** This is an evidence-backed
governance decision, not a judgement of the corpus's technical quality. Do not
download its Parquet training shards into LAL or train an adapter from them
until the two blocking conditions below are cleared.

## Reviewed release

- Repository: `r0b0tlab/qwen3.8-max-glm5.2-kimi-k3-distillation`
- Pinned revision: `7a3473446840bcc397928cd8183d4b3ba3ca13a7`
- Metadata observed 2026-08-12: public, ungated, `license: other`, 882,041,782
  bytes.
- API metadata describes 57,937 traces: 48,283 Qwen3.8-Max, 5,307 GLM-5.2,
  and 4,347 Kimi Code K3. It exposes `sft_k3_only`, `sft_tools`,
  `sft_reasoning`, and related configurations.

## Admission blockers

1. **Rights are not cleared for this project.** The bundled `LICENSE` permits
   only controlled, noncommercial research pending review of upstream rights
   and teacher-service terms. It expressly says that presence of a row does not
   grant downstream rights, and it prohibits commercial product/service
   training without authorization from every relevant rights holder and service
   provider. Project-LAL is software intended for an ongoing product workflow;
   its commercial status and the required permissions have not been established.

2. **Pinned provenance is internally inconsistent.** The current API metadata
   says 57,937 rows and includes K3-only material. At the same pinned revision,
   `PROVENANCE.md`, `QUALITY.md`, and `metadata/QUALIFICATION.json` identify a
   prior `qwen3.8-max-glm5.2-distillation-51389` release with 51,389 rows
   (46,082 Qwen-derived + 5,307 GLM-derived) and no K3 component. Those records
   cannot prove the lineage, split boundaries, or per-row terms of the advertised
   K3 extension.

3. **Its own validation/test splits are not evaluation evidence.** The release
   says that they include benchmark-derived material (including GSM8K,
   HumanEval, MBPP, ARC, MATH, and IFEval) and are contaminated for capability
   claims. LAL must retain its independent, private/date-bounded held-outs.

## What would reopen admission

The corpus may enter a small, isolated research pilot only after all of these
are supplied and checked:

1. A corrected, signed/pinned K3 release manifest whose row counts, shard
   hashes, dataset card, provenance, and qualification report agree.
2. Per-row source license and teacher-output/service-term clearance for the
   intended LAL use, plus required attributions. A permissive package label by
   itself is insufficient.
3. A frozen allow-list of only rights-cleared records, with source revision,
   row IDs, hashes, and exclusions captured in a LAL dataset manifest.
4. A fresh LAL-only evaluation set that is demonstrably disjoint from source
   items and benchmark families. The corpus's validation and test splits must
   not be used as promotion evidence.

## Safe pilot design once admitted

- Start with a Qwen-format, assistant-only-loss LoRA on a small stratified
  subset. Keep the stock base model and every existing LAL held-out suite
  untouched.
- Train `tools` and `reasoning` subsets separately; do not let generic
  reasoning traces overwrite tool-call behavior without a measured comparison.
- Promote only if the candidate meets the existing coding, agentic, planning,
  capability, and HTML-001 gates and has no rights/provenance exception.

## Evidence reviewed

- Hugging Face dataset API metadata at the pinned revision.
- `LICENSE`, `PROVENANCE.md`, `QUALITY.md`, `SCHEMA.md`, and
  `metadata/QUALIFICATION.json` fetched from that same revision.
