import { cn } from "./utils";

const HEIGHT = { sm: 10, md: 14, lg: 20 } as const;
const DELAYS = [0, 0.15, 0.3, 0.45];

// The one signature element: an oscilloscope-style bar sweep used everywhere a
// model is actively computing right now — chat streaming, a training step tick,
// a hive node in flight, the nav's GPU badge while a model is resident and serving.
// One primitive instead of each surface inventing its own animate-pulse ad hoc.
export function SignalTrace({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const height = HEIGHT[size];
  return (
    <span
      className={cn("inline-flex items-end gap-[2px]", className)}
      style={{ height }}
      role="status"
      aria-label="active"
    >
      {DELAYS.map((delay, i) => (
        <span
          key={i}
          className="signal-bar block w-[2px] rounded-[1px]"
          style={{ height: "100%", background: "var(--accent-ai)", animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}
