// Workspace-scoped tool executor shared by the agentic benchmark suite (graders.ts)
// and the agentic chat UI (Phase 4). Read tools are safe to auto-run; write/edit/shell
// are flagged via `approve` so callers can gate them behind human confirmation.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import vm from "node:vm";
import { structuralSummary } from "./ast-cache";

// Auto-verification after every write_file/edit_file: catches syntax errors the
// SAME turn they're introduced, fed back as part of the tool result — no reliance
// on the model thinking to check itself. Motivated by two real failures (2026-07-07
// snake-roguelike eval): a file with the same `const` redeclared 4x in one scope,
// and a garbled `main(); === 'ArrowUp'...` mid-statement fragment from a botched
// edit_file — both are mechanically detectable and both slipped through as
// "done" with nothing ever parsing the result. Best-effort/silent for anything
// not covered (css, md, unknown extensions) — this is a safety net, not a linter.
function verifySyntax(p: string, content: string): string | null {
  const ext = path.extname(p).toLowerCase();
  try {
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      new vm.Script(content, { filename: p });
      return null;
    }
    if (ext === ".json") {
      JSON.parse(content);
      return null;
    }
    if (ext === ".html" || ext === ".htm") {
      // Only inline, non-module scripts — vm.Script doesn't parse ES module
      // import/export syntax, and external <script src> has nothing to check here.
      const scripts = content.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*\btype=["']module["'])[^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of scripts) {
        const code = m[1];
        if (!code.trim()) continue;
        new vm.Script(code, { filename: p + " (inline <script>)" });
      }
      return null;
    }
    if (ext === ".py") {
      const r = spawnSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", p], { timeout: 5000 });
      if (r.status !== 0) return (r.stderr?.toString() || "python syntax error").trim().slice(0, 500);
      return null;
    }
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

export type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export const TOOL_DEFS: ToolDef[] = [
  { type: "function", function: {
    name: "list_files", description: "List files and directories under a path (relative to the workspace root).",
    parameters: { type: "object", properties: { path: { type: "string", description: "directory, relative to workspace root; default '.'" } } },
  } },
  { type: "function", function: {
    name: "read_file", description: "Read a text file's contents.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  } },
  { type: "function", function: {
    name: "read_file_outline", description: "Get a compact structural outline of a TS/JS/Python file (imports, top-level functions/classes with line ranges, class methods) instead of its full contents — much cheaper than read_file for orienting in a large file before deciding what to actually read or edit. Falls back to noting the file needs a full read_file if outlining isn't supported for its language.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  } },
  { type: "function", function: {
    name: "write_file", description: "Create or overwrite a text file.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  } },
  { type: "function", function: {
    name: "edit_file", description: "Replace the first exact-match occurrence of `search` with `replace` in a file.",
    parameters: { type: "object", properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } }, required: ["path", "search", "replace"] },
  } },
  { type: "function", function: {
    name: "grep", description: "Search file contents under a directory for a regex pattern.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "directory to search, default '.'" } }, required: ["pattern"] },
  } },
  { type: "function", function: {
    name: "run_shell", description: "Run a bash command in the workspace (60s timeout).",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  } },
  { type: "function", function: {
    name: "git", description: "Run a git command in the project root. Pass the subcommand and its arguments separately, e.g. {command:\"status\"}, {command:\"log\",args:[\"--oneline\",\"-10\"]}, {command:\"commit\",args:[\"-m\",\"fix bug\"]}. Read-only commands (status, diff, log, show, branch, remote -v, describe, blame, stash list) run immediately. Commands that change history, the working tree, or a remote (commit, push, merge, rebase, reset, checkout, clean, branch -d, stash drop/pop, tag -d, fetch, pull) ask for approval first. Force-pushing to main/master and bypassing hooks/signing (--no-verify, --no-gpg-sign) are refused outright, not just gated.",
    parameters: { type: "object", properties: {
      command: { type: "string", description: "git subcommand, e.g. status, diff, log, commit, push, pull, fetch, branch, checkout, merge, rebase, reset, stash, tag, remote, show, blame, clone" },
      args: { type: "array", items: { type: "string" }, description: "additional arguments/flags in order, e.g. [\"-m\", \"commit message\"]" },
    }, required: ["command"] },
  } },
];

// ---- git safety classification ----
// Default-deny on mutation: only an explicit allowlist of read-only subcommands
// (or read-only USES of an otherwise-mutating subcommand) skips the approval gate.
// Everything else — including any subcommand not recognized at all — requires
// human approval, which is the safe direction to fail in.
const GIT_READONLY_COMMANDS = new Set([
  "status", "diff", "log", "show", "describe", "blame", "ls-files",
  "rev-parse", "shortlog", "reflog", "diff-tree", "cat-file", "name-rev",
  "merge-base", "rev-list", "whatchanged", "grep",
]);
const GIT_CONDITIONAL_READONLY: Record<string, (args: string[]) => boolean> = {
  branch: (a) => !a.some((x) => ["-d", "-D", "-m", "-M", "--delete", "--move"].includes(x)),
  remote: (a) => a.length === 0 || ["-v", "--verbose", "show", "get-url"].includes(a[0]),
  tag: (a) => !a.includes("-d") && !a.includes("--delete"),
  stash: (a) => a.length === 0 || ["list", "show"].includes(a[0]),
  config: (a) => a.some((x) => ["--get", "--list", "-l", "--get-all"].includes(x)) && !a.includes("--unset"),
  submodule: (a) => a[0] === "status" || a[0] === "summary",
};

function gitIsReadonly(command: string, args: string[]): boolean {
  if (GIT_READONLY_COMMANDS.has(command)) return true;
  const cond = GIT_CONDITIONAL_READONLY[command];
  return cond ? cond(args) : false;
}

// Hard blocks fire regardless of approval — these mirror this operator's own
// standing git-safety rules (never force-push main/master, never skip hooks or
// signing without being explicitly asked in the conversation itself, which an
// autonomous tool call can't verify, so it's refused rather than gated).
function gitHardBlock(command: string, args: string[]): string | null {
  if (args.includes("--no-verify")) return "refusing to run with --no-verify — hooks must not be skipped by the agent.";
  if (args.includes("--no-gpg-sign")) return "refusing to run with --no-gpg-sign.";
  if (args.some((a) => /gpgsign\s*=\s*false/i.test(a))) return "refusing to run with commit signing disabled.";
  if (command === "push" && args.some((a) => a === "--force" || a === "-f" || a === "--force-with-lease")) {
    const positional = args.filter((a) => !a.startsWith("-"));
    const targetsMainMaster = positional.some((a) => /(^|\/)(main|master)$/.test(a));
    const noExplicitBranch = positional.length <= 1; // just a remote name, or nothing -> current branch
    if (targetsMainMaster || noExplicitBranch) {
      return "refusing to force-push to main/master (or the current branch with no explicit target) — do this manually in a terminal if truly intended.";
    }
  }
  return null;
}

export function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const cap = 16384;
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      // argv array, not a shell string — no quoting/injection surface for
      // commit messages or branch names containing spaces/special characters.
      child = spawn("git", args, {
        cwd: root,
        env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
      });
    } catch (e) {
      resolve("error: " + (e as Error).message);
      return;
    }
    const append = (d: Buffer) => { if (out.length < cap) out += d.toString(); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let done = false;
    const finish = (msg: string) => { if (done) return; done = true; resolve((msg || "(no output)").slice(0, cap)); };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(out + "\n[timed out after 30s]");
    }, 30000);
    child.on("close", (code) => { clearTimeout(timer); finish(out + (code ? `\n[exit ${code}]` : "")); });
    child.on("error", (e) => { clearTimeout(timer); finish("error: " + e.message); });
  });
}

