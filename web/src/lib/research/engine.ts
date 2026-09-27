// Conversational research: the "Wall-E ship computer" loop, pointed at the web.
//
//   understand → images → wave 1 (broad) → narrate each finding → reflect →
//   wave 2 (deeper, from gaps/threads) → … → wrap up → stay listening.
//
// "Sub-agents" are parallel search + read workers (I/O is concurrent and free);
// the single local model does the thinking — batched page reading, narration,
// reflection — because only one model fits the GPU. The user can speak at any
// point: utterances land in the session inbox and are handled between steps,
// ahead of the remaining plan. Everything learned goes into ResearchMemory, which
// is what prevents re-reading repeats and lets findings be connected.
import type { EmitFn } from "@/lib/runs";
import { complete, parseJson, type Msg } from "./llm";
import { searchImages, searchWeb, type SearchHit } from "./search";
import { readPage, type Page } from "./reader";
import { addFacts, hasSeen, markSeen, mindMapDigest, relatedFacts, saveMemory, entityIndex, type Fact, type ResearchMemory } from "./memory";

const MAX_WAVES = 3;
const PAGES_PER_WAVE = 6;
const IDLE_LISTEN_MS = 5 * 60_000;

// ---- per-session inbox: where mid-research utterances go --------------------

type Inbox = { queue: string[]; wake: (() => void) | null; runId: string | null };
const inboxes = new Map<string, Inbox>();
export function sessionInbox(id: string): Inbox {
  let box = inboxes.get(id);
  if (!box) { box = { queue: [], wake: null, runId: null }; inboxes.set(id, box); }
  return box;
}
export function say(id: string, text: string): boolean {
  const box = inboxes.get(id);
  if (!box?.runId) return false;
  box.queue.push(text);
  box.wake?.();
  return true;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const lang = (m: ResearchMemory) => m.language === "es" ? "Spanish" : "English";
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

// ---- the loop --------------------------------------------------------------

/** `runId` is read lazily: startRun() invokes the work function before it returns the run's id. */
export async function runResearch(mem: ResearchMemory, model: string, firstUtterance: string | null, emit: EmitFn, signal: AbortSignal, runId: () => string) {
  const box = sessionInbox(mem.id);
  box.runId = "pending";
  queueMicrotask(() => { if (box.runId === "pending") box.runId = runId(); });
  let turn = 0;
  const persist = () => { try { saveMemory(mem); } catch {} };

  /** Streams one spoken segment. The client speaks sentence by sentence. */
  const narrate = async (messages: Msg[], maxTokens = 320) => {
    turn++;
    emit({ k: "turn", n: turn, role: "assistant" });
    let text = "";
    try {
      text = await complete(model, messages, { maxTokens, temperature: 0.5, signal, onToken: (t) => emit({ k: "text", v: t, turn }) });
    } catch (e) { if (signal.aborted) throw e; }
    text = text.trim();
    // If the token cap still cut the last sentence, tell the client to drop the
    // fragment so the voice never stops mid-word.
    const cut = text.match(/^[\s\S]*[.!?…)"”»](?=\s|$)/)?.[0];
    if (cut && cut.length < text.length) { emit({ k: "phase", v: "trim", turn, keep: cut.length }); text = cut; }
    if (text) mem.transcript.push({ role: "assistant", text, ts: Date.now() });
    persist();
    return text;
  };

  const voice = (extra = "") => `You are LAL, researching the web live for someone over a voice call. Speak in ${lang(mem)}, naturally, as if talking: at most 3 short sentences, no lists, no markdown, no URLs. Name sources casually ("a Britannica article says…"). Never invent facts beyond what you are given. ${extra}`;

  const emitMap = () => emit({ k: "plan_updated", objective: mem.objective, threads: mem.threads, facts: mem.facts.length, sources: mem.sources.filter((s) => s.status === "read").length, entities: entityIndex(mem).slice(0, 12).map((e) => ({ name: e.name, count: e.count })), wave: mem.wave });

  const showImages = async (query: string, limit = 8) => {
    emit({ k: "phase", v: "images", detail: query });
    const hits = await searchImages(query, mem.language, signal, limit);
    const fresh = hits.filter((h) => !mem.images.some((i) => i.src === h.src));
    for (const h of fresh) { mem.images.push({ ...h, query }); emit({ k: "artifact", type: "image", src: h.src, title: h.title, pageUrl: h.pageUrl, query }); }
    persist();
    return fresh.length;
  };

  /** Handle whatever the user said while we were working. Returns extra queries
   * to research when they asked to go deeper somewhere. */
  const handleUser = async (): Promise<string[]> => {
    const extra: string[] = [];
    while (box.queue.length) {
      const text = box.queue.shift()!;
      mem.transcript.push({ role: "user", text, ts: Date.now() });
      emit({ k: "operator_message", text });
      emit({ k: "phase", v: "listening", detail: text });
      const intent = parseJson<{ intent?: string; topic?: string; queries?: string[] }>(await complete(model, [
        { role: "system", content: `Classify what the person said during a live research session about: "${mem.objective}". Return JSON {"intent":"question|images|deeper|stop|chat","topic":"short topic","queries":["up to 3 web search queries if deeper or if the question needs new research"]}. images = they want to see (more) pictures. deeper = they want more research on something. stop = they want to end research.` },
        { role: "user", content: text },
      ], { json: true, maxTokens: 200, temperature: 0, signal }).catch(() => "{}")) ?? {};
      const topic = intent.topic || text;
      if (intent.intent === "stop") { box.queue.length = 0; throw new StopResearch(); }
      if (intent.intent === "images") {
        const n = await showImages(`${topic} ${mem.objective}`.slice(0, 120), 10);
        await narrate([{ role: "system", content: voice("Reply in one short sentence.") }, { role: "user", content: `They asked: "${text}". You just put ${n} new images of "${topic}" on screen. Tell them briefly.` }], 60);
        continue;
      }
      await narrate([
        { role: "system", content: voice("Answer their question directly from what you have learned. If what you know is not enough, say so briefly and say you'll look it up.") },
        { role: "user", content: `What you have learned so far:\n${mindMapDigest(mem)}\n\nThey said: "${text}"` },
      ], 260);
      if ((intent.intent === "deeper" || intent.intent === "question") && intent.queries?.length) {
        extra.push(...intent.queries.slice(0, 3));
        if (intent.intent === "deeper") mem.threads.unshift(topic);
      }
    }
    return extra;
  };

  // ---- 2. waves ---------------------------------------------------------------
  const runWaves = async (start: string[], maxWaves: number) => {
    let queries = start;
    let waves = 0;
    while (!signal.aborted && queries.length && waves < maxWaves) {
      waves++; mem.wave++;
      emit({ k: "phase", v: "searching", wave: mem.wave, detail: `${queries.length} searches` });
      for (const q of queries) { mem.queries.push(q); emit({ k: "query", q, wave: mem.wave }); }
      const results = await mapLimit(queries, 4, (q) => searchWeb(q, mem.language, signal).catch(() => [] as SearchHit[]));
      // Pick unseen pages, at most two per site, interleaving queries so every angle is represented.
      const picked: SearchHit[] = []; const perHost = new Map<string, number>();
      for (let rank = 0; rank < 6 && picked.length < PAGES_PER_WAVE; rank++) for (const list of results) {
        const hit = list[rank]; if (!hit || picked.length >= PAGES_PER_WAVE) continue;
        const host = hostOf(hit.url);
        if (hasSeen(mem, hit.url) || (perHost.get(host) ?? 0) >= 2 || picked.some((p) => p.url === hit.url)) continue;
        perHost.set(host, (perHost.get(host) ?? 0) + 1); picked.push(hit);
      }
      // This wave's searches are spent; the next wave is built from the user's
      // interjections plus the reflection step below.
      queries = await handleUser();
  
      emit({ k: "phase", v: "reading", wave: mem.wave, detail: `${picked.length} pages` });
      const pages = await mapLimit(picked, 4, async (hit) => {
        const page = await readPage(hit.url, signal);
        markSeen(mem, hit.url);
        mem.sources.push({ url: hit.url, title: page?.title || hit.title, status: page ? "read" : "failed", wave: mem.wave });
        emit({ k: "source_classified", url: hit.url, title: page?.title || hit.title, sourceName: page?.sourceName || hostOf(hit.url), status: page ? "read" : "failed", wave: mem.wave, image: page?.image || "" });
        if (page?.image && !mem.images.some((i) => i.src === page.image)) { mem.images.push({ src: page.image, title: page.title, pageUrl: page.url, query: "" }); emit({ k: "artifact", type: "image", src: page.image, title: page.title, pageUrl: page.url }); }
        return page;
      });
      const good = pages.filter((p): p is Page => !!p);
  
      // Read two pages per model call, narrate what is genuinely new.
      for (let i = 0; i < good.length && !signal.aborted; i += 2) {
        const batch = good.slice(i, i + 2);
        emit({ k: "phase", v: "analyzing", wave: mem.wave, detail: batch.map((p) => p.sourceName).join(" · ") });
        const known = mem.facts.slice(-25).map((f) => `- ${f.text}`).join("\n") || "(none)";
        const extracted = parseJson<{ facts?: { text?: string; entities?: string[]; source?: number }[] }>(await complete(model, [
          { role: "system", content: `Extract facts relevant to: "${mem.objective}". Return JSON {"facts":[{"text":"one self-contained factual sentence in ${lang(mem)}","entities":["names of deities, people, places, concepts involved"],"source":1}]}. Up to 5 facts per page, only ones NOT already known. Skip opinions, ads and site navigation.` },
          { role: "user", content: `Already known:\n${known}\n\n${batch.map((p, k) => `[${k + 1}] ${p.title} (${p.sourceName})\n${p.text.slice(0, 3500)}`).join("\n\n")}` },
        ], { json: true, maxTokens: 700, temperature: 0.1, signal }).catch(() => "{}")) ?? {};
        const fresh = addFacts(mem, (extracted.facts ?? []).filter((f) => f.text).map((f) => {
          const p = batch[Math.max(0, Math.min(batch.length - 1, (f.source ?? 1) - 1))];
          return { text: f.text!, entities: f.entities ?? [], sourceUrl: p.url, sourceTitle: p.sourceName || p.title, wave: mem.wave };
        }));
        emitMap();
        if (fresh.length) {
          const related = relatedFacts(mem, fresh);
          await narrate([
            { role: "system", content: voice("Explain the new findings. If they connect to something found earlier, point the connection out.") },
            { role: "user", content: `New findings:\n${fresh.map((f: Fact) => `- ${f.text} (${f.sourceTitle})`).join("\n")}${related.length ? `\n\nEarlier findings they may connect to:\n${related.map((f) => `- ${f.text}`).join("\n")}` : ""}` },
          ]);
        }
        queries.push(...(await handleUser()));
      }
  
      // Reflect: what's missing, what threads are worth pulling — the next wave.
      if (waves < maxWaves && !signal.aborted) {
        emit({ k: "phase", v: "reflecting", wave: mem.wave });
        const r = parseJson<{ threads?: string[]; queries?: string[]; done?: boolean }>(await complete(model, [
          { role: "system", content: `You are planning the next, deeper wave of research on: "${mem.objective}". Look at what is known, find gaps, contradictions and the most interesting threads (connections between entities). Return JSON {"threads":["2-3 threads worth pulling"],"queries":["3-5 specific web searches that go deeper — not repeats of past searches"],"done":false}. done=true only if the objective is thoroughly covered.` },
          { role: "user", content: `Known so far:\n${mindMapDigest(mem, 4000)}\n\nPast searches:\n${mem.queries.slice(-16).join("\n")}` },
        ], { json: true, maxTokens: 400, temperature: 0.3, signal }).catch(() => "{}")) ?? {};
        const past = new Set(mem.queries.map((q) => q.toLowerCase()));
        const next = (r.queries ?? []).filter((q) => q && !past.has(q.toLowerCase())).slice(0, 5);
        if (r.threads?.length) mem.threads = r.threads.slice(0, 3);
        emitMap();
        if (!r.done && next.length) {
          queries = [...queries, ...next];
          await narrate([{ role: "system", content: voice("One or two sentences.") }, { role: "user", content: `In one sentence and without stating any facts, tell them you're going one level deeper next, naming these threads in a few words each: ${mem.threads.map((x) => x.split(/[:—-]/)[0].trim()).join("; ")}.` }], 90);
        }
      }
      persist();
    }
  };

  try {
    // ---- 1. understand the ask ------------------------------------------------
    let queries: string[] = [];
    if (firstUtterance) {
      mem.transcript.push({ role: "user", text: firstUtterance, ts: Date.now() });
      emit({ k: "phase", v: "understanding", detail: firstUtterance });
      // Planning (and a cold model load) can take a while; say something now.
      turn++;
      emit({ k: "turn", n: turn, role: "assistant" });
      emit({ k: "text", v: mem.language === "es" ? "Muy buena pregunta. Déjame pensar cómo investigarlo." : "Great question. Let me work out how to dig into that.", turn });
      const plan = parseJson<{ objective?: string; angles?: { title?: string; queries?: string[] }[]; imageQuery?: string }>(await complete(model, [
        { role: "system", content: `Turn a spoken research request into a research plan. Understand what they really want to learn (not just the literal words). Return JSON only: {"objective":"one precise sentence in ${lang(mem)}","angles":[{"title":"short angle","queries":["2 concrete web search queries"]}],"imageQuery":"a web image search that would show the subject"}. Use 3–4 genuinely different angles (e.g. history, specific examples, symbolism, disagreements). Queries in English unless the topic is local to a Spanish-speaking place.` },
        { role: "user", content: firstUtterance },
      ], { json: true, maxTokens: 500, temperature: 0.2, signal })) ?? {};
      mem.objective = plan.objective?.trim() || firstUtterance;
      mem.threads = (plan.angles ?? []).map((a) => a.title ?? "").filter(Boolean).slice(0, 4);
      queries = (plan.angles ?? []).flatMap((a) => a.queries ?? []).filter(Boolean).slice(0, 8);
      if (!queries.length) queries = [firstUtterance];
      emitMap();
      await Promise.all([
        narrate([{ role: "system", content: voice("One or two sentences only.") }, { role: "user", content: `They asked: "${firstUtterance}". You understood it as: "${mem.objective}". You're about to search these angles: ${mem.threads.join("; ")}. Tell them what you understood and that you're on it.` }], 90),
        showImages(plan.imageQuery || mem.objective),
      ]);
    } else {
      queries = await handleUser();
    }

    await runWaves(queries, MAX_WAVES);

    // ---- 3. wrap up, then keep listening --------------------------------------
    if (!signal.aborted && mem.facts.length) {
      emit({ k: "phase", v: "summarizing" });
      await narrate([
        { role: "system", content: voice("Give a short spoken wrap-up (4–6 sentences) that ties the findings together — patterns and connections, not a list. End by inviting a follow-up.") },
        { role: "user", content: `Question: ${mem.objective}\n\nEverything learned:\n${mindMapDigest(mem)}` },
      ], 320);
    }
    emit({ k: "phase", v: "waiting" });
    let idleUntil = Date.now() + IDLE_LISTEN_MS;
    while (!signal.aborted && Date.now() < idleUntil) {
      if (!box.queue.length) await new Promise<void>((resolve) => { box.wake = resolve; setTimeout(resolve, 5000); signal.addEventListener("abort", () => resolve(), { once: true }); });
      box.wake = null;
      if (!box.queue.length) continue;
      const more = await handleUser();
      // A follow-up that needs new material gets one focused wave, then we go
      // back to listening (the idle clock restarts).
      if (more.length) await runWaves(more, 1);
      emit({ k: "phase", v: "waiting" });
      idleUntil = Date.now() + IDLE_LISTEN_MS;
    }
  } catch (e) {
    if (!(e instanceof StopResearch)) throw e;
    await narrate([{ role: "system", content: voice("One sentence.") }, { role: "user", content: "They asked to stop. Say goodbye briefly and that the session is saved." }], 40).catch(() => "");
  } finally {
    persist();
    if (box.runId === runId() || box.runId === "pending") box.runId = null;
    emit({ k: "done", facts: mem.facts.length, sources: mem.sources.length });
  }
}

class StopResearch extends Error {}
