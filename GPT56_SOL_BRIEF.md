# GPT-5.6 Sol brief — Local AI Lab cleanup

Date: 2026-07-09.

User goal: use a stronger model to rework the Local AI Lab system. Do not spend a long research pass first. Start from code + current app behavior, then make pragmatic repairs.

Immediate context:

- Local AI Lab repo: `/home/gron/Desktop/local-ai-lab`, Next app in `web/`.
- Existing user/unrelated dirty files exist. Preserve them.
- I patched `web/src/app/api/agent/models/route.ts` to add missing model `PATCH` rename and `DELETE` handlers. The Library UI already had edit/delete controls but the API only had GET/PUT.
- There are existing user changes in:
  - `../start.sh`
  - `web/src/app/api/agent/models/route.ts`
  - `web/src/app/library/page.tsx`
  - workspace deliberation files.

High-value first pass:

1. Run a type/build check for `web/`.
2. Verify `/library` model rename/delete works for local GGUF models and Ollama models.
3. Map the system boundaries: model registry, serving, training, benchmark, agent/code UI, workspace/files, memory, datasets.
4. Produce a small refactor plan before large edits.

Gemma 4 facts to account for later:

- Official Google docs say Gemma 4 supports native `system` role, thinking control tokens, function calling, multimodal input, and 128K/256K contexts depending on model size.
- Recommended sampling in the model card differs from current Lab defaults: `temperature=1.0`, `top_p=0.95`, `top_k=64`.
- The Lab should not assume all Gemma-family models use legacy Gemma 1/2/3 prompt formatting.

External reference requested by user:

- OpenHands is an open-source agent system worth studying for architecture ideas, but do not do a full research survey unless asked.

Related Inbox fix:

- Inbox missed the July 9 morning Baileys batch because the stored board was stale: `builtForDate=2026-07-08` while Spain date was `2026-07-09`; auto-send was ON and Baileys connected.
- I patched `/home/gron/Desktop/inbox/src/lib/outreach-board.ts` so a stale board can be rebuilt before/during the Spain morning window if the nightly 22:00 build was missed.
