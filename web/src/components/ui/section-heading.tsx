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
      className={cn("text-[var(--text)] tracking-[-0.02em] font-semibold text-xl", className)}
    >
      {children}
    </h1>
  );
}
