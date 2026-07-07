"""Claude-authored follow-through/verification exemplars for victory7 — the final mix.

Every exemplar targets one of the two failure modes observed LIVE in victory6
(2026-07-05 eval battery, real transcripts):
  1. narrate-instead-of-execute — the model wrote out a step-by-step plan in text
     ("Let's start by creating the router file...") and never called a single tool
     (seen in systems-refactor and orchestrator-smoke scenarios).
  2. hallucinated completion — the model ran `echo $((17*23))`, saw 391 in stdout,
     then claimed "the output was written to result.txt" without ever calling
     write_file (the file did not exist afterward).

Design rules, all deliberate:
  - Tool defs are VERBATIM copies of the live /code agent schema (agent-tools.ts +
    tools.ts, dumped 2026-07-06) so the training format matches production exactly.
  - Per-row tool SUBSETS, not the full 16-tool palette: the full header alone is
    1911 tokens > the 1536 training block. Subsets also match what sub-agents see
    (SUB_TOOL_DEFS) and vary the header so the model can't overfit to one menu.
  - Assistant turns couple a short intent statement WITH the tool call in the same
    message (the SWE-smith pattern) — never a bare plan followed by nothing.
  - Every task that changes state ends with a VERIFICATION tool call (read back /
    re-run / list) BEFORE the final reply, and the final reply says what was
    verified, not just what was attempted.
  - Several exemplars are recovery-shaped: verification FAILS first (test still
    red, sub-agent lied about writing a file, wrong path), the model fixes and
    re-verifies. A model never shown failure recovers badly.
  - A few are restraint-shaped: pure questions answered in text with zero or
    read-only tools — acting when not asked is the mirror-image failure.
  - Tool RESULTS byte-match the real executors: write_file/edit_file -> "ok",
    run_shell -> stdout + "\\n[exit 0]", spawn_agent -> "[helper-N report]\\n...",
    memory_write -> "wrote <block> (N bytes)", record_finding -> "findings: +1
    added, ...", edit_file miss -> "error: search string not found".
  - Global call_N ids across the whole file (the import_toucan lesson).

Usage: .venv/bin/python scripts/gen_followthrough.py  -> data/followthrough_sft.jsonl
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "followthrough_sft.jsonl")

# ---- live tool schema (verbatim from the running app, 2026-07-06) ----
D = {}
D["list_files"] = {"type": "function", "function": {"name": "list_files", "description": "List files and directories under a path (relative to the workspace root).", "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": "directory, relative to workspace root; default '.'"}}}}}
D["read_file"] = {"type": "function", "function": {"name": "read_file", "description": "Read a text file's contents.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}}
D["write_file"] = {"type": "function", "function": {"name": "write_file", "description": "Create or overwrite a text file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}}}
D["edit_file"] = {"type": "function", "function": {"name": "edit_file", "description": "Replace the first exact-match occurrence of `search` with `replace` in a file.", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "search": {"type": "string"}, "replace": {"type": "string"}}, "required": ["path", "search", "replace"]}}}
D["grep"] = {"type": "function", "function": {"name": "grep", "description": "Search file contents under a directory for a regex pattern.", "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string", "description": "directory to search, default '.'"}}, "required": ["pattern"]}}}
D["run_shell"] = {"type": "function", "function": {"name": "run_shell", "description": "Run a bash command in the workspace (60s timeout).", "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}}
D["run_python"] = {"type": "function", "function": {"name": "run_python", "description": "Run a Python snippet in the workspace (fresh interpreter, 30s CPU limit, stdout+stderr returned). Use for calculations, data processing, quick scripts.", "parameters": {"type": "object", "properties": {"code": {"type": "string", "description": "python source to execute"}}, "required": ["code"]}}}
D["memory_read"] = {"type": "function", "function": {"name": "memory_read", "description": "Read your standing project memory — small, durable notes that persist across separate sessions on this project (unlike the conversation, which starts fresh each time). Three blocks: \"project_conventions\" (coding style/patterns to follow), \"known_gotchas\" (past mistakes/traps to avoid repeating), \"current_task_state\" (what you're mid-way through). Omit `block` or pass \"all\" to read everything at once.", "parameters": {"type": "object", "properties": {"block": {"type": "string", "enum": ["project_conventions", "known_gotchas", "current_task_state", "all"], "description": "which block to read; defaults to all"}}, "required": []}}}
D["memory_write"] = {"type": "function", "function": {"name": "memory_write", "description": "Write to your standing project memory (see memory_read). Each block is capped (~1000 tokens) — if you exceed it, the OLDEST content is dropped to make room, so keep entries concise and prune stale ones yourself rather than letting them get silently trimmed. Use \"replace\" to rewrite a block fully, \"append\" to add a new note to the end.", "parameters": {"type": "object", "properties": {"block": {"type": "string", "enum": ["project_conventions", "known_gotchas", "current_task_state"], "description": "which block to write"}, "content": {"type": "string", "description": "the content to write or append"}, "mode": {"type": "string", "enum": ["replace", "append"], "description": "default: replace"}}, "required": ["block", "content"]}}}
D["memory_search"] = {"type": "function", "function": {"name": "memory_search", "description": "Search past session history on this project (a larger, retrieved-on-demand archive, distinct from the small always-visible memory_read blocks) — use it when you want to check whether you've touched a file or made a decision in an earlier, separate session.", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "what to search for"}}, "required": ["query"]}}}
D["record_finding"] = {"type": "function", "function": {"name": "record_finding", "description": "Orchestrator mode only: record a finding into your shared findings store (deduped/merged automatically, so repeated or overlapping facts don't pile up). Use this instead of writing directly to findings.md for anything you discover yourself (e.g. via read_file) rather than through a spawn_agent report, which gets recorded automatically.", "parameters": {"type": "object", "properties": {"fact": {"type": "string", "description": "the finding to record"}}, "required": ["fact"]}}}
D["spawn_agent"] = {"type": "function", "function": {"name": "spawn_agent", "description": "Delegate a self-contained subtask to a helper agent that has the same file/web/python tools (but cannot spawn further agents). It works autonomously and returns a final report. Good for research questions or exploring a codebase corner while you continue the main plan. Optionally hand the task to a DIFFERENT local model via `model` (e.g. a small fast one for research/extraction, a strong one for implementation, a different one for independent red-team critique) — this machine has one GPU, so a different model means a real reload (seconds to ~a minute); batch several spawns on the same model consecutively rather than alternating models call-by-call. Omit `model` to reuse whatever is already serving (zero swap cost).", "parameters": {"type": "object", "properties": {"task": {"type": "string", "description": "complete, self-contained instructions for the helper — it sees nothing else, so include exact paths/goals/deliverable"}, "model": {"type": "string", "description": "optional: name of a different local model to run this subtask on (see available models)"}, "max_rounds": {"type": "number", "description": "optional: tool-call round budget for the helper (1-20, default 10)"}}, "required": ["task"]}}}

CORE = [D[n] for n in ("list_files", "read_file", "write_file", "edit_file", "grep", "run_shell")]
CORE_PY = [D[n] for n in ("list_files", "read_file", "write_file", "edit_file", "run_python", "run_shell")]
ORCH = [D[n] for n in ("spawn_agent", "list_files", "read_file", "record_finding")]
ORCH_W = [D[n] for n in ("spawn_agent", "list_files", "read_file", "write_file", "record_finding")]
MEM = [D[n] for n in ("memory_read", "memory_write", "memory_search", "read_file", "edit_file", "run_shell")]

_ctr = 0
def _cid():
    global _ctr
    c = f"call_{_ctr}"
    _ctr += 1
    return c

def u(text):
    return {"role": "user", "content": text}

def a(text, *calls):
    """assistant turn: intent text coupled with tool call(s) in the SAME message."""
    m = {"role": "assistant", "content": text or None}
    if calls:
        m["tool_calls"] = [c[0] for c in calls]
        return m, [c[1] for c in calls]
    return m

def c(name, **args):
    cid = _cid()
    return ({"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}},
            {"cid": cid, "name": name})

def t(meta, content):
    return {"role": "tool", "tool_call_id": meta["cid"], "name": meta["name"], "content": content}

def conv(tools, *parts):
    msgs = []
    for p in parts:
        if isinstance(p, tuple):  # (assistant_msg, metas) from a(...)
            msgs.append(p[0])
        else:
            msgs.append(p)
    return {"messages": msgs, "tools": tools}

ROWS = []

# =====================================================================
# A) act-not-narrate: multi-step tasks done end-to-end, verified, then reported
# =====================================================================

# A1 — express route refactor (direct mirror of the systems-refactor live failure)
x1, m1 = a("I'll look at the project layout first.", *[c("list_files", path=".")])
x2, m2 = a("Reading the main server file to see the route handlers.", *[c("read_file", path="index.js")])
x3, m3 = a("Moving the three task routes into a router module.", *[c("write_file", path="routes/tasks.js", content="const express = require('express');\nconst router = express.Router();\nconst { load, save } = require('../store');\n\nrouter.get('/', (req, res) => res.json(load()));\n\nrouter.post('/', (req, res) => {\n  const tasks = load();\n  const t = { id: Date.now(), title: req.body.title, done: false };\n  tasks.push(t);\n  save(tasks);\n  res.status(201).json(t);\n});\n\nrouter.delete('/:id', (req, res) => {\n  save(load().filter(t => t.id !== Number(req.params.id)));\n  res.status(204).end();\n});\n\nmodule.exports = router;\n")])
x4, m4 = a("Now pointing index.js at the router instead of the inline handlers.", *[c("edit_file", path="index.js", search="app.get('/tasks', (req, res) => res.json(load()));", replace="app.use('/tasks', require('./routes/tasks'));")])
x5, m5 = a("Removing the now-dead inline POST and DELETE handlers.", *[c("edit_file", path="index.js", search="app.post('/tasks', (req, res) => {\n  const tasks = load();\n  const t = { id: Date.now(), title: req.body.title, done: false };\n  tasks.push(t);\n  save(tasks);\n  res.status(201).json(t);\n});\n\napp.delete('/tasks/:id', (req, res) => {\n  save(load().filter(t => t.id !== Number(req.params.id)));\n  res.status(204).end();\n});", replace="")])
x6, m6 = a("Syntax-checking both files before calling this done.", *[c("run_shell", command="node --check index.js && node --check routes/tasks.js && echo SYNTAX_OK")])
ROWS.append(conv(CORE,
    u("Refactor the Express route handlers out of index.js into a routes/tasks.js router module. Keep behavior identical."),
    x1, t(m1[0], "index.js\nnode_modules/\npackage.json\nstore.js"),
    x2, t(m2[0], "const express = require('express');\nconst { load, save } = require('./store');\nconst app = express();\napp.use(express.json());\n\napp.get('/tasks', (req, res) => res.json(load()));\n\napp.post('/tasks', (req, res) => {\n  const tasks = load();\n  const t = { id: Date.now(), title: req.body.title, done: false };\n  tasks.push(t);\n  save(tasks);\n  res.status(201).json(t);\n});\n\napp.delete('/tasks/:id', (req, res) => {\n  save(load().filter(t => t.id !== Number(req.params.id)));\n  res.status(204).end();\n});\n\napp.listen(3000);"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "ok"),
    x5, t(m5[0], "ok"),
    x6, t(m6[0], "SYNTAX_OK\n\n[exit 0]"),
    a("Done. All three task routes (GET/POST/DELETE) now live in routes/tasks.js as an Express router, and index.js mounts it with app.use('/tasks', ...). Verified: node --check passes on both files, and no inline task handlers remain in index.js.")))

# A2 — failing test: reproduce, fix, re-verify (recovery-shaped)
x1, m1 = a("Running the test first to see the actual failure.", *[c("run_shell", command="npm test 2>&1 | tail -8")])
x2, m2 = a("The test expects trimmed input. Checking how validate() handles it.", *[c("read_file", path="src/validate.js")])
x3, m3 = a("It never trims — adding that.", *[c("edit_file", path="src/validate.js", search="function validate(title) {\n  return typeof title === 'string' && title.length > 0;", replace="function validate(title) {\n  if (typeof title !== 'string') return false;\n  title = title.trim();\n  return title.length > 0;")])
x4, m4 = a("Re-running the test to confirm the fix.", *[c("run_shell", command="npm test 2>&1 | tail -4")])
ROWS.append(conv(CORE,
    u("npm test is failing on the validation suite — fix it."),
    x1, t(m1[0], "  validate\n    ✓ accepts a plain title\n    ✗ rejects whitespace-only titles\n      AssertionError: expected true to equal false\n      at test/validate.test.js:11\n\n1 failing\n\n[exit 1]"),
    x2, t(m2[0], "function validate(title) {\n  return typeof title === 'string' && title.length > 0;\n}\n\nmodule.exports = { validate };"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "  validate\n    ✓ accepts a plain title\n    ✓ rejects whitespace-only titles\n\n2 passing\n\n[exit 0]"),
    a("Fixed. validate() was counting whitespace-only titles as valid because it never trimmed; it now trims before the length check. Verified: the full suite passes (2/2), including the previously failing whitespace case.")))

# A3 — build a small CLI and prove it runs
x1, m1 = a("Creating the CLI.", *[c("write_file", path="wordfreq.js", content="#!/usr/bin/env node\nconst fs = require('fs');\nconst text = fs.readFileSync(process.argv[2], 'utf8').toLowerCase();\nconst counts = {};\nfor (const w of text.match(/[a-z']+/g) || []) counts[w] = (counts[w] || 0) + 1;\nconst top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[3]) || 10);\nfor (const [w, n] of top) console.log(`${String(n).padStart(6)}  ${w}`);\n")])
x2, m2 = a("Making a small sample file and actually running it to prove it works end-to-end.", *[c("run_shell", command="printf 'the cat sat on the mat. the cat ran.' > sample.txt && node wordfreq.js sample.txt 3")])
ROWS.append(conv(CORE,
    u("Write a Node CLI wordfreq.js that prints the top-N most frequent words in a text file (usage: node wordfreq.js file.txt N)."),
    x1, t(m1[0], "ok"),
    x2, t(m2[0], "     3  the\n     2  cat\n     1  sat\n\n[exit 0]"),
    a("wordfreq.js is written and verified working: on a sample file it correctly prints the top 3 words with counts (`the` x3, `cat` x2, `sat` x1). Usage: node wordfreq.js file.txt N (N defaults to 10).")))

# A4 — bug reproduce with run_python, fix, re-verify (recovery-shaped)
x1, m1 = a("Reproducing the crash first.", *[c("run_python", code="from parser import parse_row\nprint(parse_row(''))")])
x2, m2 = a("Confirmed — it splits an empty string and indexes into nothing. Looking at the function.", *[c("read_file", path="parser.py")])
x3, m3 = a("Adding an empty-input guard.", *[c("edit_file", path="parser.py", search="def parse_row(line):\n    parts = line.split(',')", replace="def parse_row(line):\n    if not line.strip():\n        return None\n    parts = line.split(',')")])
x4, m4 = a("Re-running the reproduction, plus a normal row to make sure nothing broke.", *[c("run_python", code="from parser import parse_row\nprint(parse_row(''))\nprint(parse_row('a,b,c'))")])
ROWS.append(conv(CORE_PY,
    u("parser.py crashes on empty lines in the CSV — fix it so empty lines are skipped."),
    x1, t(m1[0], "Traceback (most recent call last):\n  File \"<string>\", line 2, in <module>\n  File \"parser.py\", line 3, in parse_row\n    return {'id': parts[0], 'name': parts[1]}\nIndexError: list index out of range"),
    x2, t(m2[0], "def parse_row(line):\n    parts = line.split(',')\n    return {'id': parts[0], 'name': parts[1]}"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "None\n{'id': 'a', 'name': 'b'}"),
    a("Fixed. parse_row() now returns None for empty/whitespace-only lines instead of crashing with IndexError. Verified by re-running the reproduction: the empty line returns None and a normal row still parses correctly.")))

# A5 — rename across files, verify zero leftovers with grep
x1, m1 = a("Finding every use of the old name first.", *[c("grep", pattern="fetchUserData", path=".")])
x2, m2 = a("Renaming in api.js (definition and export).", *[c("edit_file", path="api.js", search="async function fetchUserData(id) {", replace="async function getUser(id) {")])
x3, m3 = a(None, *[c("edit_file", path="api.js", search="module.exports = { fetchUserData };", replace="module.exports = { getUser };")])
x4, m4 = a("Updating the caller in app.js.", *[c("edit_file", path="app.js", search="const { fetchUserData } = require('./api');", replace="const { getUser } = require('./api');")])
x5, m5 = a(None, *[c("edit_file", path="app.js", search="const user = await fetchUserData(req.params.id);", replace="const user = await getUser(req.params.id);")])
x6, m6 = a("Verifying no occurrences of the old name remain anywhere.", *[c("grep", pattern="fetchUserData", path=".")])
ROWS.append(conv(CORE,
    u("Rename the fetchUserData function to getUser everywhere in this project."),
    x1, t(m1[0], "api.js:3:async function fetchUserData(id) {\napi.js:9:module.exports = { fetchUserData };\napp.js:2:const { fetchUserData } = require('./api');\napp.js:7:  const user = await fetchUserData(req.params.id);"),
    x2, t(m2[0], "ok"), x3, t(m3[0], "ok"), x4, t(m4[0], "ok"), x5, t(m5[0], "ok"),
    x6, t(m6[0], "(no matches)"),
    a("Renamed fetchUserData to getUser in all 4 places (definition and export in api.js, import and call site in app.js). Verified: grep finds zero remaining occurrences of the old name.")))

# A6 — completed-task overdue bug (mirror of task-tracker turn 4)
x1, m1 = a("Finding where the overdue class is applied.", *[c("grep", pattern="overdue", path=".")])
x2, m2 = a("Reading the surrounding logic.", *[c("read_file", path="public/app.js")])
x3, m3 = a("The check ignores completion — an overdue-but-done task stays highlighted. Fixing the condition.", *[c("edit_file", path="public/app.js", search="if (task.due && new Date(task.due) < today) {", replace="if (!task.done && task.due && new Date(task.due) < today) {")])
x4, m4 = a("Syntax-checking the file.", *[c("run_shell", command="node --check public/app.js && echo OK")])
ROWS.append(conv(CORE,
    u("Bug: tasks that are marked complete still show the overdue highlighting. Completed tasks should never look overdue."),
    x1, t(m1[0], "public/app.js:41:  if (task.due && new Date(task.due) < today) {\npublic/app.js:42:    li.classList.add('overdue');\npublic/styles.css:18:.overdue { border-left: 3px solid #d33; }"),
    x2, t(m2[0], "  const li = document.createElement('li');\n  li.textContent = task.title;\n  if (task.done) li.classList.add('done');\n  if (task.due && new Date(task.due) < today) {\n    li.classList.add('overdue');\n  }\n  list.appendChild(li);"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "OK\n\n[exit 0]"),
    a("Fixed: the overdue class is now only added when the task is NOT done (`!task.done && task.due && ...`), so completed tasks never show the red overdue border. Verified: node --check passes on public/app.js.")))

# A7 — add endpoint, verify with a real request
x1, m1 = a("Reading the server file to match its style.", *[c("read_file", path="server.js")])
x2, m2 = a("Adding the /health route before the listen call.", *[c("edit_file", path="server.js", search="app.listen(PORT", replace="app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));\n\napp.listen(PORT")])
x3, m3 = a("Starting the server briefly and hitting the endpoint to prove it responds.", *[c("run_shell", command="node server.js & SPID=$!; sleep 1; curl -s http://localhost:4000/health; kill $SPID")])
ROWS.append(conv(CORE,
    u("Add a GET /health endpoint to server.js that returns JSON with ok and uptime."),
    x1, t(m1[0], "const express = require('express');\nconst app = express();\nconst PORT = 4000;\n\napp.get('/', (req, res) => res.send('hi'));\n\napp.listen(PORT, () => console.log('listening on', PORT));"),
    x2, t(m2[0], "ok"),
    x3, t(m3[0], "listening on 4000\n{\"ok\":true,\"uptime\":1.042}\n\n[exit 0]"),
    a("Added GET /health returning `{ ok: true, uptime: <seconds> }`. Verified live: started the server and curled the endpoint — it responded with the expected JSON.")))

# A8 — search/filter box (mirror of task-tracker turn 3)
x1, m1 = a("Looking at the current markup and render function.", *[c("read_file", path="public/index.html")])
x2, m2 = a("Adding the filter input above the list.", *[c("edit_file", path="public/index.html", search="<ul id=\"tasks\"></ul>", replace="<input id=\"filter\" type=\"text\" placeholder=\"Filter tasks...\">\n  <ul id=\"tasks\"></ul>")])
x3, m3 = a("Wiring it to re-render on input.", *[c("edit_file", path="public/app.js", search="function render(tasks) {\n  list.innerHTML = '';", replace="const filterBox = document.getElementById('filter');\nfilterBox.addEventListener('input', () => render(allTasks));\n\nfunction render(tasks) {\n  const q = filterBox.value.toLowerCase();\n  if (q) tasks = tasks.filter(t => t.title.toLowerCase().includes(q));\n  list.innerHTML = '';")])
x4, m4 = a("Checking the script still parses and the hook is in place.", *[c("run_shell", command="node --check public/app.js && grep -c 'filterBox' public/app.js")])
ROWS.append(conv(CORE,
    u("Add a search/filter text box above the task list that filters visible tasks as you type (case-insensitive substring match on the title)."),
    x1, t(m1[0], "<body>\n  <h1>Tasks</h1>\n  <ul id=\"tasks\"></ul>\n  <script src=\"app.js\"></script>\n</body>"),
    x2, t(m2[0], "ok"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "3\n\n[exit 0]"),
    a("Added the filter box: an <input id=\"filter\"> above the list, and render() now filters tasks by case-insensitive substring match on the title, re-rendering on every keystroke. Verified: node --check passes and the input hook is wired (3 filterBox references).")))

# A9 — extract inline CSS, verify none left
x1, m1 = a("Checking what inline styles exist.", *[c("grep", pattern="style=", path=".")])
x2, m2 = a("Creating the stylesheet with equivalent rules.", *[c("write_file", path="styles.css", content=".banner { background: #223; color: #fff; padding: 12px; }\n.cta { font-weight: bold; color: #d55; }\n")])
x3, m3 = a("Swapping the inline styles for classes and linking the sheet.", *[c("edit_file", path="index.html", search="<div style=\"background:#223;color:#fff;padding:12px\">", replace="<div class=\"banner\">")])
x4, m4 = a(None, *[c("edit_file", path="index.html", search="<span style=\"font-weight:bold;color:#d55\">", replace="<span class=\"cta\">")])
x5, m5 = a(None, *[c("edit_file", path="index.html", search="</title>", replace="</title>\n  <link rel=\"stylesheet\" href=\"styles.css\">")])
x6, m6 = a("Verifying no inline styles remain.", *[c("grep", pattern="style=", path=".")])
ROWS.append(conv(CORE,
    u("Move the inline styles in index.html into a styles.css file and link it."),
    x1, t(m1[0], "index.html:8:  <div style=\"background:#223;color:#fff;padding:12px\">\nindex.html:12:  <span style=\"font-weight:bold;color:#d55\">"),
    x2, t(m2[0], "ok"), x3, t(m3[0], "ok"), x4, t(m4[0], "ok"), x5, t(m5[0], "ok"),
    x6, t(m6[0], "(no matches)"),
    a("Done: both inline styles are now .banner and .cta classes in styles.css, linked from the <head>. Verified: grep finds zero style= attributes left in the project.")))

# A10 — dedupe script with proof run
x1, m1 = a("Writing the dedupe script.", *[c("write_file", path="dedupe.py", content="import csv, sys\n\nrows, seen = [], set()\nwith open(sys.argv[1], newline='') as f:\n    reader = csv.DictReader(f)\n    fields = reader.fieldnames\n    for row in reader:\n        key = row['email'].strip().lower()\n        if key in seen:\n            continue\n        seen.add(key)\n        rows.append(row)\n\nwith open(sys.argv[2], 'w', newline='') as f:\n    w = csv.DictWriter(f, fieldnames=fields)\n    w.writeheader()\n    w.writerows(rows)\nprint(f'kept {len(rows)} rows')\n")])
x2, m2 = a("Testing it on a small file with a known duplicate before claiming it works.", *[c("run_python", code="open('t.csv','w').write('name,email\\nAna,a@x.com\\nBob,b@x.com\\nAna2,A@X.COM\\n')\nimport subprocess\nprint(subprocess.run(['python','dedupe.py','t.csv','out.csv'],capture_output=True,text=True).stdout)\nprint(open('out.csv').read())")])
ROWS.append(conv(CORE_PY,
    u("Write dedupe.py that removes duplicate rows from a CSV by email (case-insensitive), keeping the first occurrence. Usage: python dedupe.py in.csv out.csv"),
    x1, t(m1[0], "ok"),
    x2, t(m2[0], "kept 2 rows\n\nname,email\nAna,a@x.com\nBob,b@x.com"),
    a("dedupe.py is written and verified: on a test file with 3 rows where 'A@X.COM' duplicates 'a@x.com' case-insensitively, it kept exactly the first 2 unique rows. Duplicate detection lowercases and trims the email; first occurrence wins.")))

# A11 — README from real package.json (read first, never guess)
x1, m1 = a("Reading package.json so the README reflects the real scripts and deps.", *[c("read_file", path="package.json")])
x2, m2 = a("Writing the README from what's actually there.", *[c("write_file", path="README.md", content="# taskd\n\nSmall Express + lowdb task API.\n\n## Setup\n\n```bash\nnpm install\nnpm start   # runs node index.js on :3000\n```\n\n## Scripts\n\n- `npm start` — start the server\n- `npm test` — run the mocha suite\n\n## Dependencies\n\nexpress, lowdb\n")])
x3, m3 = a("Reading it back to confirm the write landed correctly.", *[c("read_file", path="README.md")])
ROWS.append(conv(CORE,
    u("Create a README.md for this project based on what's actually in package.json (name, scripts, deps)."),
    x1, t(m1[0], "{\n  \"name\": \"taskd\",\n  \"scripts\": { \"start\": \"node index.js\", \"test\": \"mocha\" },\n  \"dependencies\": { \"express\": \"^4.18.2\", \"lowdb\": \"^7.0.1\" }\n}"),
    x2, t(m2[0], "ok"),
    x3, t(m3[0], "# taskd\n\nSmall Express + lowdb task API.\n\n## Setup\n\n```bash\nnpm install\nnpm start   # runs node index.js on :3000\n```\n\n## Scripts\n\n- `npm start` — start the server\n- `npm test` — run the mocha suite\n\n## Dependencies\n\nexpress, lowdb\n"),
    a("README.md created from the real package.json contents — name (taskd), both scripts (start/test with what they run), and the two actual dependencies. Verified by reading the file back.")))

# A12 — edit_file search-miss recovery (the exact error the live agent hit repeatedly)
x1, m1 = a("Applying the timeout bump.", *[c("edit_file", path="client.js", search="timeout: 5000", replace="timeout: 15000")])
x2, m2 = a("Search string wasn't found — reading the file to see the real formatting instead of guessing again.", *[c("read_file", path="client.js")])
x3, m3 = a("The value is written as `timeoutMs = 5_000`. Editing what's actually there.", *[c("edit_file", path="client.js", search="const timeoutMs = 5_000;", replace="const timeoutMs = 15_000;")])
x4, m4 = a("Confirming the change.", *[c("grep", pattern="timeoutMs", path=".")])
ROWS.append(conv(CORE,
    u("Bump the request timeout in client.js from 5s to 15s."),
    x1, t(m1[0], "error: search string not found"),
    x2, t(m2[0], "const timeoutMs = 5_000;\n\nasync function get(url) {\n  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });\n}\nmodule.exports = { get };"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "client.js:1:const timeoutMs = 15_000;\nclient.js:4:  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });"),
    a("Timeout bumped from 5s to 15s. My first edit missed because I guessed the formatting (`timeout: 5000`) instead of reading the file — it actually uses `const timeoutMs = 5_000`. After reading, the edit applied cleanly; grep confirms the new value.")))

# A13 — port change with read-back verify
x1, m1 = a("Reading the config first.", *[c("read_file", path="config.json")])
x2, m2 = a("Changing the port.", *[c("edit_file", path="config.json", search="\"port\": 3000", replace="\"port\": 8080")])
x3, m3 = a("Reading it back and checking it's still valid JSON.", *[c("run_shell", command="python3 -m json.tool config.json")])
ROWS.append(conv(CORE,
    u("Change the app port in config.json from 3000 to 8080."),
    x1, t(m1[0], "{\n  \"port\": 3000,\n  \"logLevel\": \"info\"\n}"),
    x2, t(m2[0], "ok"),
    x3, t(m3[0], "{\n    \"port\": 8080,\n    \"logLevel\": \"info\"\n}\n\n[exit 0]"),
    a("Port changed to 8080 in config.json. Verified: the file parses as valid JSON and shows the new value.")))

# A14 — multi-file constant extraction
x1, m1 = a("Finding all the hardcoded copies.", *[c("grep", pattern="MAX_RETRIES|= 3", path="src")])
x2, m2 = a("Creating a shared constants module.", *[c("write_file", path="src/constants.js", content="module.exports = { MAX_RETRIES: 3 };\n")])
x3, m3 = a("Pointing both call sites at it.", *[c("edit_file", path="src/fetcher.js", search="const MAX_RETRIES = 3;", replace="const { MAX_RETRIES } = require('./constants');")])
x4, m4 = a(None, *[c("edit_file", path="src/uploader.js", search="const MAX_RETRIES = 3;", replace="const { MAX_RETRIES } = require('./constants');")])
x5, m5 = a("Syntax-checking all touched files.", *[c("run_shell", command="node --check src/constants.js && node --check src/fetcher.js && node --check src/uploader.js && echo ALL_OK")])
ROWS.append(conv(CORE,
    u("MAX_RETRIES is hardcoded as 3 in two places under src/ — extract it into a shared src/constants.js."),
    x1, t(m1[0], "src/fetcher.js:2:const MAX_RETRIES = 3;\nsrc/uploader.js:4:const MAX_RETRIES = 3;"),
    x2, t(m2[0], "ok"), x3, t(m3[0], "ok"), x4, t(m4[0], "ok"),
    x5, t(m5[0], "ALL_OK\n\n[exit 0]"),
    a("Extracted: src/constants.js now owns MAX_RETRIES=3, and both fetcher.js and uploader.js import it instead of defining their own copy. Verified: node --check passes on all three files.")))

# =====================================================================
# B) verify-before-claim: the exact hallucinated-completion failure, done right
# =====================================================================

# B1 — the EXACT live failure: run command, write result.txt, VERIFY the file
x1, m1 = a("Running the command.", *[c("run_shell", command="expr 41 \\* 12")])
x2, m2 = a("Writing the output to calc_out.txt.", *[c("write_file", path="calc_out.txt", content="492\n")])
x3, m3 = a("Reading the file back before reporting — a write I haven't seen land isn't done.", *[c("read_file", path="calc_out.txt")])
ROWS.append(conv(CORE,
    u("Compute 41 times 12 with a shell command and save the exact output into calc_out.txt."),
    x1, t(m1[0], "492\n\n[exit 0]"),
    x2, t(m2[0], "ok"),
    x3, t(m3[0], "492\n"),
    a("Done and verified: the command printed 492, calc_out.txt was written, and reading it back confirms it contains exactly `492`.")))

# B2 — checker.py mirror: report EXACTLY what stdout said, nothing more
x1, m1 = a("Running the script to see its actual output.", *[c("run_shell", command="python3 probe.py")])
ROWS.append(conv(CORE,
    u("Execute probe.py and report its stdout verbatim — I need the exact string."),
    x1, t(m1[0], "signature: 7f3a-OK\n\n[exit 0]"),
    a("probe.py prints exactly one line to stdout:\n\n```\nsignature: 7f3a-OK\n```")))

# B3 — TODO count report, verified
x1, m1 = a("Counting the TODOs.", *[c("grep", pattern="TODO", path="src")])
x2, m2 = a("Writing the report.", *[c("write_file", path="todo_report.txt", content="TODO count: 3\n\nsrc/api.js:14: // TODO: paginate\nsrc/api.js:52: // TODO: cache invalidation\nsrc/ui.js:9: // TODO: debounce input\n")])
x3, m3 = a("Verifying the report exists with the right count.", *[c("run_shell", command="head -1 todo_report.txt")])
ROWS.append(conv(CORE,
    u("Count the TODO comments under src/ and write a todo_report.txt listing them."),
    x1, t(m1[0], "src/api.js:14:  // TODO: paginate\nsrc/api.js:52:  // TODO: cache invalidation\nsrc/ui.js:9:  // TODO: debounce input"),
    x2, t(m2[0], "ok"),
    x3, t(m3[0], "TODO count: 3\n\n[exit 0]"),
    a("Found 3 TODOs (two in src/api.js, one in src/ui.js) and wrote them to todo_report.txt with file:line references. Verified the file exists and leads with the count.")))

# B4 — deletion verified by absence
x1, m1 = a("Checking it exists before deleting, so I can verify the change after.", *[c("list_files", path=".")])
x2, m2 = a("Deleting it.", *[c("run_shell", command="rm debug.log")])
x3, m3 = a("Confirming it's gone.", *[c("list_files", path=".")])
ROWS.append(conv(CORE,
    u("Delete the stale debug.log file from the project root."),
    x1, t(m1[0], "app.js\ndebug.log\npackage.json"),
    x2, t(m2[0], "\n[exit 0]"),
    x3, t(m3[0], "app.js\npackage.json"),
    a("debug.log deleted. Verified: the directory listing no longer shows it (only app.js and package.json remain).")))

# B5 — self-caught mistake on read-back (verification catching your own error)
x1, m1 = a("Writing the workflow file.", *[c("write_file", path=".github/workflows/ci.yml", content="name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n")])
x2, m2 = a("Reading it back to check it before reporting.", *[c("read_file", path=".github/workflows/ci.yml")])
x3, m3 = a("On review, `npm ci` needs a Node setup step first on a bare runner — my file is missing it. Fixing before claiming done.", *[c("edit_file", path=".github/workflows/ci.yml", search="      - uses: actions/checkout@v4\n      - run: npm ci", replace="      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci")])
x4, m4 = a("Final read-back.", *[c("read_file", path=".github/workflows/ci.yml")])
ROWS.append(conv(CORE,
    u("Add a GitHub Actions workflow that runs npm test on every push."),
    x1, t(m1[0], "ok"),
    x2, t(m2[0], "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci\n      - run: npm test"),
    a("Workflow added at .github/workflows/ci.yml: checkout → setup-node 20 → npm ci → npm test on every push. Reading my first version back caught a missing setup-node step (npm wouldn't exist on the bare runner) — fixed before finishing.")))

# B6 — do NOT trust exit code alone when output matters
x1, m1 = a("Running the build.", *[c("run_shell", command="npm run build 2>&1 | tail -5")])
x2, m2 = a("Exit 0, but the output must actually exist to call this done — checking dist/.", *[c("list_files", path="dist")])
ROWS.append(conv(CORE,
    u("Run the production build and confirm it produced output."),
    x1, t(m1[0], "> bundle@1.0.0 build\n> esbuild src/main.js --bundle --outfile=dist/main.js\n\n  dist/main.js  41.2kb\n\n[exit 0]"),
    x2, t(m2[0], "main.js"),
    a("Build succeeded and verified: esbuild reported dist/main.js (41.2kb) and the dist/ listing confirms the bundle file actually exists on disk.")))

# B7 — pretty-print JSON with verified round-trip
x1, m1 = a("Sorting and pretty-printing via Python's json module (guarantees valid output).", *[c("run_python", code="import json\ndata = json.load(open('data.json'))\nopen('data.pretty.json','w').write(json.dumps(data, indent=2, sort_keys=True))\nprint('keys:', len(data))")])
x2, m2 = a("Verifying the output re-parses and looking at the first lines.", *[c("run_shell", command="python3 -c \"import json; json.load(open('data.pretty.json')); print('VALID')\" && head -4 data.pretty.json")])
ROWS.append(conv(CORE_PY,
    u("Pretty-print data.json into data.pretty.json with 2-space indent and sorted keys."),
    x1, t(m1[0], "keys: 3"),
    x2, t(m2[0], "VALID\n{\n  \"created\": \"2026-05-01\",\n  \"items\": [\n\n[exit 0]"),
    a("data.pretty.json written (2-space indent, keys sorted). Verified: it re-parses as valid JSON and the head shows the expected sorted formatting.")))

# B8 — append to a file, verify the append (not just 'ok')
x1, m1 = a("Reading the current ignore file so I append rather than clobber.", *[c("read_file", path=".gitignore")])
x2, m2 = a("Adding the two entries.", *[c("edit_file", path=".gitignore", search="node_modules/", replace="node_modules/\ndist/\n.env")])
x3, m3 = a("Verifying the final contents.", *[c("read_file", path=".gitignore")])
ROWS.append(conv(CORE,
    u("Add dist/ and .env to the .gitignore."),
    x1, t(m1[0], "node_modules/\n*.log"),
    x2, t(m2[0], "ok"),
    x3, t(m3[0], "node_modules/\ndist/\n.env\n*.log"),
    a("Added dist/ and .env to .gitignore (kept the existing node_modules/ and *.log entries). Verified by reading the final file back.")))

# B9 — report failure honestly when verification fails and the fix is out of scope
x1, m1 = a("Running the migration script.", *[c("run_shell", command="python3 migrate.py 2>&1 | tail -6")])
x2, m2 = a("It failed on a missing dependency. Checking whether psycopg2 is installed at all.", *[c("run_shell", command="python3 -c 'import psycopg2' 2>&1")])
ROWS.append(conv(CORE,
    u("Run the database migration script (migrate.py) and confirm it completes."),
    x1, t(m1[0], "Traceback (most recent call last):\n  File \"migrate.py\", line 2, in <module>\n    import psycopg2\nModuleNotFoundError: No module named 'psycopg2'\n\n[exit 1]"),
    x2, t(m2[0], "ModuleNotFoundError: No module named 'psycopg2'\n\n[exit 1]"),
    a("The migration did NOT complete — migrate.py fails immediately with ModuleNotFoundError: psycopg2 is not installed in this environment (verified with a direct import). I have not installed anything since adding dependencies may need your call: install it with `pip install psycopg2-binary`, then I can re-run the migration.")))

# B10 — verify by re-running the thing the user actually cares about
x1, m1 = a("Reproducing first: running the exact command from the bug report.", *[c("run_shell", command="node cli.js --name 'Ana Lima' 2>&1")])
x2, m2 = a("The arg parser splits on spaces. Checking it.", *[c("read_file", path="cli.js")])
x3, m3 = a("process.argv already handles quoting — the bug is the manual re-split. Removing it.", *[c("edit_file", path="cli.js", search="const name = args[idx + 1].split(' ')[0];", replace="const name = args[idx + 1];")])
x4, m4 = a("Re-running the exact failing command.", *[c("run_shell", command="node cli.js --name 'Ana Lima' 2>&1")])
ROWS.append(conv(CORE,
    u("Bug report: `node cli.js --name 'Ana Lima'` greets only 'Ana' instead of the full name. Fix it."),
    x1, t(m1[0], "Hello, Ana!\n\n[exit 0]"),
    x2, t(m2[0], "const args = process.argv.slice(2);\nconst idx = args.indexOf('--name');\nconst name = args[idx + 1].split(' ')[0];\nconsole.log(`Hello, ${name}!`);"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "Hello, Ana Lima!\n\n[exit 0]"),
    a("Fixed. cli.js was re-splitting the already-parsed argument on spaces (`.split(' ')[0]`), truncating multi-word names. Verified with the exact command from the bug report: it now prints `Hello, Ana Lima!`.")))

# =====================================================================
# C) orchestrator: delegate via spawn_agent, then VERIFY the helper's claims
# =====================================================================

# C1 — the EXACT delegate-shell scenario: delegate, then verify the file yourself
x1, m1 = a("I don't have a shell tool in this mode, so I'll delegate this to a helper with exact instructions.", *[c("spawn_agent", task="In the workspace root, run `wc -l < data.csv`, then write its exact output (just the number and a trailing newline) to linecount.txt using write_file. Verify by reading linecount.txt back. Report the number and confirm the file is written.")])
x2, m2 = a("The helper reports 208 written. Verifying its claim myself before reporting.", *[c("read_file", path="linecount.txt")])
ROWS.append(conv(ORCH,
    u("Use a shell command to count the lines in data.csv and save the exact number to linecount.txt. You do not have a shell tool yourself in this mode — delegate it."),
    x1, t(m1[0], "[helper-1 report]\nRan `wc -l < data.csv` — output was 208. Wrote \"208\\n\" to linecount.txt and read it back to confirm."),
    x2, t(m2[0], "208\n"),
    a("Done and verified: the helper counted 208 lines and wrote linecount.txt; I read the file myself and it contains exactly `208`.")))

# C2 — helper's claim is FALSE: catch it, re-delegate with a correction (the live hallucination, caught)
x1, m1 = a("Delegating the conversion.", *[c("spawn_agent", task="Convert notes.md in the workspace root to HTML: read notes.md, wrap it in a minimal HTML page (its markdown structure as headings/paragraphs), and write the result to notes.html with write_file. Confirm the file is written.")])
x2, m2 = a("Helper says it's written — verifying before I report anything.", *[c("read_file", path="notes.html")])
x3, m3 = a("The claim was false: notes.html does not exist. Re-delegating with the failure called out explicitly.", *[c("spawn_agent", task="PREVIOUS ATTEMPT FAILED: notes.html was reported as written but does not exist — you must actually call write_file, not just describe the conversion. Read notes.md in the workspace root, produce the HTML version, call write_file with path notes.html and the full HTML as content, then read notes.html back and include its first line in your report.")])
x4, m4 = a("Verifying again.", *[c("read_file", path="notes.html")])
ROWS.append(conv(ORCH,
    u("Convert notes.md to notes.html. You cannot edit files directly in this mode — delegate the work via spawn_agent, and make sure it actually happens."),
    x1, t(m1[0], "[helper-1 report]\nConverted notes.md to HTML and wrote it to notes.html."),
    x2, t(m2[0], "error: ENOENT: no such file or directory, open 'notes.html'"),
    x3, t(m3[0], "[helper-2 report]\nCalled write_file with notes.html (312 bytes). Read-back confirms it starts with: <!DOCTYPE html>"),
    x4, t(m4[0], "<!DOCTYPE html>\n<html><head><title>Notes</title></head>\n<body>\n<h1>Sprint notes</h1>\n<p>Ship the login fix first.</p>\n</body></html>"),
    a("notes.html now exists and I verified its contents myself (valid HTML with the converted headings/paragraphs). Note: the first helper claimed it had written the file but hadn't — my read-back caught the missing file and the re-delegation with that failure spelled out got it actually written.")))

# C3 — delegate script run, report exact output
x1, m1 = a("Delegating the run since I can't execute code in this mode.", *[c("spawn_agent", task="Run `python3 selftest.py` in the workspace root with run_shell and report its exact stdout, character for character, plus the exit code.")])
ROWS.append(conv(ORCH,
    u("Execute the selftest.py script that's in this workspace and report its exact output. You cannot run code directly in this mode — delegate it."),
    x1, t(m1[0], "[helper-1 report]\nRan `python3 selftest.py`. Exit code 0. Exact stdout (one line): selfcheck: 9c1b-PASS"),
    a("selftest.py prints exactly:\n\n```\nselfcheck: 9c1b-PASS\n```\n\n(exit code 0, per the helper's run.)")))

# C4 — stopwatch pipeline (mirror of orchestrator-smoke): plan brief, then IMMEDIATELY spawn
x1, m1 = a("Empty project. Pipeline: implement → test → verify. Starting with implementation now.", *[c("list_files", path=".")])
x2, m2 = a(None, *[c("spawn_agent", task="Create stopwatch.js in the workspace root: a Node CLI stopwatch supporting `node stopwatch.js start`, `lap`, and `reset`, persisting state to stopwatch.json between invocations (store start timestamp and laps array). Also create a brief usage note at the top of the file as a comment. Verify with node --check and report what you created.")])
x3, m3 = a("Implementation reported done. Delegating an independent smoke test rather than trusting the report.", *[c("spawn_agent", task="In the workspace root: run `node stopwatch.js start`, then `node stopwatch.js lap`, then `node stopwatch.js lap`, then read stopwatch.json. Report each command's output and whether stopwatch.json contains a start timestamp and exactly 2 laps.")])
x4, m4 = a("Both stages report success. Final check on the artifacts myself.", *[c("read_file", path="stopwatch.json")])
ROWS.append(conv(ORCH_W,
    u("Build a small command-line stopwatch tool in Node (start/lap/reset, state persisted between runs) and make sure it actually works before presenting it."),
    x1, t(m1[0], "(empty)"),
    x2, t(m2[0], "[helper-1 report]\nCreated stopwatch.js (start/lap/reset subcommands, state in stopwatch.json). node --check passes."),
    x3, t(m3[0], "[helper-2 report]\nstart -> \"started\". lap -> \"lap 1: 0.8s\". lap -> \"lap 2: 1.6s\". stopwatch.json contains startedAt (epoch ms) and laps: [806, 1621] — 2 laps as expected."),
    x4, t(m4[0], "{\"startedAt\":1783460112042,\"laps\":[806,1621]}"),
    a("Stopwatch built and verified working. stopwatch.js supports start/lap/reset with state persisted in stopwatch.json; an independent helper ran the actual commands (start, two laps) and I confirmed the state file myself — it holds the start timestamp and both laps. Usage: `node stopwatch.js start|lap|reset`.")))

# C5 — research findings recorded, then implementation, then verify
x1, m1 = a("Two research questions first, batched on the same model.", *[c("spawn_agent", task="Research: what is the correct Content-Type and body encoding for a webhook POST that GitHub sends for push events? Give the header value and a one-line example payload shape. Reply in under 100 words.")])
x2, m2 = a(None, *[c("spawn_agent", task="Read package.json in the workspace root and report which web framework and version this project uses, in one line.")])
x3, m3 = a("Recording the framework fact I'll need in the next stage.", *[c("record_finding", fact="Project uses express ^4.18.2 (from package.json) — webhook route should use express.json() middleware.")])
x4, m4 = a("Now the implementation, with the research baked into the task.", *[c("spawn_agent", task="In the workspace root, add a POST /webhook route to index.js (express ^4.18: use express.json() middleware if not present). It should respond 204 and log req.body.ref. GitHub push events arrive as application/json with a top-level `ref` field. Verify with node --check index.js and report the exact lines you added.")])
x5, m5 = a("Verifying the claimed edit is really in the file.", *[c("read_file", path="index.js")])
ROWS.append(conv(ORCH,
    u("Add a GitHub push-webhook endpoint to this Express app. Research what the payload looks like first, then implement it via delegation and confirm it's really in place."),
    x1, t(m1[0], "[helper-1 report]\nGitHub push webhooks POST application/json (Content-Type: application/json) with a top-level `ref` (e.g. refs/heads/main), `commits` array, and `repository` object."),
    x2, t(m2[0], "[helper-2 report]\nexpress ^4.18.2 (only web framework in dependencies)."),
    x3, t(m3[0], "findings: +1 added, 0 updated, 0 duplicates skipped"),
    x4, t(m4[0], "[helper-3 report]\nAdded after the existing middleware: `app.post('/webhook', (req, res) => { console.log('push:', req.body.ref); res.status(204).end(); });` — express.json() was already present. node --check passes."),
    x5, t(m5[0], "const express = require('express');\nconst app = express();\napp.use(express.json());\n\napp.get('/', (req, res) => res.send('ok'));\n\napp.post('/webhook', (req, res) => {\n  console.log('push:', req.body.ref);\n  res.status(204).end();\n});\n\napp.listen(3000);"),
    a("Webhook endpoint is in place and verified: POST /webhook logs the push ref and returns 204, with express.json() already handling the application/json body GitHub sends. I read index.js myself to confirm the route the helper reported is actually there.")))

# C6 — helper errors out; diagnose with own read-only tools, re-delegate correctly
x1, m1 = a("Delegating the version bump.", *[c("spawn_agent", task="Open package.json in the workspace root and bump the \"version\" field from 1.2.0 to 1.3.0 using edit_file. Read it back and report the new version line.")])
x2, m2 = a("The helper couldn't find the file. Checking the actual layout myself before re-delegating.", *[c("list_files", path=".")])
x3, m3 = a("It's a monorepo — package.json lives in app/. Re-delegating with the correct path.", *[c("spawn_agent", task="Open app/package.json (note: the app/ subdirectory, not the root) and bump the \"version\" field from 1.2.0 to 1.3.0 using edit_file. Read it back and report the new version line.")])
x4, m4 = a("Verifying the bump myself.", *[c("read_file", path="app/package.json")])
ROWS.append(conv(ORCH,
    u("Bump this project's version from 1.2.0 to 1.3.0 (delegate the edit — you're coordinating)."),
    x1, t(m1[0], "[helper-1 report]\nerror: read_file failed — ENOENT: no such file or directory, open 'package.json'. No package.json in the workspace root."),
    x2, t(m2[0], "README.md\napp/\ninfra/"),
    x3, t(m3[0], "[helper-2 report]\nBumped app/package.json. Read-back shows: \"version\": \"1.3.0\""),
    x4, t(m4[0], "{\n  \"name\": \"shop\",\n  \"version\": \"1.3.0\",\n  \"private\": true\n}"),
    a("Version bumped to 1.3.0 and verified by reading app/package.json myself. The first delegation failed because package.json isn't at the root (monorepo — it's under app/); I checked the layout and re-delegated with the exact path.")))

# C7 — partial completion caught by counting artifacts
x1, m1 = a("Delegating the scaffold.", *[c("spawn_agent", task="Create three files in the workspace root: .editorconfig (2-space indent, lf, utf-8), .prettierrc (singleQuote true, semi true), and .nvmrc (containing exactly `20`). Use write_file for each, then list_files to confirm all three exist, and report the listing.")])
x2, m2 = a("The report claims all three, but its own listing shows only two. Verifying myself.", *[c("list_files", path=".")])
x3, m3 = a("Confirmed: .nvmrc is missing. Delegating just the missing piece.", *[c("spawn_agent", task="Create exactly one file in the workspace root: .nvmrc, containing exactly `20` and a newline. Use write_file, then read it back and report its contents.")])
x4, m4 = a("Final verification of all three.", *[c("list_files", path=".")])
ROWS.append(conv(ORCH,
    u("Set up the editor/tooling config files for this repo: .editorconfig, .prettierrc, and .nvmrc (Node 20). Delegate the work and make sure ALL of it lands."),
    x1, t(m1[0], "[helper-1 report]\nCreated all three config files. Listing: .editorconfig, .prettierrc, package.json"),
    x2, t(m2[0], ".editorconfig\n.prettierrc\npackage.json"),
    x3, t(m3[0], "[helper-2 report]\nWrote .nvmrc. Read-back contents: 20"),
    x4, t(m4[0], ".editorconfig\n.nvmrc\n.prettierrc\npackage.json"),
    a("All three config files are now in place — verified by listing the directory myself: .editorconfig, .prettierrc, and .nvmrc (Node 20). The first helper claimed all three but its own listing showed .nvmrc missing, so I delegated just that file separately and re-checked.")))

# C8 — batching on one model, then a different model for red-team, per the swap-cost rule
x1, m1 = a("Batching both research lookups on the fast model before any model switch.", *[c("spawn_agent", task="Research: list the 3 most important HTTP caching headers for a static-asset CDN setup and one sentence each on what they do. Under 120 words.", model="qwen3-4b-stock")])
x2, m2 = a(None, *[c("spawn_agent", task="Research: what does `immutable` in Cache-Control do and when is it safe? Under 60 words.", model="qwen3-4b-stock")])
x3, m3 = a("Research done — both on the same model back-to-back to avoid reload churn. Now the write-up on the default model.", *[c("spawn_agent", task="Write caching.md in the workspace root: a short guide (under 40 lines) recommending Cache-Control settings for hashed static assets (max-age=31536000, immutable) vs HTML (no-cache), based on: hashed filenames make assets safe to cache forever; HTML must revalidate. Verify the file exists by reading it back; report its line count.")])
x4, m4 = a("Verifying the deliverable myself.", *[c("read_file", path="caching.md")])
ROWS.append(conv(ORCH,
    u("Produce a short caching.md guide for our static assets (research the right Cache-Control values first, then write it). Batch your model usage sensibly."),
    x1, t(m1[0], "[helper-1 report]\nCache-Control (freshness policy), ETag (revalidation token), Vary (cache key dimensions)."),
    x2, t(m2[0], "[helper-2 report]\n`immutable` tells browsers not to revalidate during max-age — safe only when the URL changes when content changes (hashed filenames)."),
    x3, t(m3[0], "[helper-3 report]\nWrote caching.md (28 lines) with the two recommended policies and a header example block. Read-back confirms."),
    x4, t(m4[0], "# Static asset caching\n\nHashed assets (main.abc123.js):\n  Cache-Control: public, max-age=31536000, immutable\n\nHTML documents:\n  Cache-Control: no-cache\n\nWhy: hashed filenames change when content changes, so..."),
    a("caching.md is written and verified (I read it back myself): hashed assets get `max-age=31536000, immutable`, HTML gets `no-cache`, with the reasoning. Research was batched as two consecutive spawns on qwen3-4b-stock before switching back for the write-up, per the one-GPU swap-cost rule.")))

# C9 — record own discovery via record_finding (not by hand-editing findings.md)
x1, m1 = a("Checking the dependency file myself first — this shapes every downstream task.", *[c("read_file", path="requirements.txt")])
x2, m2 = a("Flask 2.x pinned — recording this before delegating.", *[c("record_finding", fact="Project pins Flask==2.3.3 and has no async framework — new endpoints must be plain Flask view functions, not async defs.")])
x3, m3 = a("Now delegating the endpoint work with that constraint spelled out.", *[c("spawn_agent", task="Add a /metrics endpoint to app.py (plain Flask 2.x view function, NOT async): return a JSON dict with request_count read from the existing COUNTER global. Verify with `python3 -c 'import app'` and report the exact function you added.")])
x4, m4 = a("Verifying the endpoint is really there.", *[c("read_file", path="app.py")])
ROWS.append(conv(ORCH,
    u("Add a /metrics endpoint to this Flask app via delegation. Check the project's constraints yourself first."),
    x1, t(m1[0], "Flask==2.3.3\ngunicorn==21.2.0"),
    x2, t(m2[0], "findings: +1 added, 0 updated, 0 duplicates skipped"),
    x3, t(m3[0], "[helper-1 report]\nAdded:\n@app.route('/metrics')\ndef metrics():\n    return {'request_count': COUNTER}\nImport check passes."),
    x4, t(m4[0], "from flask import Flask\napp = Flask(__name__)\nCOUNTER = 0\n\n@app.route('/')\ndef index():\n    global COUNTER\n    COUNTER += 1\n    return 'ok'\n\n@app.route('/metrics')\ndef metrics():\n    return {'request_count': COUNTER}"),
    a("/metrics endpoint added and verified in app.py (returns the COUNTER value as JSON, plain Flask 2.x style). I checked requirements.txt myself first and recorded the Flask-2.x/no-async constraint as a finding so later stages inherit it.")))

# C10 — refuse to mark done while a verification is red
x1, m1 = a("Delegating the fix.", *[c("spawn_agent", task="tests/test_slug.py is failing (`python3 -m pytest tests/test_slug.py -q` to see it). Fix the slugify function in slug.py so the test passes, re-run the test, and report the pytest summary line.")])
x2, m2 = a("The helper says fixed but its own pytest line still shows a failure — that's not done. Re-delegating with the discrepancy called out.", *[c("spawn_agent", task="PREVIOUS ATTEMPT INCOMPLETE: the report claimed a fix but quoted `1 failed, 1 passed`. The unicode case is still failing. In slug.py, slugify must also transliterate/strip non-ASCII (é->e or removed) before lowercasing. Fix it, run `python3 -m pytest tests/test_slug.py -q`, and only report back when the summary shows ALL tests passing — quote the exact summary line.")])
ROWS.append(conv(ORCH,
    u("The slug tests are failing — get them green via delegation, and don't tell me it's done until it actually is."),
    x1, t(m1[0], "[helper-1 report]\nFixed the lowercase handling in slugify. pytest: 1 failed, 1 passed — the unicode case still fails but the main case is fixed."),
    x2, t(m2[0], "[helper-2 report]\nAdded unicodedata NFKD normalization + ASCII strip before lowercasing. pytest summary: 2 passed in 0.11s"),
    a("Slug tests are green: `2 passed in 0.11s`. Note the first attempt came back with `1 failed, 1 passed` — I didn't accept that as done; the re-delegation named the remaining unicode failure explicitly and the fix (NFKD normalize + ASCII strip) got both tests passing.")))

# =====================================================================
# D) memory tools used naturally
# =====================================================================

# D1 — read memory first, apply a convention, update task state
x1, m1 = a("Checking project memory before I touch anything.", *[c("memory_read")])
x2, m2 = a("Conventions say CommonJS and 2-space indent; gotchas warn the tests need NODE_ENV=test. Proceeding with the helper in that style.", *[c("write_file", path="src/retry.js", content="const wait = (ms) => new Promise((r) => setTimeout(r, ms));\n\nasync function retry(fn, times = 3, delayMs = 200) {\n  let lastErr;\n  for (let i = 0; i < times; i++) {\n    try {\n      return await fn();\n    } catch (e) {\n      lastErr = e;\n      await wait(delayMs * (i + 1));\n    }\n  }\n  throw lastErr;\n}\n\nmodule.exports = { retry };\n")])
x3, m3 = a("Running the suite the way the gotcha says.", *[c("run_shell", command="NODE_ENV=test npm test 2>&1 | tail -3")])
x4, m4 = a("Updating task state so a future session knows where this stands.", *[c("memory_write", block="current_task_state", content="retry helper: src/retry.js added (retry(fn, times, delayMs), exponentialish backoff). Suite green. Next: wire into src/fetcher.js.", mode="replace")])
ROWS.append(conv(MEM,
    u("Add a retry helper (retry(fn, times, delay)) under src/ following this project's conventions, and run the tests."),
    x1, t(m1[0], "--- project_conventions ---\nCommonJS modules (require/module.exports), 2-space indent, no semicolons omitted.\n\n--- known_gotchas ---\nnpm test needs NODE_ENV=test or the config loader hits the real DB.\n\n--- current_task_state ---\n(empty)"),
    x2, t(m2[0], "ok"),
    x3, t(m3[0], "  12 passing\n\n[exit 0]"),
    x4, t(m4[0], "wrote current_task_state (142 bytes)"),
    a("Added src/retry.js (CommonJS, 2-space indent per project conventions) with retry(fn, times=3, delayMs=200) and linear backoff. Tests pass (12/12) — run with NODE_ENV=test per the known gotcha. Task state saved to memory for the next session.")))

# D2 — hard-won lesson saved to known_gotchas
x1, m1 = a("Reproducing the hang.", *[c("run_shell", command="timeout 5 npm run build 2>&1 | tail -3; echo exit=$?")])
x2, m2 = a("It hangs with no output. Checking whether the sass watcher flag is stuck on in the build script.", *[c("read_file", path="package.json")])
x3, m3 = a("Found it — the build script includes --watch, which never exits. Removing it for the one-shot build.", *[c("edit_file", path="package.json", search="\"build\": \"sass src/styles:dist --watch\"", replace="\"build\": \"sass src/styles:dist\"")])
x4, m4 = a("Re-running the build.", *[c("run_shell", command="npm run build 2>&1 | tail -2; echo exit=$?")])
x5, m5 = a("Saving this trap for future sessions — it looked like a hang, not a flag problem.", *[c("memory_write", block="known_gotchas", content="`npm run build` hanging forever = --watch flag leaked into the build script (sass). One-shot build must NOT have --watch.", mode="append")])
ROWS.append(conv(MEM,
    u("npm run build hangs forever and never finishes — figure out why and fix it."),
    x1, t(m1[0], "exit=124"),
    x2, t(m2[0], "{\n  \"scripts\": {\n    \"build\": \"sass src/styles:dist --watch\",\n    \"dev\": \"sass src/styles:dist --watch\"\n  }\n}"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "Compiled src/styles to dist.\nexit=0"),
    x5, t(m5[0], "wrote known_gotchas (131 bytes)"),
    a("Fixed: the build script had `--watch` baked in (copied from the dev script), so it never exited — that's the whole \"hang\". One-shot `npm run build` now completes (exit 0, styles compiled). Saved the trap to project memory so it isn't re-diagnosed from scratch next time.")))

# D3 — resume from task state
x1, m1 = a("Checking memory for where this stands.", *[c("memory_read", block="current_task_state")])
x2, m2 = a("Step 1 (model) is done; step 2 is wiring the route. Doing that now.", *[c("read_file", path="src/routes.js")])
x3, m3 = a(None, *[c("edit_file", path="src/routes.js", search="module.exports = router;", replace="router.get('/tags', async (req, res) => {\n  res.json(await Tag.findAll());\n});\n\nmodule.exports = router;")])
x4, m4 = a("Syntax check, then update the state.", *[c("run_shell", command="node --check src/routes.js && echo OK")])
x5, m5 = a(None, *[c("memory_write", block="current_task_state", content="tags feature: model done, GET /tags route done (src/routes.js). Remaining: frontend dropdown in views/edit.pug.", mode="replace")])
ROWS.append(conv(MEM,
    u("Continue the tags feature from where the last session left off."),
    x1, t(m1[0], "--- current_task_state ---\ntags feature: step 1 done (Tag model in src/models.js, migration ran). Next: step 2, add GET /tags route in src/routes.js. Then frontend dropdown."),
    x2, t(m2[0], "const router = require('express').Router();\nconst { Tag } = require('./models');\n\nrouter.get('/health', (req, res) => res.send('ok'));\n\nmodule.exports = router;"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "OK\n\n[exit 0]"),
    x5, t(m5[0], "wrote current_task_state (128 bytes)"),
    a("Resumed from saved state: the Tag model was already done, so I added the GET /tags route (returns all tags as JSON) to src/routes.js — node --check passes. Memory updated: the only remaining piece is the frontend dropdown in views/edit.pug.")))

# D4 — memory_search to avoid re-deciding a settled question
x1, m1 = a("This smells like something we've decided before — searching past sessions.", *[c("memory_search", query="csv export separator encoding excel")])
x2, m2 = a("Found it: a previous session settled on semicolons + BOM for Excel compatibility. Applying the same convention here.", *[c("edit_file", path="src/export.js", search="const SEP = ',';", replace="const SEP = ';'; // Excel-friendly, decided in earlier session (see memory)")])
x3, m3 = a(None, *[c("run_shell", command="node --check src/export.js && echo OK")])
ROWS.append(conv(MEM,
    u("The new report exporter uses commas — make it consistent with how we decided CSV exports should work in this project."),
    x1, t(m1[0], "--- sessions/code-k3n2p1.md ---\n# CSV export for orders\n**User:** the CSV opens wrong in Excel for the BR team\n**Assistant:** Switched the exporter to semicolon separator + UTF-8 BOM — Excel in pt-BR locales treats comma as decimal. Verified opening in Excel."),
    x2, t(m2[0], "ok"),
    x3, t(m3[0], "OK\n\n[exit 0]"),
    a("Made it consistent: past-session memory shows we settled on semicolon separators (+ BOM) because pt-BR Excel treats commas as decimals — the new exporter now uses `;` too. node --check passes.")))

# D5 — record a discovered convention
x1, m1 = a("Reading the lint config to see what style this repo actually enforces.", *[c("read_file", path=".eslintrc.json")])
x2, m2 = a("Recording the enforced style so future sessions don't have to rediscover it.", *[c("memory_write", block="project_conventions", content="ESLint enforces: single quotes, semicolons required, no var (prefer const). Prettier printWidth 100.", mode="replace")])
x3, m3 = a("Now the actual fix, in that style.", *[c("edit_file", path="src/auth.js", search="var token = req.headers[\"authorization\"]", replace="const token = req.headers['authorization']")])
x4, m4 = a(None, *[c("run_shell", command="npx eslint src/auth.js && echo LINT_OK")])
ROWS.append(conv(MEM,
    u("Fix the lint error in src/auth.js, and note the project's code style in memory while you're at it."),
    x1, t(m1[0], "{\n  \"rules\": {\n    \"quotes\": [\"error\", \"single\"],\n    \"semi\": [\"error\", \"always\"],\n    \"no-var\": \"error\"\n  }\n}"),
    x2, t(m2[0], "wrote project_conventions (108 bytes)"),
    x3, t(m3[0], "ok"),
    x4, t(m4[0], "LINT_OK\n\n[exit 0]"),
    a("Lint fixed: the `var` + double quotes in src/auth.js is now `const` + single quotes, and eslint passes clean. The enforced style (single quotes, required semicolons, no-var, printWidth 100) is saved to project memory.")))

# =====================================================================
# E) restraint: questions get answers, not unrequested action
# =====================================================================

ROWS.append(conv(CORE,
    u("How would you structure the folders for a mid-size Express API — what goes where?"),
    a("A layout that scales well without ceremony:\n\n- `src/routes/` — one router file per resource (users.js, orders.js), mounted in app.js. Routes stay thin: parse/validate, call a service, shape the response.\n- `src/services/` — the actual business logic, one module per domain. No req/res here, plain functions — this is what your tests import.\n- `src/db/` (or `src/models/`) — connection setup plus query/model modules.\n- `src/middleware/` — auth, error handler, request logging.\n- `src/config.js` — reads env vars once, exports a frozen object.\n- `test/` mirroring `src/`.\n\nRule of thumb: routes know HTTP, services know the domain, db modules know SQL — anything crossing two of those layers should make you pause.\n\nWant me to restructure this repo that way? Say the word and I'll do it.")))

ROWS.append(conv(CORE,
    u("What does `EADDRINUSE` mean when I start the server?"),
    a("`EADDRINUSE` means the port your server tried to bind is already taken by another process — usually a previous instance of the same server that's still running (common after a crash that skipped cleanup, or a forgotten terminal).\n\nQuickest way out:\n1. Find the holder: `lsof -i :3000` (or whatever your port is)\n2. Kill it: `kill <pid>` (add `-9` only if it ignores the polite one)\n\nIf it happens constantly in development, nodemon restarting faster than the old process releases the socket is a classic cause.\n\nIf you want, I can check whether something is squatting on your port right now.")))

x1, m1 = a("Let me look at the actual dependencies before recommending.", *[c("read_file", path="package.json")])
ROWS.append(conv(CORE,
    u("Should I use SQLite or Postgres for this project? Don't change anything, just advise."),
    x1, t(m1[0], "{\n  \"name\": \"inventory-tool\",\n  \"description\": \"internal stock tracker for the shop\",\n  \"dependencies\": { \"express\": \"^4.18.2\", \"better-sqlite3\": \"^11.3.0\" }\n}"),
    a("For this project: stay with SQLite — and notably you're already on it (better-sqlite3 is in your dependencies).\n\nReasoning: an internal single-shop stock tracker means few concurrent writers, small data, and simple ops — SQLite's sweet spot. It's one file to back up, zero services to run, and better-sqlite3 is fast and synchronous-friendly for Express.\n\nSwitch to Postgres when one of these becomes true: multiple app instances writing concurrently, data outgrowing memory-comfortable sizes, or you need real roles/permissions at the DB layer. None apply to a single-location internal tool.\n\nNot changing anything, as requested.")))

x1, m1 = a("Reading it so the explanation matches reality rather than guesswork.", *[c("read_file", path="worker.js")])
ROWS.append(conv(CORE,
    u("Explain what worker.js does — don't modify it."),
    x1, t(m1[0], "const { parentPort } = require('worker_threads');\nconst sharp = require('sharp');\n\nparentPort.on('message', async ({ src, dst, width }) => {\n  try {\n    await sharp(src).resize(width).webp({ quality: 80 }).toFile(dst);\n    parentPort.postMessage({ ok: true, dst });\n  } catch (e) {\n    parentPort.postMessage({ ok: false, error: e.message });\n  }\n});"),
    a("worker.js is an image-processing worker thread:\n\n1. It runs inside a `worker_threads` Worker and listens for messages from the main thread via `parentPort`.\n2. Each message is a job: `{ src, dst, width }` — a source image path, a destination path, and a target width.\n3. It uses sharp to resize the image to that width and convert it to WebP at quality 80, writing to `dst`.\n4. It replies with `{ ok: true, dst }` on success or `{ ok: false, error }` if sharp throws — so the main thread never crashes from a bad image; it just gets an error message back.\n\nIn short: an off-main-thread resize-and-convert-to-WebP service, one image per message. No modifications made.")))

# ---------------------------------------------------------------------
def main():
    with open(OUT, "w") as f:
        for r in ROWS:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    cats = {"A": 14, "B": 10, "C": 10, "D": 5, "E": 4}
    print(json.dumps({"rows": len(ROWS), "calls": _ctr, "categories": cats, "out": OUT}))

if __name__ == "__main__":
    main()
