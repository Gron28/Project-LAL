// Session → daily → digest pipeline (ReMe-inspired, see docs/agent-memory-research.md
// §6). Three stages, three different triggers, no cron/background process:
//
//   session: every completed /code run, no model call — a cheap markdown projection of
//            the conversation that's already being saved (saveConvo stays canonical).
//   daily:   lazily checked at the start of each /code request for a project, ONE
//            small-model call ONLY if new sessions exist since the last rollup — reuses
//            whichever model is already resident (same zero-swap-cost decision
//            digestReport already made in agent-tools.ts), anchored-merges new session
//            summaries into the existing daily digest rather than regenerating it (the
//            hot/warm/cold research found anchored merging beats full reconstruction).
//   digest:  same anchored-merge mechanic, threshold-triggered, folding old daily files
//            into a durable per-project digest and deleting the consumed daily files so
//            storage doesn't grow unboundedly.
//
// Retrieval (memory_search, in agent-tools.ts) is on-demand only — this corpus is NOT
// auto-injected into every system prompt the way core-memory blocks are; that would
// defeat the point of keeping it as a large retrievable corpus rather than a small
// always-present one.
import fs from "node:fs";
import path from "node:path";
import { appMemoryDir } from "./memory-paths";
import { bm25Search, type Bm25Doc } from "./bm25";

type LoopMsg = { role: string; content: string | null };

const DIGEST_THRESHOLD = 14; // fold into digest.md once more than this many daily files pile up

async function completeOnce(baseUrl: string, model: string, prompt: string, fallback: string): Promise<string> {
  try {
    const r = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, stream: false, temperature: 0, max_tokens: 800,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    return text || fallback;
  } catch {
    return fallback; // merge call failed — keep the existing digest unchanged rather than losing it
  }
}

// ---- session stage: no model call, runs every time ----
export function recordSessionCard(root: string, cid: string, title: string, messages: LoopMsg[]): void {
  const lines: string[] = [`# ${title}`, `session: ${cid}`, `date: ${new Date().toISOString()}`, ""];
  let toolCalls = 0;
  for (const m of messages) {
    if (m.role === "user" && m.content) lines.push(`**User:** ${m.content.slice(0, 300)}`);
    else if (m.role === "assistant" && m.content) lines.push(`**Assistant:** ${m.content.slice(0, 500)}`);
    else if (m.role === "tool") toolCalls++;
  }
  if (toolCalls) lines.push("", `(${toolCalls} tool call(s) made — see the full transcript in conversations/ for detail)`);
  const dir = appMemoryDir("sessions", root);
  fs.writeFileSync(path.join(dir, cid + ".md"), lines.join("\n"));
}

type DailyMeta = { mergedSessionIds: string[] };

function readMeta(p: string): DailyMeta {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return { mergedSessionIds: [] }; }
}

