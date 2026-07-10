import { cn } from "./utils";

type Variant = "primary" | "ghost" | "danger";

const VARIANT_STYLE: Record<Variant, { bg: string; color: string }> = {
  primary: { bg: "var(--accent-ai)", color: "#05090c" },
  ghost: { bg: "transparent", color: "var(--text-2)" },
  danger: { bg: "transparent", color: "var(--accent-danger)" },
};

// `active` overrides variant with the primary look — the toggle-button pattern
// nav.tsx and page.tsx each hand-rolled separately (active link/tab state).
export function Button({
  active,
  variant = "ghost",
  size = "md",
  className,
  children,
  style,
  ...rest
}: {
  active?: boolean;
  variant?: Variant;
  size?: "sm" | "md";
  className?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v = active ? VARIANT_STYLE.primary : VARIANT_STYLE[variant];
  const padding = size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm";
  return (
    <button
      className={cn(
        "inline-flex items-center gap-2 rounded-[var(--r-md)] transition-colors",
        padding,
        className
      )}
      style={{ background: v.bg, color: v.color, fontWeight: active ? 700 : 500, ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}
