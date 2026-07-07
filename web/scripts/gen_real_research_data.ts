// Real-internet-grounded research tool-use traces (unlike gen_research_data.py's
// synthetic fictional entities). Every search_fetch row here is built from an ACTUAL
// web_search + web_fetch call against the live internet (the exact same functions the
// agent uses at inference: lab.ts's webSearch, agent-tools.ts's webFetch) — real
// results, real fetched article text. A local teacher model (whatever's currently
// being served — point it at the strongest one, e.g. victory6-8b, before running this)
// writes the final cited answer FROM ONLY the fetched content, so facts are grounded in
// something real rather than invented, the same "verified" discipline the project's
// other data generators use (distill_gemma.py's checkable-constraints pattern, applied
// here via real source text instead of a grader function).
//
//   1. curl -X PUT localhost:8770/api/agent/models -d '{"model":"victory6-8b"}'
//      (or whichever model should teach — warm it up with one throwaway chat first)
//   2. npx tsx scripts/gen_real_research_data.ts --n 100 --out ../data/research_real_sft.jsonl
//
// Sequential (DuckDuckGo rate-limits bursts) — budget ~15-25s/row.
import fs from "node:fs";
import path from "node:path";
import { webSearch } from "../src/lib/lab";
import { webFetch } from "../src/lib/agent-tools";

