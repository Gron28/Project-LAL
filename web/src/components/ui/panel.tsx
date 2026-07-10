import { cn } from "./utils";

export function Panel({
  children,
  padding = "md",
  tone = "default",
  className,
  ...rest
}: {
  children: React.ReactNode;
  padding?: "none" | "sm" | "md";
  tone?: "default" | "raised";
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  const pad = padding === "none" ? "" : padding === "sm" ? "p-2" : "p-4";
  const bg = tone === "raised" ? "bg-[var(--surface-2)]" : "bg-[var(--surface-1)]";
  return (
    <div
      className={cn(bg, "border border-[var(--border)] rounded-[var(--r-lg)]", pad, className)}
      {...rest}
    >
      {children}
    </div>
  );
}
