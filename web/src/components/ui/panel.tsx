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
  const pad = padding === "none" ? "" : padding === "sm" ? "p-3" : "p-4 sm:p-5";
  const bg = tone === "raised" ? "bg-[var(--surface-2)]" : "bg-[var(--surface-1)]";
  return (
    <div
      className={cn(bg, "border border-[var(--border)] rounded-[var(--r-lg)] min-w-0 shadow-[0_1px_0_rgba(255,255,255,.025),0_18px_48px_rgba(0,0,0,.10)]", pad, className)}
      {...rest}
    >
      {children}
    </div>
  );
}
