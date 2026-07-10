import { cn } from "./utils";

// A quiet page-title label — no glyph, no underline flourish, just the name.
export function SectionHeading({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h1
      className={cn("text-[var(--text-2)] tracking-wide font-semibold text-sm", className)}
      style={{ fontFamily: "var(--font-display), monospace" }}
    >
      {children}
    </h1>
  );
}
