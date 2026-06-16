import { lifeStatusMeta } from "@/lib/lifeStatus";

export default function LifeStatusPill({ status }: { status: string }) {
  const meta = lifeStatusMeta(status);
  // Active gets the live neon pulse; retired stays static. Glow on every dot.
  const dotFx =
    status === "active" ? "animate-pulse shadow-[0_0_5px_currentColor]" : status === "retired" ? "" : "shadow-[0_0_5px_currentColor]";
  return (
    <span className={`flex items-center gap-1 font-mono text-xs ${meta.text}`} data-testid={`life-status-${status}`}>
      <span className={`w-2 h-2 rounded-full ${meta.dot} ${dotFx}`} />
      {meta.label}
    </span>
  );
}