// Resolve `rel` against `root`, rejecting any escape — via literal ".." segments
// (lexical check) or via a symlink inside the workspace pointing outside it
// (realpath check on the nearest existing ancestor).
export function resolveSafe(root: string, rel: string): string {
  const target = path.resolve(root, rel || ".");
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("path escapes workspace: " + rel);
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  const rootReal = fs.realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error("path escapes workspace (symlink): " + rel);
  return target;
}

function runShell(root: string, command: string): Promise<string> {
  return new Promise((resolve) => {
    const cap = 16384;
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("bash", ["-c", command], { cwd: root, detached: true });
    } catch (e) {
      resolve("error: " + (e as Error).message);
      return;
    }
    const append = (d: Buffer) => { if (out.length < cap) out += d.toString(); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let done = false;
    const finish = (msg: string) => { if (done) return; done = true; resolve(msg.slice(0, cap)); };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      finish(out + "\n[timed out after 60s]");
    }, 60000);
    child.on("close", (code) => { clearTimeout(timer); finish(out + `\n[exit ${code}]`); });
    child.on("error", (e) => { clearTimeout(timer); finish("error: " + e.message); });
  });
}

// A tool's approval rule is either a fixed boolean or a function of its call
// args — git needs the latter (read-only subcommands shouldn't need a click
// every time; mutating ones should), everything else so far is fixed.
export type ApproveRule = boolean | ((args: Record<string, unknown>) => boolean);
export type Executor = {
  root: string;
  approve: Record<string, ApproveRule>; // tools requiring human approval before running
  run: (name: string, args: Record<string, unknown>) => Promise<string>;
};

