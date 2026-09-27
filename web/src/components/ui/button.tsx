import { cn } from "./utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";

// Visual rules live in globals.css (.btn-*) so hover/focus/disabled states are
// real CSS states instead of inline styles that can't express :hover.
const VARIANT_CLASS: Record<Variant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

// `active` overrides variant with the primary look — the toggle-button pattern
// nav.tsx and page.tsx each hand-rolled separately (active link/tab state).
export function Button({
  active,
  variant = "ghost",
  size = "md",
  className,
  children,
  ...rest
}: {
  active?: boolean;
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  className?: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const padding = size === "sm" ? "px-3 min-h-8 text-xs" : size === "lg" ? "px-5 min-h-11 text-[15px]" : "px-4 min-h-10 text-[13px]";
  return (
    <button
      className={cn("btn", VARIANT_CLASS[active ? "primary" : variant], padding, className)}
      {...rest}
    >
      {children}
    </button>
  );
}