const TOOLS = [
  { type: "function", function: {
    name: "web_search", description: "Search the web (DuckDuckGo). Returns the top results with titles, snippets and URLs — snippets are for judging which result is worth opening, NOT a substitute for reading it. If a result's snippet looks relevant to the question, call web_fetch on its URL before answering; only answer from snippets alone for trivial results (e.g. confirming a name/spelling) where the specific fact you need isn't in question.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: {
    name: "web_fetch", description: "Fetch a URL and return its readable text content (HTML stripped, capped). Use this on any web_search result whose snippet matches what you're trying to answer — this is how you confirm a fact rather than guess from a one-line snippet.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
];

const QUESTIONS: string[] = [
  // science
  "What is the half-life of carbon-14?",
  "How does CRISPR gene editing actually work?",
  "What causes the aurora borealis?",
  "Why is the sky blue during the day and red at sunset?",
  "What is the current scientific consensus on why we dream?",
  "How do mRNA vaccines work?",
  "What is dark matter and how do we know it exists?",
  "How hot is the core of the sun?",
  "What is the Chandrasekhar limit?",
  "How does photosynthesis convert sunlight into chemical energy?",
  "What is CRISPR-Cas9 used for besides gene editing?",
  "What causes a solar eclipse to be total versus partial?",
  "How do octopuses change color?",
  "What is the Kardashev scale?",
  "How does the human immune system remember past infections?",
  // technology / AI
  "What is retrieval-augmented generation and why was it introduced?",
  "How does the transformer attention mechanism work?",
  "What is quantum supremacy and has it been demonstrated?",
  "How does a solid-state drive differ from a hard disk drive technically?",
  "What is the difference between TCP and UDP?",
  "How does blockchain consensus work in proof-of-stake systems?",
  "What is homomorphic encryption used for?",
  "How does a neural network's backpropagation algorithm work?",
  "What is the difference between a CPU and a GPU architecturally?",
  "How does DNS resolution work when you type a URL into a browser?",
  "What is the CAP theorem in distributed systems?",
  "How do large language models handle context windows technically?",
  "What is federated learning and why is it used?",
  "How does public-key cryptography enable secure communication?",
  "What is the difference between IPv4 and IPv6?",
  // history
  "What caused the fall of the Roman Empire?",
  "What were the main causes of World War I?",
  "How did the printing press change European society?",
  "What was the Silk Road and what did it connect?",
  "What caused the collapse of the Bronze Age civilizations?",
  "How did the Black Death change medieval European economics?",
  "What was the significance of the Rosetta Stone's discovery?",
  "What caused the French Revolution?",
  "How did the Manhattan Project develop the atomic bomb?",
  "What was the Berlin Airlift and why did it happen?",
  // geography / earth science
  "Why does the Dead Sea have such high salinity?",
  "What causes the Amazon rainforest to produce so much oxygen?",
  "How do coral reefs form?",
  "Why is Mount Everest still growing?",
  "What causes monsoon seasons in South Asia?",
  "How deep is the Mariana Trench?",
  "What causes the Sahara desert to be so dry?",
  "Why does Iceland have so much geothermal activity?",
  // business / economics
  "What caused the 2008 financial crisis?",
  "How does quantitative easing work?",
  "What is the difference between a Roth IRA and a traditional IRA?",
  "How do stock buybacks affect share price?",
  "What is the difference between inflation and stagflation?",
  "How does the Federal Reserve set interest rates?",
  // space
  "How do astronomers detect exoplanets?",
  "What is the Fermi paradox?",
  "How does the James Webb Space Telescope differ from Hubble?",
  "What would happen if you fell into a black hole?",
  "How do rockets achieve orbital velocity?",
  "What causes tides on Earth?",
  "How was the first black hole ever photographed?",
  // biology / medicine
  "How does the human gut microbiome affect digestion?",
  "What causes antibiotic resistance in bacteria?",
  "How does anesthesia actually make you unconscious?",
  "What is the difference between Type 1 and Type 2 diabetes?",
  "How does the placebo effect work biologically?",
  "What causes autoimmune diseases?",
  "How do vaccines create herd immunity?",
  // culture / misc
  "What is the origin of the game of chess?",
  "How was the Great Wall of China actually built?",
  "What is the history of the Nobel Prize?",
  "How did jazz music originate?",
  "What is the significance of the Voyager Golden Record?",
  "How do sommeliers identify wine characteristics blind?",
  // company / product facts (real, checkable)
  "When was the Linux kernel first released and by whom?",
  "What programming language was originally used to build Python's interpreter?",
  "When was the Rust programming language first released?",
  "What company originally developed the TCP/IP protocol suite?",
  "When was the first iPhone released and what were its key specs?",
  "Who founded Wikipedia and when did it launch?",
  "What was the first widely used web browser?",
  "When was the USB standard first introduced?",
  // sports / records (checkable facts)
  "What is the current world record for the men's 100m sprint?",
  "How many times has Mount Everest been climbed?",
  "What is the deepest a human has ever dived unassisted?",
];

const NO_TOOL_PAIRS: [string, string][] = [
  ["How many days are in a leap year?", "366."],
  ["What is the boiling point of water at sea level in Celsius?", "100°C."],
  ["How many continents are there?", "Seven."],
  ["What is the chemical symbol for gold?", "Au."],
  ["How many minutes are in a day?", "1440."],
  ["What is 17% of 340?", "57.8."],
  ["What is 84 + 239?", "323."],
  ["What is 512 - 178?", "334."],
  ["What is the square root of 144?", "12."],
  ["How many degrees are in a right angle?", "90 degrees."],
];

const TEACHER_BASE = "http://127.0.0.1:8099/v1/chat/completions";

function firstUrl(searchOutput: string): string | null {
  const m = searchOutput.match(/https?:\/\/[^\s)]+/);
  return m ? m[0].replace(/[.,]+$/, "") : null;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function teacherAnswer(model: string, question: string, sourceTitle: string, url: string, content: string): Promise<string | null> {
  const prompt = `Using ONLY the following fetched web page, answer the question. Cite the source inline like "(source: <title>, <url>)" and keep the answer to 2-4 sentences — specific facts (numbers, names, dates) only if they actually appear in the page below. If the page doesn't actually contain the answer, say so plainly instead of guessing.

Question: ${question}

Fetched page (title: ${sourceTitle}, url: ${url}):
${content.slice(0, 6000)}`;
  try {
    const r = await fetch(TEACHER_BASE, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: 300,
        chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  }
}

function call(idx: number, name: string, args: Record<string, unknown>) {
  return { id: `call_${idx}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function toolResult(idx: number, name: string, content: string) {
  return { role: "tool", tool_call_id: `call_${idx}`, name, content };
}

type Row = { messages: unknown[]; tools: unknown[]; source: string };

async function buildSearchFetchRow(question: string, teacherModel: string, i: number):
  Promise<{ row: Row; url: string; title: string; content: string; searchOut: string } | null> {
  const searchOut = await webSearch(question);
  if (searchOut.startsWith("(")) { console.log("  SKIP (search):", question, "->", searchOut.slice(0, 80)); return null; }
  const url = firstUrl(searchOut);
  if (!url) { console.log("  SKIP (no url parsed):", question); return null; }
  const titleMatch = searchOut.match(/^\[1\]\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : url;
  const content = await webFetch(url);
  if (content.startsWith("error:")) { console.log("  SKIP (fetch failed):", question, "->", content.slice(0, 80)); return null; }
  const answer = await teacherAnswer(teacherModel, question, title, url, content);
  if (!answer || answer.length < 15) { console.log("  SKIP (teacher empty):", question); return null; }
  const row: Row = {
    messages: [
      { role: "user", content: question },
      { role: "assistant", content: null, tool_calls: [call(i, "web_search", { query: question })] },
      toolResult(i, "web_search", searchOut),
      { role: "assistant", content: null, tool_calls: [call(i + 1, "web_fetch", { url })] },
      toolResult(i + 1, "web_fetch", content),
      { role: "assistant", content: answer },
    ],
    tools: TOOLS,
    source: "research_real",
  };
  return { row, url, title, content, searchOut };
}

async function main() {
  const args = process.argv.slice(2);
  const nArg = args.indexOf("--n");
  const n = nArg >= 0 ? Number(args[nArg + 1]) : QUESTIONS.length;
  const outArg = args.indexOf("--out");
  const outPath = path.resolve(outArg >= 0 ? args[outArg + 1] : "../data/research_real_sft.jsonl");
  const teacherArg = args.indexOf("--teacher");
  const teacherModel = teacherArg >= 0 ? args[teacherArg + 1] : "victory6-8b";

  const questions = QUESTIONS.slice(0, n);
  const out = fs.createWriteStream(outPath, { flags: "w" });
  let ok = 0, skipped = 0;
  const cache: { question: string; url: string; title: string; content: string }[] = [];

  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    console.log(`[${idx + 1}/${questions.length}] ${q}`);
    const built = await buildSearchFetchRow(q, teacherModel, idx * 10);
    if (built) {
      out.write(JSON.stringify(built.row) + "\n");
      cache.push({ question: q, url: built.url, title: built.title, content: built.content });
      ok++;
    } else {
      skipped++;
    }
    await sleep(1200); // be polite to DDG between requests
  }

  // Multihop rows: reuse already-fetched real pairs, zero extra network calls.
  // Pairs adjacent cached items (already topically clustered by the QUESTIONS list order).
  let multihop = 0;
  for (let i = 0; i + 1 < cache.length; i += 2) {
    const a = cache[i], b = cache[i + 1];
    const combinedQ = `Between these two topics, summarize what's factually established about each and cite your sources: (1) ${a.question} (2) ${b.question}`;
    const answer = await teacherAnswer(
      teacherModel, combinedQ,
      `${a.title} / ${b.title}`, `${a.url} and ${b.url}`,
      `--- Source A (${a.title}, ${a.url}) ---\n${a.content.slice(0, 2500)}\n\n--- Source B (${b.title}, ${b.url}) ---\n${b.content.slice(0, 2500)}`
    );
    if (!answer) continue;
    const base = 100000 + i * 10;
    const row: Row = {
      messages: [
        { role: "user", content: combinedQ },
        { role: "assistant", content: null, tool_calls: [call(base, "web_search", { query: a.question })] },
        toolResult(base, "web_search", `[1] ${a.title}\n(real search result)\n${a.url}`),
        { role: "assistant", content: null, tool_calls: [call(base + 1, "web_fetch", { url: a.url })] },
        toolResult(base + 1, "web_fetch", a.content),
        { role: "assistant", content: null, tool_calls: [call(base + 2, "web_search", { query: b.question })] },
        toolResult(base + 2, "web_search", `[1] ${b.title}\n(real search result)\n${b.url}`),
        { role: "assistant", content: null, tool_calls: [call(base + 3, "web_fetch", { url: b.url })] },
        toolResult(base + 3, "web_fetch", b.content),
        { role: "assistant", content: answer },
      ],
      tools: TOOLS,
      source: "research_real_multihop",
    };
    out.write(JSON.stringify(row) + "\n");
    multihop++;
  }

  // No-tool restraint rows (trivial, no lookup needed).
  for (const [q, a] of NO_TOOL_PAIRS) {
    const row: Row = { messages: [{ role: "user", content: q }, { role: "assistant", content: `${a} That's general knowledge, no lookup needed.` }], tools: TOOLS, source: "research_no_tool" };
    out.write(JSON.stringify(row) + "\n");
  }

  out.end();
  console.log(`\nDone. search_fetch ok=${ok} skipped=${skipped}, multihop=${multihop}, no_tool=${NO_TOOL_PAIRS.length}`);
  console.log("wrote", outPath);
}

main();