export function makeExecutor(workspaceDir: string): Executor {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const root = fs.realpathSync(workspaceDir);

  async function run(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "list_files": {
          const dir = resolveSafe(root, String(args.path ?? "."));
          const ents = fs.readdirSync(dir, { withFileTypes: true });
          return ents.map((e) => e.name + (e.isDirectory() ? "/" : "")).sort().join("\n") || "(empty)";
        }
        case "read_file": {
          const p = resolveSafe(root, String(args.path ?? ""));
          return fs.readFileSync(p, "utf8").slice(0, 32768);
        }
        case "read_file_outline": {
          const rel = String(args.path ?? "");
          resolveSafe(root, rel); // throws on escape/missing, same guard as read_file
          const summary = await structuralSummary(root, rel);
          return summary ?? `(no structural outline available for "${rel}" — unsupported language or parse failed; use read_file for the full contents)`;
        }
        case "write_file": {
          const p = resolveSafe(root, String(args.path ?? ""));
          fs.mkdirSync(path.dirname(p), { recursive: true });
          const content = String(args.content ?? "");
          fs.writeFileSync(p, content);
          const warn = verifySyntax(p, content);
          return warn ? `ok, but the file has a syntax error: ${warn} — the file WAS written as-is; fix it now before considering this done` : "ok";
        }
        case "edit_file": {
          const p = resolveSafe(root, String(args.path ?? ""));
          const src = fs.readFileSync(p, "utf8");
          const search = String(args.search ?? "");
          const idx = search ? src.indexOf(search) : -1;
          if (idx === -1) return "error: search string not found";
          // Splice by index rather than String.replace(search, replacement): replace()
          // special-cases "$1"/"$&"/"$$" etc. in the REPLACEMENT string even when the
          // search value is a plain string — any real code containing a literal "$"
          // (shell vars, regex, jQuery, template refs) silently corrupted the file.
          const replacement = String(args.replace ?? "");
          const next = src.slice(0, idx) + replacement + src.slice(idx + search.length);
          fs.writeFileSync(p, next);
          // Show the model what the file ACTUALLY looks like around its edit (±3
          // lines, numbered) instead of a bare "ok" — repeated blind edits are how
          // both eval models corrupted files (2026-07-07): they trusted their
          // memory of intent, never the real resulting text.
          const startLine = next.slice(0, idx).split("\n").length; // 1-based first line of the replacement
          const endLine = startLine + (replacement.split("\n").length - 1);
          const lines = next.split("\n");
          const from = Math.max(0, startLine - 1 - 3);
          const to = Math.min(lines.length, endLine + 3);
          const excerpt = lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join("\n").slice(0, 2000);
          const warn = verifySyntax(p, next);
          return (warn
            ? `ok, but the file has a syntax error: ${warn} — the file WAS written as-is; fix it now before considering this done`
            : "ok") + `\nfile now reads (lines ${from + 1}-${to}):\n${excerpt}`;
        }
        case "grep": {
          const dir = resolveSafe(root, String(args.path ?? "."));
          const re = new RegExp(String(args.pattern ?? ""));
          const hits: string[] = [];
          const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) { walk(p); continue; }
              try {
                fs.readFileSync(p, "utf8").split("\n").forEach((l, i) => {
                  if (re.test(l)) hits.push(`${path.relative(root, p)}:${i + 1}: ${l.slice(0, 200)}`);
                });
              } catch {}
            }
          };
          walk(dir);
          return hits.slice(0, 200).join("\n") || "(no matches)";
        }
        case "run_shell":
          return await runShell(root, String(args.command ?? ""));
        case "git": {
          const command = String(args.command ?? "").trim();
          if (!command) return "error: missing command";
          const gitArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
          const blocked = gitHardBlock(command, gitArgs);
          if (blocked) return "error: " + blocked;
          return await runGit(root, [command, ...gitArgs]);
        }
        default:
          return "error: unknown tool " + name;
      }
    } catch (e) {
      return "error: " + (e as Error).message;
    }
  }

  return {
    root,
    approve: {
      write_file: true,
      edit_file: true,
      run_shell: true,
      git: (args: Record<string, unknown>) => {
        const command = String(args.command ?? "");
        const gitArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
        return !gitIsReadonly(command, gitArgs);
      },
    },
    run,
  };
}
