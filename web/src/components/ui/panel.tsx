import { cn } from "./utils";

export function Panel({
  children,
  padding = "md",
  tone = "default",
  className,
  ...rest
}: {
  children: React.ReactNode;
  padding?: "none" | "sm" | "md" | "lg";
  tone?: "default" | "raised";
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  const pad = padding === "none" ? "" : padding === "sm" ? "p-3" : padding === "lg" ? "p-6" : "p-4 sm:p-5";
  return (
    <div className={cn(tone === "raised" ? "surface-raised" : "surface", "min-w-0", pad, className)} {...rest}>
      {children}
    </div>
  );
}
