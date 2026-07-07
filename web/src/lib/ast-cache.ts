// AST-aware structural file summaries (inspired by the real project NickCirv/engram's
// mechanism — NOT a dependency on it, just the idea: cut the token cost of repeated
// read_file/grep calls in long agent sessions by substituting a compact outline for the
// full file). WASM-based (web-tree-sitter + tree-sitter-wasms) deliberately — no native
// compile step, so this stays portable to "any machine" per the project's own constraint;
// the native `tree-sitter` npm bindings need a per-platform build and were avoided for
// exactly that reason.
//
// Cache invalidation is free by construction: the key is a content hash, so an edit
// produces a new key and the old entry is simply never looked up again — no explicit
// invalidation logic needed. Returns null on any unsupported/failed parse; callers must
// fall back to a plain read in that case, so this can never make read_file behave worse
// than today.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type SyntaxNode = {
  type: string;
  startPosition: { row: number };
  endPosition: { row: number };
  childForFieldName(name: string): SyntaxNode | null;
  namedChildren: SyntaxNode[];
  text: string;
};
type Tree = { rootNode: SyntaxNode };
type Language = unknown;
type ParserLike = { setLanguage(lang: Language): unknown; parse(code: string): Tree | null };

const GRAMMAR_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
  ".py": "python",
};

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Language>();
let ParserCtor: ({ new (): ParserLike }) & { init(): Promise<void>; Language: { load(p: string): Promise<Language> } } | null = null;

// Pinned to 0.20.8 deliberately (not latest): tree-sitter-wasms' prebuilt grammars were
// built with tree-sitter-cli 0.20.x and lack the dylink metadata section web-tree-sitter
// 0.25+ requires to load external-language wasm — confirmed by hitting exactly that
// failure ("getDylinkMetadata") against the latest version. 0.20.8's older CJS-shaped
// API (default export IS the Parser constructor, with .init()/.Language attached as
// static members, rather than 0.26's named { Parser, Language } exports) is what's used
// below; don't "helpfully" upgrade this package without re-verifying wasm compatibility.
async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import("web-tree-sitter");
      ParserCtor = (mod as unknown as { default: typeof ParserCtor }).default;
      await ParserCtor!.init();
    })();
  }
  return initPromise;
}

// Resolved via a STATIC require.resolve target (package.json — no template variable)
// then a plain path.join for the actual grammar file. A dynamic
// `require.resolve(`...${name}...`)` makes webpack's static analysis treat the whole
// containing directory as a "context module" and try to statically include EVERY file
// in tree-sitter-wasms/out/ — dozens of grammars we never use, several of whose
// .loader.mjs companions import wasm-loader-specific pseudo-modules ("env",
// "WASM_PATH") no bundler config here resolves, breaking the build outright.
// `serverExternalPackages` (next.config.ts) does NOT suppress this on its own — it
// only externalizes the package's own code, not a dynamic require.resolve inside ours.
let wasmDir: string | null = null;
function resolveWasmDir(): string {
  if (!wasmDir) wasmDir = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
  return wasmDir;
}

async function loadGrammar(name: string): Promise<Language | null> {
  const cached = languageCache.get(name);
  if (cached) return cached;
  try {
    const wasmPath = path.join(resolveWasmDir(), `tree-sitter-${name}.wasm`);
    const lang = await ParserCtor!.Language.load(wasmPath);
    languageCache.set(name, lang);
    return lang;
  } catch {
    return null; // grammar not bundled for this language, or a version-skew load failure — caller falls back to plain read
  }
}

// path -> { hash, summary }. Deliberately unbounded across paths (a session touches at
// most a few hundred files) but only ever ONE entry per path — an edit's new hash simply
// replaces the old entry, so this can't grow with edit history the way a real cache-with-
// history would.
const cache = new Map<string, { hash: string; summary: string }>();

const MAX_LINES = 60;

