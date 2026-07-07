// Exec-verified webgen SFT data generator (task 6 of the reality-gap plan).
// Every candidate — Claude-authored exemplar or teacher-generated reply — must pass
// the SAME headless-Chrome grader the benchmark uses before it becomes a training row.
// Tasks live in webgen-train-tasks.ts and are disjoint from the bench suite (and snake
// is banned outright: it is the user's private blind test).
//
//   npx tsx scripts/gen_webgen_data.ts exemplar            # verify + emit exemplar rows
//   npx tsx scripts/gen_webgen_data.ts teacher gemma4:12b  # teacher replies, verified
//   npx tsx scripts/gen_webgen_data.ts external            # grade user-pasted frontier
//        replies from data/webgen_external/<task-id>/*.{md,html,txt} (see
//        data/webgen_prompts.md for the prompts to paste into ChatGPT/Gemini)
//
// Output: ../data/webgen_sft.jsonl (exemplar) / webgen_sft_<model>.jsonl (teacher),
// rows in trainer {messages:[user,assistant]} shape. Teacher replies are kept verbatim
// (their natural phrasing around the code is part of the format we want to teach).
import fs from "node:fs";
import path from "node:path";
import { gradeWebgen } from "../src/lib/graders";
import { TRAIN_TASKS } from "./webgen-train-tasks";

const ROOT = path.resolve(process.cwd(), "..");
const OLLAMA = "http://127.0.0.1:11434";

if (TRAIN_TASKS.some((t) => /snake/i.test(t.id + t.prompt + t.exemplar))) {
  throw new Error("snake detected in training tasks — it must stay a blind test");
}

async function teacherReply(model: string, prompt: string, temperature: number): Promise<string> {
  // stream and accumulate: with stream:false Ollama sends no bytes until the full
  // reply is done, and undici's 300s headers timeout kills any 12B generation
  // longer than ~5 min (model load + 8k num_predict at ~12 tok/s blows past it)
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model, messages: [{ role: "user", content: prompt }], think: false, stream: true,
      options: { temperature, num_predict: 8192, num_ctx: 10240 },
    }),
  });
  if (!r.ok || !r.body) throw new Error(`ollama ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let out = "", buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { out += JSON.parse(line).message?.content || ""; } catch {}
    }
  }
  return out;
}

(async () => {
  const mode = process.argv[2] || "exemplar";
  const teacher = process.argv[3];
  const rows: { messages: { role: string; content: string }[] }[] = [];
  let pass = 0, fail = 0;

  if (mode === "exemplar") {
    for (const t of TRAIN_TASKS) {
      const item = { cat: "webgen", q: t.prompt, probes: t.probes };
      const g = await gradeWebgen(t.exemplar, item);
      if (g.ok) {
        pass++;
        rows.push({ messages: [{ role: "user", content: t.prompt }, { role: "assistant", content: t.exemplar }] });
        console.log("PASS", t.id, "|", g.detail);
      } else {
        fail++;
        console.log("FAIL", t.id, "|", g.detail, "— exemplar NOT emitted, fix it");
      }
    }
    const out = path.join(ROOT, "data", "webgen_sft.jsonl");
    fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    console.log(JSON.stringify({ mode, pass, fail, out }));
    process.exit(fail ? 1 : 0);
  }

  if (mode === "teacher") {
    if (!teacher) throw new Error("usage: gen_webgen_data.ts teacher <ollama-model>");
    const perTask = Number(process.argv[4] || 2);   // attempts per task at varied temps
    for (const t of TRAIN_TASKS) {
      for (let i = 0; i < perTask; i++) {
        const temp = i === 0 ? 0.4 : 0.8;
        let reply = "";
        try { reply = await teacherReply(teacher, t.prompt, temp); } catch (e) { console.log("gen error", t.id, (e as Error).message); continue; }
        const g = await gradeWebgen(reply, { cat: "webgen", q: t.prompt, probes: t.probes });
        if (g.ok) {
          pass++;
          rows.push({ messages: [{ role: "user", content: t.prompt }, { role: "assistant", content: reply }] });
          console.log("PASS", t.id, "t=" + temp, "|", g.detail);
        } else {
          fail++;
          console.log("FAIL", t.id, "t=" + temp, "|", (g.detail || "").slice(0, 100));
        }
      }
    }
    const out = path.join(ROOT, "data", `webgen_sft_${teacher.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
    fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    console.log(JSON.stringify({ mode, teacher, pass, fail, out }));
    process.exit(0);
  }

  if (mode === "external") {
    const dir = path.join(ROOT, "data", "webgen_external");
    if (!fs.existsSync(dir)) throw new Error(dir + " not found — save ChatGPT/Gemini replies there first (one folder per task id)");
    for (const t of TRAIN_TASKS) {
      const tdir = path.join(dir, t.id);
      if (!fs.existsSync(tdir)) continue;
      for (const f of fs.readdirSync(tdir)) {
        if (!/\.(md|html|txt)$/i.test(f)) continue;
        let reply = fs.readFileSync(path.join(tdir, f), "utf8");
        // a bare .html file (no fence) still counts — wrap it so extraction/training format match
        if (/\.html$/i.test(f) && !reply.includes("```")) reply = "```html\n" + reply.trim() + "\n```";
        const g = await gradeWebgen(reply, { cat: "webgen", q: t.prompt, probes: t.probes });
        if (g.ok) {
          pass++;
          rows.push({ messages: [{ role: "user", content: t.prompt }, { role: "assistant", content: reply }] });
          console.log("PASS", t.id + "/" + f, "|", g.detail);
        } else {
          fail++;
          console.log("FAIL", t.id + "/" + f, "|", (g.detail || "").slice(0, 110));
        }
      }
    }
    const out = path.join(ROOT, "data", "webgen_sft_external.jsonl");
    fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    console.log(JSON.stringify({ mode, pass, fail, out }));
    process.exit(0);
  }

  throw new Error("unknown mode: " + mode);
})();
