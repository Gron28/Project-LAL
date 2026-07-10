# Local AI Lab

Local AI Lab is a local-first model workbench. In addition to chat, coding, training, benchmarks, and persistent agent runs, it includes a typed **Hive** runtime for evidence-first research and verified coding workflows.

## Hive runtime

Open `/hive` to start and inspect a workflow. Hive uses deterministic, versioned DAG templates with bounded model-selected work. The coordinator only emits `dispatch`, `retry`, `verify`, `replan`, `finish`, or `request_user`; it has no worker tools.

State is checkpointed in `.data/hive.db` with Node 24's built-in SQLite. Large source snapshots and artifacts are content-addressed under `.data/hive/artifacts/`. The existing detached run manager remains the SSE, cancellation, and approval backbone, so a workflow can be reattached or resumed without repeating completed nodes.

Default budgets are:

- Quick: 2 minutes, no model swaps, shallow verification.
- Standard: 15 minutes, at most two swaps, full verification.
- Deep: 60 minutes, at most four swaps, iterative follow-up or repair.

Core endpoints:

- `GET|POST /api/hive/workflows` — list/start workflows and inspect templates, roles, budgets, and discovered models.
- `GET /api/hive/workflows/:id` — graph, typed node results, evidence, events, and deterministic diagnosis.
- `POST /api/hive/workflows/:id/{pause,stop,resume,replay,approve}` — lifecycle and approval operations.
- `POST /api/hive/workflows/:id/override` — while paused, retry a node or skip a predefined optional node.
- `GET|POST /api/hive/models` — discover or capability-probe a model before role assignment.
- `GET /api/hive/artifacts/:hash` — read a content-addressed artifact.
- `POST /api/hive/evaluation` — evaluate hive or specialist promotion gates.
- `GET|POST /api/hive/provenance` — immutable JSONL manifests, quarantined corrective examples, checkpoint lineage, promotion, and attribution reports.
- `GET /api/hive/self-test` — deterministic routing/schema/isolation regression battery (at least 25 cases).

Model probing checks backend compatibility, structured output, tool calling, context configuration, throughput, and memory metadata. Training examples retain stable IDs, hashes, source/license/generator/parents/role/checks/time and exact dataset membership. Training approval and active-role promotion are separate decisions.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

The UI uses local system fonts, so development and production builds do not depend on a font CDN.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
