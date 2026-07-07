"use client";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

function flatten(children: unknown): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(flatten).join("");
  return "";
}

function CodeCopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      title="copy"
      onClick={async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); } catch {}
      }}
      className="absolute top-1.5 right-1.5 p-1 rounded text-[var(--muted)] hover:text-[var(--text-2)] bg-[var(--surface-1)]/80"
    >
      {ok ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

// Render markdown (bold, headings, lists, links, inline/code) compactly on the
// dark theme. Fenced code blocks get their own copy button — shared by /chat and
// /code so both surfaces render replies with the same quality.
export default function MarkdownView({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        ul: ({ children }) => <ul className="list-disc ml-5 my-2 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal ml-5 my-2 space-y-1">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        h1: ({ children }) => <h1 className="text-base font-semibold text-white mt-3 mb-1.5">{children}</h1>,
        h2: ({ children }) => <h2 className="text-sm font-semibold text-white mt-3 mb-1.5">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold text-white mt-2 mb-1">{children}</h3>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer" className="text-[var(--accent-ai)] underline break-all">{children}</a>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-[var(--border-loud)] pl-3 my-2 text-[var(--muted)]">{children}</blockquote>
        ),
        code: ({ className, children }) => {
          const block = /language-/.test(className ?? "");
          if (!block) return <code className="bg-[var(--surface-2)] px-1 py-0.5 rounded text-[12px] font-mono">{children}</code>;
          const code = flatten(children).replace(/\n$/, "");
          const lang = /language-(\w+)/.exec(className ?? "")?.[1] ?? "";
          return (
            <div className="relative my-2 rounded-lg border border-[var(--border-soft)] overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1 bg-[var(--surface-1)] text-[10px] text-[var(--muted)]">
                {lang || "code"}
              </div>
              <code className="block bg-[var(--surface-2)] p-3 text-[11px] font-mono overflow-x-auto whitespace-pre">{code}</code>
              <CodeCopyBtn text={code} />
            </div>
          );
        },
        pre: ({ children }) => <>{children}</>,
        hr: () => <hr className="my-3 border-[var(--border)]" />,
        table: ({ children }) => <table className="my-2 text-xs border-collapse">{children}</table>,
        th: ({ children }) => <th className="border border-[var(--border)] px-2 py-1 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-[var(--border)] px-2 py-1">{children}</td>,
      }}
    >
      {text}
    </Markdown>
  );
}