function jsLikeOutline(root: SyntaxNode): string[] {
  const lines: string[] = [];
  for (const node of root.namedChildren) {
    if (lines.length >= MAX_LINES) break;
    const range = `L${node.startPosition.row + 1}-${node.endPosition.row + 1}`;
    switch (node.type) {
      case "import_statement":
        lines.push(node.text.split("\n")[0].slice(0, 100));
        break;
      case "function_declaration": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        lines.push(`function ${name}(...) — ${range}`);
        break;
      }
      case "class_declaration": {
        const name = node.childForFieldName("name")?.text ?? "(anonymous)";
        lines.push(`class ${name} — ${range}`);
        const body = node.childForFieldName("body");
        for (const member of body?.namedChildren ?? []) {
          if (lines.length >= MAX_LINES) break;
          if (member.type === "method_definition") {
            const mname = member.childForFieldName("name")?.text ?? "(anonymous)";
            const mrange = `L${member.startPosition.row + 1}-${member.endPosition.row + 1}`;
            lines.push(`  method ${mname}(...) — ${mrange}`);
          }
        }
        break;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        const decl = node.namedChildren[0];
        const name = decl?.childForFieldName("name")?.text;
        if (name) lines.push(`const ${name} — L${node.startPosition.row + 1}`);
        break;
      }
      case "export_statement": {
        // recurse one level into `export function foo` / `export class Foo` / `export const x`
        const inner = node.namedChildren.find((c) => c.type !== "export_clause");
        if (inner) lines.push(...jsLikeOutline({ ...root, namedChildren: [inner] } as SyntaxNode));
        break;
      }
      default:
        break;
    }
  }
  return lines;
}

function pythonOutline(root: SyntaxNode): string[] {
  const lines: string[] = [];
  for (const node of root.namedChildren) {
    if (lines.length >= MAX_LINES) break;
    const range = `L${node.startPosition.row + 1}-${node.endPosition.row + 1}`;
    if (node.type === "import_statement" || node.type === "import_from_statement") {
      lines.push(node.text.split("\n")[0].slice(0, 100));
    } else if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      lines.push(`def ${name}(...) — ${range}`);
    } else if (node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      lines.push(`class ${name} — ${range}`);
      const body = node.childForFieldName("body");
      for (const member of body?.namedChildren ?? []) {
        if (lines.length >= MAX_LINES) break;
        if (member.type === "function_definition") {
          const mname = member.childForFieldName("name")?.text ?? "(anonymous)";
          const mrange = `L${member.startPosition.row + 1}-${member.endPosition.row + 1}`;
          lines.push(`  def ${mname}(...) — ${mrange}`);
        }
      }
    }
  }
  return lines;
}

export async function structuralSummary(root: string, relPath: string): Promise<string | null> {
  const ext = path.extname(relPath).toLowerCase();
  const grammarName = GRAMMAR_BY_EXT[ext];
  if (!grammarName) return null;

  const abs = path.resolve(root, relPath);
  let content: string;
  try { content = fs.readFileSync(abs, "utf8"); } catch { return null; }

  const hash = crypto.createHash("sha1").update(content).digest("hex");
  const cached = cache.get(abs);
  if (cached && cached.hash === hash) return cached.summary;

  try {
    await ensureInit();
    const lang = await loadGrammar(grammarName);
    if (!lang || !ParserCtor) return null;
    const parser = new ParserCtor();
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    if (!tree) return null;
    const outline = grammarName === "python" ? pythonOutline(tree.rootNode) : jsLikeOutline(tree.rootNode);
    if (!outline.length) return null; // e.g. a file with no top-level declarations — not worth an outline
    const summary = `structural outline of ${relPath} (${content.split("\n").length} lines total):\n` + outline.join("\n");
    cache.set(abs, { hash, summary });
    return summary;
  } catch {
    return null; // parse failure — caller falls back to a plain read
  }
}