// ---- daily stage: cheap check every request, model call only when actually due ----
export async function maybeRollupDaily(root: string, baseUrl: string, model: string): Promise<void> {
  const sessionsDir = appMemoryDir("sessions", root);
  const todayStr = new Date().toISOString().slice(0, 10);
  const dailyDir = appMemoryDir("daily", root);
  const dailyPath = path.join(dailyDir, todayStr + ".md");
  const metaPath = path.join(dailyDir, todayStr + ".meta.json");
  const meta = readMeta(metaPath);

  let sessionFiles: string[];
  try { sessionFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".md")); } catch { return; }

  // Cheap check first: only sessions actually modified today are candidates, and only
  // ones not already merged. This keeps the common case (nothing new) a handful of
  // stat() calls, not a model call, on the hot path of starting a /code request.
  const newIds: string[] = [];
  for (const f of sessionFiles) {
    const id = f.slice(0, -3);
    if (meta.mergedSessionIds.includes(id)) continue;
    const stat = fs.statSync(path.join(sessionsDir, f));
    if (stat.mtime.toISOString().slice(0, 10) === todayStr) newIds.push(id);
  }
  if (!newIds.length) return; // nothing due — no model call

  const newCards = newIds.map((id) => {
    try { return fs.readFileSync(path.join(sessionsDir, id + ".md"), "utf8"); } catch { return ""; }
  }).filter(Boolean);

  let existingDaily = "";
  try { existingDaily = fs.readFileSync(dailyPath, "utf8"); } catch { /* first rollup of the day */ }

  const prompt = existingDaily
    ? `Here is today's running project digest so far:\n\n${existingDaily}\n\n` +
      `Merge in these ${newCards.length} new session summaries — ADD new information, don't regenerate from scratch, keep anything still relevant from the existing digest:\n\n${newCards.join("\n---\n")}\n\n` +
      `Reply with the complete updated digest (concise, bullet-pointed, what was worked on / decided / learned today).`
    : `Summarize today's work on this project into a concise, bullet-pointed digest (what was worked on / decided / learned) from these session summaries:\n\n${newCards.join("\n---\n")}`;

  const merged = await completeOnce(baseUrl, model, prompt, existingDaily || newCards.join("\n\n"));
  fs.writeFileSync(dailyPath, merged);
  fs.writeFileSync(metaPath, JSON.stringify({ mergedSessionIds: [...meta.mergedSessionIds, ...newIds] }));

  await maybeRollupDigest(root, baseUrl, model);
}

// ---- digest stage: threshold-triggered, folds old daily files into one durable file ----
async function maybeRollupDigest(root: string, baseUrl: string, model: string): Promise<void> {
  const dailyDir = appMemoryDir("daily", root);
  const digestDir = appMemoryDir("digest", root);
  const digestPath = path.join(digestDir, "digest.md");

  let dailyFiles: string[];
  try { dailyFiles = fs.readdirSync(dailyDir).filter((f) => f.endsWith(".md")).sort(); } catch { return; }
  if (dailyFiles.length <= DIGEST_THRESHOLD) return;

  const toFold = dailyFiles.slice(0, dailyFiles.length - DIGEST_THRESHOLD); // fold everything but the most recent DIGEST_THRESHOLD
  const foldContent = toFold.map((f) => {
    try { return `## ${f.slice(0, -3)}\n` + fs.readFileSync(path.join(dailyDir, f), "utf8"); } catch { return ""; }
  }).filter(Boolean);

  let existingDigest = "";
  try { existingDigest = fs.readFileSync(digestPath, "utf8"); } catch { /* first digest */ }

  const prompt = existingDigest
    ? `Here is the durable project digest so far:\n\n${existingDigest}\n\n` +
      `Fold in these ${toFold.length} older daily summaries — merge overlapping points, keep it concise, this is long-term memory not a day-by-day log:\n\n${foldContent.join("\n---\n")}`
    : `Create a durable, concise project digest from these daily summaries (merge overlapping points, this is long-term memory, not a day-by-day log):\n\n${foldContent.join("\n---\n")}`;

  const merged = await completeOnce(baseUrl, model, prompt, existingDigest || foldContent.join("\n\n"));
  fs.writeFileSync(digestPath, merged);
  for (const f of toFold) {
    try { fs.unlinkSync(path.join(dailyDir, f)); fs.unlinkSync(path.join(dailyDir, f.replace(/\.md$/, ".meta.json"))); } catch {}
  }
}

// ---- retrieval: memory_search tool, on-demand only ----
export function searchMemory(root: string, query: string, topK = 5): string {
  const docs: Bm25Doc[] = [];
  for (const kind of ["digest", "daily", "sessions"] as const) {
    const dir = appMemoryDir(kind, root);
    let files: string[];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) {
      try { docs.push({ id: `${kind}/${f}`, text: fs.readFileSync(path.join(dir, f), "utf8") }); } catch {}
    }
  }
  if (!docs.length) return "(no memory recorded yet for this project)";
  const hits = bm25Search(docs, query, topK);
  if (!hits.length) return "(no matching memory found for that query)";
  return hits.map((h) => {
    const doc = docs.find((d) => d.id === h.id)!;
    return `--- ${h.id} ---\n` + doc.text.slice(0, 1500);
  }).join("\n\n");
}
